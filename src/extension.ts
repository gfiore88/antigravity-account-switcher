import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const BROWSER_PROFILE_PATH = path.join(GEMINI_DIR, 'antigravity-browser-profile');
const PROFILES_DIR = path.join(GEMINI_DIR, 'antigravity-account-switcher-profiles');

let appDataPath: string;
if (os.platform() === 'win32') {
    appDataPath = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
} else if (os.platform() === 'darwin') {
    appDataPath = path.join(os.homedir(), 'Library', 'Application Support');
} else {
    appDataPath = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}
const VSCDB_PATH = path.join(appDataPath, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

interface IdeState {
  oauthToken: string | null;
  userStatus: string | null;
}

export async function activate(context: vscode.ExtensionContext) {
  await fs.ensureDir(PROFILES_DIR);

  // --- Status Bar Item ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity.openPanel';
  statusBarItem.text = '$(sync) Account Switcher';
  statusBarItem.tooltip = 'Open Antigravity Account Switcher';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // --- Sidebar WebView Provider ---
  const provider = new AccountSwitcherViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('antigravity.accountSwitcherView', provider)
  );

  // --- Commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.openPanel', () => {
      vscode.commands.executeCommand('antigravity.accountSwitcherView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.switchAccount', async () => {
      const profiles = await getSavedProfiles();
      if (profiles.length === 0) {
        vscode.window.showInformationMessage('Nessun profilo salvato. Usa il pannello Account Switcher per salvarne uno.');
        return;
      }
      const selected = await vscode.window.showQuickPick(
        profiles.map(p => ({ label: p, description: 'Profilo salvato' })),
        { placeHolder: 'Seleziona il profilo Google a cui vuoi passare' }
      );
      if (selected) { await switchProfile(selected.label); }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.saveCurrentAccount', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Inserisci un nome per il profilo corrente (es. Personale, Lavoro, Pro 1)'
      });
      if (name) {
        await saveCurrentProfile(name);
        vscode.window.showInformationMessage(`Profilo '${name}' salvato con successo!`);
      }
    })
  );
}

// -------------------------------------------------------------------
// WebView Provider (Sidebar)
// -------------------------------------------------------------------
class AccountSwitcherViewProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };

    this._renderView();

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._renderView();
      }
    });

    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && this._view?.visible) {
        this._renderView();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'saveProfile':
          await this._handleSave(message.name);
          break;
        case 'switchProfile':
          await this._handleSwitch(message.name);
          break;
        case 'deleteProfile':
          await this._handleDelete(message.name);
          break;
        case 'requestDeleteProfile':
          vscode.window.showWarningMessage(`Vuoi davvero eliminare il profilo "${message.name}"?`, { modal: true }, 'Elimina').then(selection => {
            if (selection === 'Elimina') { this._handleDelete(message.name); }
          });
          break;
        case 'renameProfile':
          await this._handleRename(message.oldName, message.newName);
          break;
        case 'requestRenameProfile':
          vscode.window.showInputBox({
            prompt: `Nuovo nome per il profilo "${message.name}":`,
            value: message.name
          }).then(newName => {
            if (newName !== undefined && newName.trim() !== '' && newName.trim() !== message.name) {
              this._handleRename(message.name, newName.trim());
            }
          });
          break;
      }
    });
  }

  private async _renderView() {
    if (!this._view) { return; }
    
    // Show a loading spinner
    this._view.webview.html = getLoadingWebviewContent();

    // Small delay to ensure the loading screen is painted and visible to the user,
    // otherwise the sqlite query might be too fast and the IPC messages might coalesce.
    await new Promise(resolve => setTimeout(resolve, 400));

    const profiles = await getSavedProfiles();
    const loggedIn = await checkIsLoggedIn();
    this._view.webview.html = getWebviewContent(profiles, loggedIn);
  }

  private async _postProfiles() {
    if (!this._view) { return; }
    const profiles = await getSavedProfiles();
    this._view.webview.postMessage({ command: 'profiles', profiles });
  }

  private async _handleSave(name: string) {
    if (!name?.trim()) {
      this._view?.webview.postMessage({ command: 'toast', type: 'error', message: 'Il nome non può essere vuoto.' });
      return;
    }
    try {
      await saveCurrentProfile(name.trim());
      await this._postProfiles();
      this._view?.webview.postMessage({ command: 'toast', type: 'success', message: `Profilo "${name}" salvato!` });
    } catch (err: any) {
      this._view?.webview.postMessage({ command: 'toast', type: 'error', message: err.message });
    }
  }

  private async _handleSwitch(name: string) {
    try {
      this._view?.webview.postMessage({ command: 'toast', type: 'success', message: `Switching a "${name}"... L'IDE si ricaricherà.` });
      await switchProfile(name);
    } catch (err: any) {
      this._view?.webview.postMessage({ command: 'toast', type: 'error', message: err.message });
    }
  }

  private async _handleDelete(name: string) {
    try {
      await fs.remove(path.join(PROFILES_DIR, name));
      await this._postProfiles();
      this._view?.webview.postMessage({ command: 'toast', type: 'success', message: `Profilo "${name}" eliminato.` });
    } catch (err: any) {
      this._view?.webview.postMessage({ command: 'toast', type: 'error', message: err.message });
    }
  }

  private async _handleRename(oldName: string, newName: string) {
    try {
      const oldPath = path.join(PROFILES_DIR, oldName);
      const newPath = path.join(PROFILES_DIR, newName);
      if (await fs.pathExists(newPath)) {
        throw new Error('Un profilo con questo nome esiste già.');
      }
      await fs.rename(oldPath, newPath);
      await this._postProfiles();
      this._view?.webview.postMessage({ command: 'toast', type: 'success', message: `Profilo rinominato in "${newName}".` });
    } catch (err: any) {
      this._view?.webview.postMessage({ command: 'toast', type: 'error', message: err.message });
    }
  }
}

