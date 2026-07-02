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
const VSCDB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

interface IdeState {
  oauthToken: string | null;
  userStatus: string | null;
}

export async function activate(context: vscode.ExtensionContext) {
  await fs.ensureDir(PROFILES_DIR);

  // --- Status Bar Item ---
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'antigravity.openPanel';
  statusBarItem.text = '$(account) Account Switcher';
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
      }
    });
  }

  private async _renderView() {
    if (!this._view) { return; }
    const profiles = await getSavedProfiles();
    this._view.webview.html = getWebviewContent(profiles);
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
  
  if (!oauthToken && !userStatus) {
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
const vscdbPath = process.argv[2];
const ideStatePath = process.argv[3];
const appPath = process.argv[4];

let attempts = 0;
while (attempts < 20) {
    try {
        execSync('pgrep -x "Antigravity IDE"');
        execSync('sleep 0.5');
        attempts++;
    } catch(e) {
        break; 
    }
}

execSync('sleep 0.8'); // Extra safety buffer

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

execSync(\`open -a "\${appPath}"\`);
  `;

  const scriptPath = path.join(PROFILES_DIR, 'switcher.js');
  await fs.writeFile(scriptPath, scriptContent);

  const { spawn } = require('child_process');
  const child = spawn('node', [scriptPath, VSCDB_PATH, statePath, 'Antigravity IDE'], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();

  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 500);
}

// -------------------------------------------------------------------
// WebView HTML
// -------------------------------------------------------------------
function getWebviewContent(profiles: string[]): string {
  const profilesJson = JSON.stringify(profiles);
  return `<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Account Switcher</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-base: #0d0d18;
      --bg-surface: rgba(255,255,255,0.04);
      --bg-surface-hover: rgba(255,255,255,0.07);
      --border: rgba(255,255,255,0.07);
      --border-accent: rgba(139,92,246,0.45);
      --accent: #8b5cf6;
      --accent-2: #6366f1;
      --accent-glow: rgba(139,92,246,0.25);
      --danger: #ef4444;
      --danger-glow: rgba(239,68,68,0.2);
      --success: #22c55e;
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #4a5568;
      --radius: 10px;
      --radius-sm: 6px;
    }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      min-height: 100vh;
      padding: 16px;
      background-image:
        radial-gradient(ellipse at 15% 0%, rgba(139,92,246,0.10) 0%, transparent 55%),
        radial-gradient(ellipse at 85% 100%, rgba(99,102,241,0.08) 0%, transparent 55%);
      font-size: 13px;
    }

    /* Header */
    .header {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 14px;
      border-bottom: 1px solid var(--border);
    }
    .header-icon {
      width: 32px; height: 32px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 15px;
      box-shadow: 0 0 14px var(--accent-glow);
      flex-shrink: 0;
    }
    .header-text h1 {
      font-size: 14px; font-weight: 700; letter-spacing: -0.2px;
      background: linear-gradient(90deg, #fff 40%, #c4b5fd);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .header-text p {
      font-size: 11px; color: var(--text-muted); margin-top: 1px;
    }

    /* Section label */
    .section-label {
      font-size: 10px; font-weight: 600; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--text-muted);
      margin-bottom: 8px;
    }

    /* Add card */
    .add-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 12px;
      margin-bottom: 20px;
      transition: border-color 0.2s;
    }
    .add-card:focus-within { border-color: var(--border-accent); }

    .input-field {
      width: 100%;
      background: rgba(255,255,255,0.04);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 8px 11px;
      color: var(--text-primary);
      font-family: 'Inter', sans-serif;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      margin-bottom: 8px;
    }
    .input-field::placeholder { color: var(--text-muted); }
    .input-field:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 2px var(--accent-glow);
    }

    .btn {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      padding: 8px 14px;
      border: none; border-radius: var(--radius-sm);
      font-family: 'Inter', sans-serif;
      font-size: 12px; font-weight: 600;
      cursor: pointer;
      transition: all 0.18s ease;
      width: 100%;
    }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #fff;
      box-shadow: 0 3px 12px var(--accent-glow);
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 5px 16px var(--accent-glow);
    }
    .btn-primary:active { transform: translateY(0); }

    /* Profile cards */
    .profiles-list {
      display: flex; flex-direction: column; gap: 8px;
    }
    .empty-state {
      text-align: center; padding: 32px 16px;
      background: var(--bg-surface);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
    }
    .empty-state .emoji { font-size: 28px; margin-bottom: 10px; display: block; }
    .empty-state p { color: var(--text-muted); font-size: 12px; line-height: 1.6; }

    .profile-card {
      display: flex; align-items: center; gap: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
      transition: border-color 0.2s, background 0.2s, transform 0.18s;
      animation: slideIn 0.25s ease backwards;
    }
    .profile-card:hover {
      border-color: rgba(139,92,246,0.28);
      background: var(--bg-surface-hover);
      transform: translateX(2px);
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .profile-avatar {
      width: 32px; height: 32px;
      border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 12px; color: #fff;
      flex-shrink: 0;
    }
    .profile-info { flex: 1; min-width: 0; }
    .profile-name {
      font-size: 13px; font-weight: 600;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .profile-sub { font-size: 10px; color: var(--text-muted); margin-top: 1px; }

    .profile-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .btn-icon {
      width: 28px; height: 28px;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: var(--radius-sm);
      cursor: pointer; font-size: 13px;
      transition: all 0.15s;
    }
    .btn-switch-sm {
      background: rgba(139,92,246,0.12);
      color: var(--accent);
      border: 1px solid rgba(139,92,246,0.2);
    }
    .btn-switch-sm:hover {
      background: rgba(139,92,246,0.22);
      border-color: var(--accent);
    }
    .btn-delete-sm {
      background: transparent;
      color: var(--text-muted);
      border: 1px solid transparent;
    }
    .btn-delete-sm:hover {
      background: var(--danger-glow);
      color: var(--danger);
      border-color: rgba(239,68,68,0.3);
    }

    /* Toast */
    .toast-container {
      position: fixed; bottom: 12px; left: 12px; right: 12px;
      display: flex; flex-direction: column; gap: 6px;
      z-index: 9999;
    }
    .toast {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 12px; font-weight: 500;
      backdrop-filter: blur(16px);
      animation: toastIn 0.25s ease, toastOut 0.25s ease 2.75s forwards;
      box-shadow: 0 6px 24px rgba(0,0,0,0.4);
    }
    .toast.success {
      background: rgba(22,163,74,0.18);
      border: 1px solid rgba(34,197,94,0.35);
      color: #86efac;
    }
    .toast.error {
      background: rgba(185,28,28,0.18);
      border: 1px solid rgba(239,68,68,0.35);
      color: #fca5a5;
    }
    @keyframes toastIn  { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
    @keyframes toastOut { from { opacity:1; } to { opacity:0; } }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-icon">⚡</div>
    <div class="header-text">
      <h1>Account Switcher</h1>
      <p>Antigravity IDE</p>
    </div>
  </div>

  <div class="section-label">Salva sessione corrente</div>
  <div class="add-card">
    <input class="input-field" id="profileNameInput" type="text"
      placeholder="Nome profilo (es. Pro, Lavoro...)" maxlength="40"/>
    <button class="btn btn-primary" id="saveBtn">💾 Salva Account Corrente</button>
  </div>

  <div class="section-label">Profili Salvati</div>
  <div class="profiles-list" id="profilesList"></div>

  <div class="toast-container" id="toastContainer"></div>

  <script>
    const vscode = acquireVsCodeApi();
    const COLORS = [
      'linear-gradient(135deg,#8b5cf6,#6366f1)',
      'linear-gradient(135deg,#06b6d4,#3b82f6)',
      'linear-gradient(135deg,#f59e0b,#ef4444)',
      'linear-gradient(135deg,#10b981,#06b6d4)',
      'linear-gradient(135deg,#ec4899,#8b5cf6)',
      'linear-gradient(135deg,#f97316,#eab308)',
    ];
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
        list.innerHTML = \`<div class="empty-state">
          <span class="emoji">🌐</span>
          <p>Nessun profilo salvato.<br/>Fai login nell'IDE, poi<br/>salva la sessione qui sopra.</p>
        </div>\`;
        return;
      }
      list.innerHTML = profiles.map((name,i) => \`
        <div class="profile-card" style="animation-delay:\${i*0.04}s">
          <div class="profile-avatar" style="background:\${getColor(name)}">\${getInitials(name)}</div>
          <div class="profile-info">
            <div class="profile-name">\${esc(name)}</div>
            <div class="profile-sub">Profilo Google salvato</div>
          </div>
          <div class="profile-actions">
            <button class="btn-icon btn-switch-sm" title="Switch a questo account" onclick="switchProfile('\${escJs(name)}')">⚡</button>
            <button class="btn-icon btn-delete-sm" title="Elimina profilo" onclick="deleteProfile('\${escJs(name)}')">🗑</button>
          </div>
        </div>\`).join('');
    }

    function showToast(type, message) {
      const c = document.getElementById('toastContainer');
      const t = document.createElement('div');
      t.className = 'toast ' + type;
      t.innerHTML = (type==='success'?'✅':'❌') + ' ' + esc(message);
      c.appendChild(t);
      setTimeout(() => t.remove(), 3100);
    }

    document.getElementById('saveBtn').addEventListener('click', () => {
      const input = document.getElementById('profileNameInput');
      const name = input.value.trim();
      if (!name) { showToast('error','Inserisci un nome per il profilo.'); input.focus(); return; }
      vscode.postMessage({command:'saveProfile', name});
      input.value = '';
    });
    document.getElementById('profileNameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('saveBtn').click();
    });
    function switchProfile(name){ vscode.postMessage({command:'switchProfile', name}); }
    function deleteProfile(name){ vscode.postMessage({command:'deleteProfile', name}); }

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.command === 'profiles') renderProfiles(msg.profiles);
      if (msg.command === 'toast') showToast(msg.type, msg.message);
    });

    renderProfiles(${profilesJson});
  </script>
</body>
</html>`;
}

export function deactivate() {}
