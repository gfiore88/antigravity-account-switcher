import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs-extra';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const BROWSER_PROFILE_PATH = path.join(GEMINI_DIR, 'antigravity-browser-profile');
const PROFILES_DIR = path.join(GEMINI_DIR, 'antigravity-account-switcher-profiles');
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const PROFILE_NAME_MAX_LENGTH = 40;
const INTERNAL_PREFIX = '_';
const SQLITE_OAUTH_TOKEN_KEY = 'antigravityUnifiedStateSync.oauthToken';
const SQLITE_USER_STATUS_KEY = 'antigravityUnifiedStateSync.userStatus';
let sqliteAvailabilityCheck: Promise<void> | undefined;

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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeProfileName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Nome profilo non valido.');
  }

  const name = value.trim();
  if (!name) {
    throw new Error('Il nome non può essere vuoto.');
  }
  if (name.length > PROFILE_NAME_MAX_LENGTH) {
    throw new Error(`Il nome non può superare ${PROFILE_NAME_MAX_LENGTH} caratteri.`);
  }
  if (name === '.' || name === '..' || name.startsWith(INTERNAL_PREFIX)) {
    throw new Error('Nome profilo riservato.');
  }
  if (/[\\/]/.test(name) || /[\x00-\x1f]/.test(name)) {
    throw new Error('Il nome profilo non può contenere separatori di percorso o caratteri di controllo.');
  }
  if (os.platform() === 'win32') {
    const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
    if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name) || windowsReserved.test(name)) {
      throw new Error('Nome profilo non valido su Windows.');
    }
  }

  return name;
}

function getProfilePath(value: unknown): { name: string; profilePath: string } {
  const name = normalizeProfileName(value);
  const root = path.resolve(PROFILES_DIR);
  const profilePath = path.resolve(root, name);
  const relative = path.relative(root, profilePath);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Percorso profilo non valido.');
  }

  return { name, profilePath };
}

function getInternalPath(prefix: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(PROFILES_DIR, `${INTERNAL_PREFIX}${prefix}-${suffix}`);
}

async function chmodIfSupported(targetPath: string, mode: number) {
  if (os.platform() === 'win32') {
    return;
  }

  try {
    await fs.chmod(targetPath, mode);
  } catch (err) {
    console.warn(`Unable to chmod ${targetPath}:`, err);
  }
}

async function ensureSecureDir(dirPath: string) {
  await fs.ensureDir(dirPath);
  await chmodIfSupported(dirPath, SECURE_DIR_MODE);
}

async function writeSecureJson(filePath: string, data: unknown) {
  await fs.writeJson(filePath, data, { spaces: 2, mode: SECURE_FILE_MODE });
  await chmodIfSupported(filePath, SECURE_FILE_MODE);
}

async function hardenProfileDirectory(profilePath: string) {
  if (await fs.pathExists(profilePath)) {
    await chmodIfSupported(profilePath, SECURE_DIR_MODE);
  }

  const statePath = path.join(profilePath, 'ide_state.json');
  if (await fs.pathExists(statePath)) {
    await chmodIfSupported(statePath, SECURE_FILE_MODE);
  }
}

async function hardenExistingProfileStorage() {
  await ensureSecureDir(PROFILES_DIR);
  if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
    await chmodIfSupported(BROWSER_PROFILE_PATH, SECURE_DIR_MODE);
  }

  const items = await fs.readdir(PROFILES_DIR);
  for (const item of items) {
    try {
      const itemPath = path.join(PROFILES_DIR, item);
      const stat = await fs.lstat(itemPath);
      if (stat.isDirectory()) {
        await hardenProfileDirectory(itemPath);
      } else if (item === 'switcher.js') {
        await chmodIfSupported(itemPath, SECURE_FILE_MODE);
      }
    } catch (err) {
      console.warn(`Unable to harden profile storage item "${item}":`, err);
    }
  }
}