// -------------------------------------------------------------------
// Shared SQLite / FS helpers
// -------------------------------------------------------------------

async function getSqliteValue(key: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`sqlite3 "${VSCDB_PATH}" "SELECT value FROM ItemTable WHERE key='${key}';"`);
    return stdout.trim() || null;
  } catch (err) {
    console.error(`Error reading ${key} from SQLite:`, err);
    return null;
  }
}

async function checkIsLoggedIn(): Promise<boolean> {
  const oauthToken = await getSqliteValue('antigravityUnifiedStateSync.oauthToken');
  if (oauthToken) {
    try {
      const decoded = Buffer.from(oauthToken, 'base64').toString('utf8');
      if (decoded.includes('"state":"signedIn"')) return true;
    } catch (e) {}
  }
  
  const userStatus = await getSqliteValue('antigravityUnifiedStateSync.userStatus');
  if (userStatus) {
    try {
      const decoded = Buffer.from(userStatus, 'base64').toString('utf8');
      if (decoded.includes('"state":"signedIn"')) return true;
    } catch (e) {}
  }
  
  return false;
}

async function getSavedProfiles(): Promise<string[]> {
  await fs.ensureDir(PROFILES_DIR);
  const items = await fs.readdir(PROFILES_DIR);
  const profiles: string[] = [];
  for (const item of items) {
    if (item.startsWith('_')) { continue; }
    const stat = await fs.stat(path.join(PROFILES_DIR, item));
    if (stat.isDirectory()) { profiles.push(item); }
  }
  return profiles;
}

async function saveCurrentProfile(name: string) {
  const targetPath = path.join(PROFILES_DIR, name);
  await fs.ensureDir(targetPath);

  if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
    await fs.copy(BROWSER_PROFILE_PATH, targetPath);
  }

  const oauthToken = await getSqliteValue('antigravityUnifiedStateSync.oauthToken');
  const userStatus = await getSqliteValue('antigravityUnifiedStateSync.userStatus');
  
  const loggedIn = await checkIsLoggedIn();
  if (!loggedIn) {
    throw new Error("Nessuna sessione Google attiva trovata nell'IDE. Fai prima il login.");
  }

  const state: IdeState = { oauthToken, userStatus };
  await fs.writeJson(path.join(targetPath, 'ide_state.json'), state, { spaces: 2 });
}

