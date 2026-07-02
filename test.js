const { execSync } = require('child_process');
const VSCDB_PATH = require('path').join(require('os').homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
const stdout = execSync(`sqlite3 "${VSCDB_PATH}" "SELECT value FROM ItemTable WHERE key='antigravityUnifiedStateSync.oauthToken';"`);
const decoded = Buffer.from(stdout.toString().trim(), 'base64').toString('utf8');
console.log('decoded length:', decoded.length);
console.log('first 500 chars:', decoded.substring(0, 500));