function escapeSqlValue(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureSqliteAvailable() {
  if (!sqliteAvailabilityCheck) {
    sqliteAvailabilityCheck = execFileAsync('sqlite3', ['--version'])
      .then(() => undefined)
      .catch((err) => {
        sqliteAvailabilityCheck = undefined;
        throw new Error(`sqlite3 non è disponibile nel PATH. Installa sqlite3 o aggiungilo al PATH prima di usare Account Switcher. Dettaglio: ${errorMessage(err)}`);
      });
  }

  await sqliteAvailabilityCheck;
}

export async function activate(context: vscode.ExtensionContext) {
  await hardenExistingProfileStorage();

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
      try {
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
      } catch (err) {
        vscode.window.showErrorMessage(errorMessage(err));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('antigravity.saveCurrentAccount', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Inserisci un nome per il profilo corrente (es. Personale, Lavoro, Pro 1)'
      });
      if (name) {
        try {
          const savedName = await saveCurrentProfile(name);
          vscode.window.showInformationMessage(`Profilo '${savedName}' salvato con successo!`);
        } catch (err) {
          vscode.window.showErrorMessage(errorMessage(err));
        }
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

  private _postToast(type: 'success' | 'error', message: string) {
    this._view?.webview.postMessage({ command: 'toast', type, message });
  }

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
          await this._requestDelete(message.name);
          break;
        case 'renameProfile':
          await this._handleRename(message.oldName, message.newName);
          break;
        case 'requestRenameProfile':
          await this._requestRename(message.name);
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
    try {
      const savedName = await saveCurrentProfile(name);
      await this._postProfiles();
      this._postToast('success', `Profilo "${savedName}" salvato!`);
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }

  private async _handleSwitch(name: string) {
    try {
      const profileName = normalizeProfileName(name);
      this._postToast('success', `Switching a "${profileName}"... L'IDE si ricaricherà.`);
      await switchProfile(name);
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }

  private async _handleDelete(name: string) {
    try {
      const { name: profileName, profilePath } = getProfilePath(name);
      await fs.remove(profilePath);
      await this._postProfiles();
      this._postToast('success', `Profilo "${profileName}" eliminato.`);
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }

  private async _handleRename(oldName: string, newName: string) {
    try {
      const { name: safeOldName, profilePath: oldPath } = getProfilePath(oldName);
      const { name: safeNewName, profilePath: newPath } = getProfilePath(newName);
      if (safeOldName === safeNewName) {
        return;
      }
      if (!await fs.pathExists(oldPath)) {
        throw new Error('Il profilo selezionato non esiste.');
      }
      if (await fs.pathExists(newPath)) {
        throw new Error('Un profilo con questo nome esiste già.');
      }
      await fs.rename(oldPath, newPath);
      await hardenProfileDirectory(newPath);
      await this._postProfiles();
      this._postToast('success', `Profilo rinominato in "${safeNewName}".`);
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }

  private async _requestDelete(name: string) {
    try {
      const profileName = normalizeProfileName(name);
      const selection = await vscode.window.showWarningMessage(
        `Vuoi davvero eliminare il profilo "${profileName}"?`,
        { modal: true },
        'Elimina'
      );
      if (selection === 'Elimina') {
        await this._handleDelete(profileName);
      }
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }

  private async _requestRename(name: string) {
    try {
      const profileName = normalizeProfileName(name);
      const newName = await vscode.window.showInputBox({
        prompt: `Nuovo nome per il profilo "${profileName}":`,
        value: profileName
      });
      if (newName !== undefined && newName.trim() !== '' && newName.trim() !== profileName) {
        await this._handleRename(profileName, newName);
      }
    } catch (err) {
      this._postToast('error', errorMessage(err));
    }
  }
}

// -------------------------------------------------------------------
// Shared SQLite / FS helpers
// -------------------------------------------------------------------

async function getSqliteValue(key: string): Promise<string | null> {
  try {
    const query = `SELECT value FROM ItemTable WHERE key='${escapeSqlValue(key)}';`;
    const { stdout } = await execFileAsync('sqlite3', [VSCDB_PATH, query]);
    return stdout.trim() || null;
  } catch (err) {
    console.error(`Error reading ${key} from SQLite:`, err);
    return null;
  }
}

async function checkIsLoggedIn(): Promise<boolean> {
  return isSignedInState(await getCurrentIdeState());
}

async function getSavedProfiles(): Promise<string[]> {
  await ensureSecureDir(PROFILES_DIR);
  const items = await fs.readdir(PROFILES_DIR);
  const profiles: string[] = [];
  for (const item of items) {
    if (item.startsWith('_')) { continue; }
    try {
      const { name, profilePath } = getProfilePath(item);
      const stat = await fs.stat(profilePath);
      if (stat.isDirectory()) { profiles.push(name); }
    } catch (err) {
      console.warn(`Skipping invalid profile entry "${item}":`, err);
    }
  }
  return profiles.sort((a, b) => a.localeCompare(b));
}

async function getCurrentIdeState(): Promise<IdeState> {
  const oauthToken = await getSqliteValue(SQLITE_OAUTH_TOKEN_KEY);
  const userStatus = await getSqliteValue(SQLITE_USER_STATUS_KEY);
  return { oauthToken, userStatus };
}

function isSignedInState(state: IdeState): boolean {
  for (const value of [state.oauthToken, state.userStatus]) {
    if (!value) { continue; }
    try {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (decoded.includes('"state":"signedIn"')) {
        return true;
      }
    } catch (err) {
      console.warn('Unable to decode Antigravity auth state:', err);
    }
  }

  return false;
}

async function moveWithRollback(source: string, destination: string, rollbackPath: string) {
  let movedExisting = false;

  try {
    if (await fs.pathExists(rollbackPath)) {
      await fs.remove(rollbackPath);
    }
    if (await fs.pathExists(destination)) {
      await fs.move(destination, rollbackPath);
      movedExisting = true;
    }
    await fs.move(source, destination);
    if (movedExisting) {
      await fs.remove(rollbackPath);
    }
  } catch (err) {
    if (!await fs.pathExists(destination) && movedExisting && await fs.pathExists(rollbackPath)) {
      await fs.move(rollbackPath, destination);
    }
    throw err;
  } finally {
    if (await fs.pathExists(source)) {
      await fs.remove(source);
    }
    if (await fs.pathExists(rollbackPath)) {
      await fs.remove(rollbackPath);
    }
  }
}

async function saveCurrentProfile(name: string): Promise<string> {
  const { name: profileName, profilePath: targetPath } = getProfilePath(name);
  await ensureSqliteAvailable();
  const state = await getCurrentIdeState();

  if (!isSignedInState(state)) {
    throw new Error("Nessuna sessione Google attiva trovata nell'IDE. Fai prima il login.");
  }

  await ensureSecureDir(PROFILES_DIR);
  const stagingPath = getInternalPath('save');
  const rollbackPath = getInternalPath('rollback');

  try {
    await ensureSecureDir(stagingPath);
    if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
      await fs.copy(BROWSER_PROFILE_PATH, stagingPath);
    }
    await writeSecureJson(path.join(stagingPath, 'ide_state.json'), state);
    await hardenProfileDirectory(stagingPath);
    await moveWithRollback(stagingPath, targetPath, rollbackPath);
    await hardenProfileDirectory(targetPath);
    return profileName;
  } finally {
    if (await fs.pathExists(stagingPath)) {
      await fs.remove(stagingPath);
    }
    if (await fs.pathExists(rollbackPath)) {
      await fs.remove(rollbackPath);
    }
  }
}

async function switchProfile(name: string) {
  const { profilePath: targetPath } = getProfilePath(name);
  await ensureSqliteAvailable();
  if (!await fs.pathExists(targetPath)) { throw new Error('Il profilo selezionato non esiste.'); }
  const targetStat = await fs.stat(targetPath);
  if (!targetStat.isDirectory()) { throw new Error('Il profilo selezionato non è valido.'); }
  
  const statePath = path.join(targetPath, 'ide_state.json');
  if (!await fs.pathExists(statePath)) {
    throw new Error('Il profilo selezionato non contiene lo stato di autenticazione.');
  }

  const tempBackup = path.join(PROFILES_DIR, '_backup_temp');
  if (await fs.pathExists(tempBackup)) { await fs.remove(tempBackup); }

  try {
    if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
      await fs.move(BROWSER_PROFILE_PATH, tempBackup);
    }
    await fs.copy(targetPath, BROWSER_PROFILE_PATH);
    await chmodIfSupported(BROWSER_PROFILE_PATH, SECURE_DIR_MODE);
  } catch (err) {
    if (await fs.pathExists(BROWSER_PROFILE_PATH)) {
      await fs.remove(BROWSER_PROFILE_PATH);
    }
    if (await fs.pathExists(tempBackup)) {
      await fs.move(tempBackup, BROWSER_PROFILE_PATH);
    }
    throw err;
  }

  const scriptContent = `
const { execFileSync, execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const vscdbPath = process.argv[2];
const ideStatePath = process.argv[3];
const activeProfilePath = process.argv[4];
const backupPath = process.argv[5];
const appPath = process.argv[6];

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

function sqlString(value) {
    return "'" + String(value).replace(/'/g, "''") + "'";
}

function restoreBrowserProfile() {
    if (!backupPath || !fs.existsSync(backupPath)) {
        return;
    }
    try {
        if (fs.existsSync(activeProfilePath)) {
            fs.rmSync(activeProfilePath, { recursive: true, force: true });
        }
        fs.renameSync(backupPath, activeProfilePath);
    } catch(e) {}
}

function cleanupBackup() {
    if (backupPath && fs.existsSync(backupPath)) {
        try { fs.rmSync(backupPath, { recursive: true, force: true }); } catch(e) {}
    }
}

try {
    if (!fs.existsSync(ideStatePath)) {
        throw new Error('Missing ide_state.json');
    }

    const state = JSON.parse(fs.readFileSync(ideStatePath, 'utf8'));
    const pairs = [
        ['${SQLITE_OAUTH_TOKEN_KEY}', state.oauthToken],
        ['${SQLITE_USER_STATUS_KEY}', state.userStatus]
    ];
    const statements = ['BEGIN IMMEDIATE;'];
    for (const [key, value] of pairs) {
        statements.push(\`DELETE FROM ItemTable WHERE key=\${sqlString(key)};\`);
        if (value !== null && value !== undefined) {
            statements.push(\`INSERT INTO ItemTable (key, value) VALUES (\${sqlString(key)}, \${sqlString(value)});\`);
        }
    }
    statements.push('COMMIT;');
    execFileSync('sqlite3', [vscdbPath, statements.join('\\n')], { stdio: 'ignore' });
    cleanupBackup();
} catch(e) {
    restoreBrowserProfile();
}

// Clean environment variables before restarting to prevent Launch Services issues
for (const key in process.env) {
    if (key.startsWith('VSCODE_') || key.startsWith('ELECTRON_') || key === 'TERM_PROGRAM' || key === 'TERM_PROGRAM_VERSION') {
        delete process.env[key];
    }
}

try {
    if (isMac) {
        const appMatch = appPath.match(/(.*\\.app)/);
        if (appMatch) {
            execFileSync('open', ['-n', appMatch[1]]);
        } else {
            execFileSync('open', ['-n', '-a', 'Antigravity IDE']);
        }
    } else {
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
  await chmodIfSupported(scriptPath, SECURE_FILE_MODE);

  const child = spawn(process.execPath, [scriptPath, VSCDB_PATH, statePath, BROWSER_PROFILE_PATH, tempBackup, process.execPath || 'Antigravity IDE'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  });
  child.unref();

  setTimeout(() => vscode.commands.executeCommand('workbench.action.quit'), 500);
}

// -------------------------------------------------------------------
// WebView HTML
// -------------------------------------------------------------------
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function getWebviewContent(profiles: string[], isLoggedIn: boolean): string {
  const nonce = getNonce();
  const profilesJson = toScriptJson(profiles);
  return `<!DOCTYPE html>
	<html lang="it">
	<head>
	  <meta charset="UTF-8"/>
	  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
	  <title>Account Switcher</title>
	  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"/>
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

	  <script nonce="${nonce}">
	    const vscode = acquireVsCodeApi();
	    const COLORS = ['#4d78cc', '#6b5b95', '#b565a7', '#009688', '#e91e63', '#ff9800'];
	    const SWITCH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12c0-4.4 3.6-8 8-8 2.2 0 4.2.9 5.7 2.3L20 9"/><path d="M15 9h5V4"/><path d="M20 12c0 4.4-3.6 8-8 8-2.2 0-4.2-.9-5.7-2.3L4 15"/><path d="M9 15H4v5"/></svg>';
	    function getColor(name) {
	      let h = 0; for (let i=0;i<name.length;i++){h=name.charCodeAt(i)+((h<<5)-h);}
	      return COLORS[Math.abs(h)%COLORS.length];
	    }
	    function getInitials(name){return name.trim().split(/\\s+/).filter(Boolean).map(w=>w[0]).join('').toUpperCase().slice(0,2);}
	    function createProfileButton(action, title, content) {
	      const button = document.createElement('button');
	      button.className = 'btn-icon';
	      button.type = 'button';
	      button.title = title;
	      button.dataset.action = action;
	      if (action === 'switch') {
	        button.innerHTML = content;
	      } else {
	        button.textContent = content;
	      }
	      return button;
	    }

	    function renderProfiles(profiles) {
	      const list = document.getElementById('profilesList');
	      list.replaceChildren();
	      if (!profiles || profiles.length === 0) {
	        const empty = document.createElement('div');
	        empty.className = 'empty-state';
	        empty.textContent = 'Nessun profilo salvato.';
	        list.appendChild(empty);
	        return;
	      }
	      for (const name of profiles) {
	        const card = document.createElement('div');
	        card.className = 'profile-card';

	        const avatar = document.createElement('div');
	        avatar.className = 'profile-avatar';
	        avatar.style.background = getColor(name);
	        avatar.textContent = getInitials(name);

	        const info = document.createElement('div');
	        info.className = 'profile-info';
	        const profileName = document.createElement('div');
	        profileName.className = 'profile-name';
	        profileName.textContent = name;
	        const profileSub = document.createElement('div');
	        profileSub.className = 'profile-sub';
	        profileSub.textContent = 'Profilo Google';
	        info.append(profileName, profileSub);

	        const actions = document.createElement('div');
	        actions.className = 'profile-actions';
	        const switchButton = createProfileButton('switch', 'Switch', SWITCH_ICON);
	        const renameButton = createProfileButton('rename', 'Rinomina', '✏️');
	        const deleteButton = createProfileButton('delete', 'Elimina', '🗑');
	        for (const button of [switchButton, renameButton, deleteButton]) {
	          button.dataset.name = name;
	        }
	        actions.append(switchButton, renameButton, deleteButton);
	        card.append(avatar, info, actions);
	        list.appendChild(card);
	      }
	    }

	    function showToast(type, message) {
	      const c = document.getElementById('toastContainer');
	      const t = document.createElement('div');
	      t.className = 'toast ' + (type === 'error' ? 'error' : 'success');
	      t.textContent = message;
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

	    document.getElementById('profilesList').addEventListener('click', event => {
	      const target = event.target;
	      if (!(target instanceof Element)) return;
	      const button = target.closest('button[data-action]');
	      if (!button) return;
	      const name = button.dataset.name;
	      if (!name) return;
	      if (button.dataset.action === 'switch') {
	        vscode.postMessage({command:'switchProfile', name});
	      }
	      if (button.dataset.action === 'rename') {
	        vscode.postMessage({command:'requestRenameProfile', name});
	      }
	      if (button.dataset.action === 'delete') {
	        vscode.postMessage({command:'requestDeleteProfile', name});
	      }
	    });

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
	  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"/>
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