async function switchProfile(name: string) {
  const targetPath = path.join(PROFILES_DIR, name);
  if (!await fs.pathExists(targetPath)) { throw new Error('Il profilo selezionato non esiste.'); }
  
  const statePath = path.join(targetPath, 'ide_state.json');

  const tempBackup = path.join(PROFILES_DIR, '_backup_temp');
  if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
    if (await fs.pathExists(tempBackup)) { await fs.remove(tempBackup); }
    await fs.move(BROWSER_PROFILE_PATH, tempBackup);
  }
  await fs.copy(targetPath, BROWSER_PROFILE_PATH);

  const scriptContent = `
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const vscdbPath = process.argv[2];
const ideStatePath = process.argv[3];
const appPath = process.argv[4];

const isMac = os.platform() === 'darwin';
const isWin = os.platform() === 'win32';

try {
    if (isMac) {
        execSync('osascript -e \\'tell application "Antigravity IDE" to quit\\'');
    } else if (isWin) {
        execSync('taskkill /IM "Antigravity IDE.exe"');
    } else {
        execSync('pkill -f "Antigravity IDE"');
    }
} catch(e) {}

let attempts = 0;
while (attempts < 20) {
    try {
        let isRunning = false;
        if (isMac) {
            const res = execSync('osascript -e \\'application "Antigravity IDE" is running\\'').toString().trim();
            isRunning = (res === 'true');
        } else if (isWin) {
            const res = execSync('tasklist /FI "IMAGENAME eq Antigravity IDE.exe"').toString();
            isRunning = res.includes('Antigravity IDE.exe');
        } else {
            try {
                execSync('pgrep -f "Antigravity IDE"');
                isRunning = true;
            } catch(e) {
                isRunning = false;
            }
        }
        if (!isRunning) {
            break;
        }
        if (isWin) {
            try { execSync('timeout /t 1 /nobreak > NUL'); } catch(e) {}
        } else {
            execSync('sleep 0.5');
        }
        attempts++;
    } catch(e) {
        break; 
    }
}

try {
    if (isMac) {
        const res = execSync('osascript -e \\'application "Antigravity IDE" is running\\'').toString().trim();
        if (res === 'true') {
            execSync('pkill -9 -f "Antigravity IDE.app"');
        }
    } else if (isWin) {
        execSync('taskkill /IM "Antigravity IDE.exe" /F');
    } else {
        execSync('pkill -9 -f "Antigravity IDE"');
    }
} catch(e) {}

if (isWin) {
    try { execSync('timeout /t 1 /nobreak > NUL'); } catch(e) {}
} else {
    try { execSync('sleep 0.8'); } catch(e) {}
}

if (fs.existsSync(ideStatePath)) {
    const state = JSON.parse(fs.readFileSync(ideStatePath, 'utf8'));
    function setSqlite(key, val) {
        const escaped = val.replace(/'/g, "''");
        try {
            const count = execSync(\`sqlite3 "\${vscdbPath}" "SELECT count(*) FROM ItemTable WHERE key='\${key}';"\`).toString().trim();
            if (count === '0') {
                execSync(\`sqlite3 "\${vscdbPath}" "INSERT INTO ItemTable (key, value) VALUES ('\${key}', '\${escaped}');"\`);
            } else {
                execSync(\`sqlite3 "\${vscdbPath}" "UPDATE ItemTable SET value='\${escaped}' WHERE key='\${key}';"\`);
            }
        } catch(e) {}
    }

    if (state.oauthToken) setSqlite('antigravityUnifiedStateSync.oauthToken', state.oauthToken);
    if (state.userStatus) setSqlite('antigravityUnifiedStateSync.userStatus', state.userStatus);
}

// Clean environment variables before restarting to prevent Launch Services issues
for (const key in process.env) {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') {
        delete process.env[key];
    }
}

try {
    if (isMac && appPath === "Antigravity IDE") {
        execSync('open -n -a "Antigravity IDE"');
    } else {
        const { spawn } = require('child_process');
        const child = spawn(appPath, [], {
            detached: true,
            stdio: 'ignore'
        });
        child.unref();
    }
} catch(e) {}
  `;

  const scriptPath = path.join(PROFILES_DIR, 'switcher.js');
  await fs.writeFile(scriptPath, scriptContent);

  const { spawn } = require('child_process');
  const child = spawn('node', [scriptPath, VSCDB_PATH, statePath, process.execPath || 'Antigravity IDE'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 500);
}

// -------------------------------------------------------------------
// WebView HTML
// -------------------------------------------------------------------
function getWebviewContent(profiles: string[], isLoggedIn: boolean): string {
  const profilesJson = JSON.stringify(profiles);
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Account Switcher</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --radius-sm: 4px;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
    }
    .header {
      display: flex; align-items: center; gap: 8px;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header h1 { font-size: 14px; font-weight: 600; margin: 0; }
    .header p { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 2px 0 0 0; }
    .section-label {
      font-size: 11px; font-weight: 600; text-transform: uppercase;
      color: var(--vscode-sideBarTitle-foreground);
      margin-bottom: 8px;
    }
    .add-card { margin-bottom: 20px; }
    .input-field {
      width: 100%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
      color: var(--vscode-input-foreground);
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      outline: none;
      margin-bottom: 8px;
      font-family: inherit;
    }
    .input-field:focus { border-color: var(--vscode-focusBorder); }
    .btn {
      width: 100%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-family: inherit;
      font-size: 12px;
    }
    .btn:hover { background: var(--vscode-button-hoverBackground); }
    .profiles-list { display: flex; flex-direction: column; gap: 6px; }
    .empty-state {
      text-align: center; padding: 20px;
      color: var(--vscode-descriptionForeground);
      border: 1px dashed var(--vscode-panel-border);
      border-radius: var(--radius-sm);
      font-size: 12px;
    }
    .profile-card {
      display: flex; align-items: center; gap: 10px;
      background: var(--vscode-list-inactiveSelectionBackground);
      border: 1px solid transparent;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      transition: background 0.1s;
    }
    .profile-card:hover { background: var(--vscode-list-hoverBackground); }
    .profile-avatar {
      width: 28px; height: 28px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 600; font-size: 11px; color: #fff;
      flex-shrink: 0;
    }
    .profile-info { flex: 1; min-width: 0; }
    .profile-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .profile-sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
    .profile-actions { display: flex; gap: 4px; }
    .btn-icon {
      background: transparent;
      color: var(--vscode-icon-foreground);
      border: 1px solid transparent;
      border-radius: 4px;
      padding: 4px 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    .toast-container {
      position: fixed; bottom: 12px; left: 12px; right: 12px;
      display: flex; flex-direction: column; gap: 6px;
      z-index: 9999;
    }
    .toast {
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      font-size: 12px;
      background: var(--vscode-notifications-background);
      color: var(--vscode-notifications-foreground);
      border: 1px solid var(--vscode-notifications-border);
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      animation: toastIn 0.2s ease, toastOut 0.2s ease 2.8s forwards;
    }
    .toast.success { border-left: 3px solid var(--vscode-notificationsInfoIcon-foreground); }
    .toast.error { border-left: 3px solid var(--vscode-notificationsErrorIcon-foreground); }
    @keyframes toastIn  { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
    @keyframes toastOut { from { opacity:1; } to { opacity:0; } }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>Account Switcher</h1>
      <p>Antigravity IDE</p>
    </div>
  </div>

  <div class="section-label">Salva sessione corrente</div>
  
  <div id="saveFormContainer" style="display: ${isLoggedIn ? 'block' : 'none'};">
    <div class="add-card">
      <input class="input-field" id="profileNameInput" type="text" placeholder="Nome profilo" maxlength="40"/>
      <button class="btn" id="saveBtn">Salva Profilo</button>
    </div>
  </div>
  
  <div id="loginWarningContainer" style="display: ${isLoggedIn ? 'none' : 'block'};">
    <div class="add-card" style="padding: 10px; background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: var(--radius-sm); margin-bottom: 20px;">
      <p style="font-size: 11px; color: var(--vscode-foreground); margin: 0; line-height: 1.4;">
        ⚠️ Effettua prima il login con Google in Antigravity IDE per poter salvare il profilo.
      </p>
    </div>
  </div>

  <div class="section-label">Profili Salvati</div>
  <div class="profiles-list" id="profilesList"></div>
  <div class="toast-container" id="toastContainer"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const COLORS = ['#4d78cc', '#6b5b95', '#b565a7', '#009688', '#e91e63', '#ff9800'];
    function getColor(name) {
      let h = 0; for (let i=0;i<name.length;i++){h=name.charCodeAt(i)+((h<<5)-h);}
      return COLORS[Math.abs(h)%COLORS.length];
    }
    function getInitials(name){return name.split(/\\s+/).map(w=>w[0]).join('').toUpperCase().slice(0,2);}
    function esc(str){return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
    function escJs(str){return str.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\\'");}

    function renderProfiles(profiles) {
      const list = document.getElementById('profilesList');
      if (!profiles || profiles.length === 0) {
        list.innerHTML = \`<div class="empty-state">Nessun profilo salvato.</div>\`;
        return;
      }
      list.innerHTML = profiles.map(name => \`
        <div class="profile-card">
          <div class="profile-avatar" style="background:\${getColor(name)}">\${getInitials(name)}</div>
          <div class="profile-info">
            <div class="profile-name">\${esc(name)}</div>
            <div class="profile-sub">Profilo Google</div>
          </div>
          <div class="profile-actions">
            <button class="btn-icon" title="Switch" onclick="switchProfile('\${escJs(name)}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12c0-4.4 3.6-8 8-8 2.2 0 4.2.9 5.7 2.3L20 9"/><path d="M15 9h5V4"/><path d="M20 12c0 4.4-3.6 8-8 8-2.2 0-4.2-.9-5.7-2.3L4 15"/><path d="M9 15H4v5"/></svg>
            </button>
            <button class="btn-icon" title="Rinomina" onclick="promptRenameProfile('\${escJs(name)}')">✏️</button>
            <button class="btn-icon" title="Elimina" onclick="promptDeleteProfile('\${escJs(name)}')">🗑</button>
          </div>
        </div>\`).join('');
    }

    function showToast(type, message) {
      const c = document.getElementById('toastContainer');
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.innerHTML = esc(message);
      c.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }

    const saveBtn = document.getElementById('saveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const input = document.getElementById('profileNameInput');
        const name = input.value.trim();
        if (!name) { showToast('error','Nome vuoto.'); input.focus(); return; }
        vscode.postMessage({command:'saveProfile', name});
        input.value = '';
      });
      document.getElementById('profileNameInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') saveBtn.click();
      });
    }
    
    function switchProfile(name){ vscode.postMessage({command:'switchProfile', name}); }
    
    function promptDeleteProfile(name) {
      vscode.postMessage({command:'requestDeleteProfile', name});
    }

    function promptRenameProfile(name) {
      vscode.postMessage({command:'requestRenameProfile', name});
    }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'profiles') renderProfiles(msg.profiles);
      if (msg.command === 'toast') showToast(msg.type, msg.message);
      if (msg.command === 'updateAuthStatus') {
        const saveForm = document.getElementById('saveFormContainer');
        const loginWarning = document.getElementById('loginWarningContainer');
        if (msg.isLoggedIn) {
          saveForm.style.display = 'block';
          loginWarning.style.display = 'none';
        } else {
          saveForm.style.display = 'none';
          loginWarning.style.display = 'block';
        }
      }
    });

    renderProfiles(${profilesJson});
  </script>
</body>
</html>`;
}

function getLoadingWebviewContent(): string {
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Account Switcher</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }
    .spinner {
      width: 24px;
      height: 24px;
      border: 3px solid var(--vscode-panel-border);
      border-top: 3px solid var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 12px;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .loading-text {
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="spinner"></div>
  <div class="loading-text">Caricamento stato...</div>
</body>
</html>`;
}

export function deactivate() {}
