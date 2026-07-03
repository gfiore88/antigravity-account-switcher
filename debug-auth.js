const { execSync } = require('child_process');
const VSCDB_PATH = require('path').join(require('os').homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');

function getVal(key) {
  try {
    const stdout = execSync(`sqlite3 "${VSCDB_PATH}" "SELECT value FROM ItemTable WHERE key='${key}';"`);
    const val = stdout.toString().trim();
    if (!val) return null;
    return Buffer.from(val, 'base64').toString('utf8');
  } catch(e) { return null; }
}

setInterval(() => {
  const oauth = getVal('antigravityUnifiedStateSync.oauthToken');
  const user = getVal('antigravityUnifiedStateSync.userStatus');
  
  const isOauthIn = oauth ? oauth.includes('"state":"signedIn"') : false;
  const isUserIn = user ? user.includes('"state":"signedIn"') : false;
  
  console.log(`[${new Date().toISOString()}] oauthToken signedIn: ${isOauthIn}, userStatus signedIn: ${isUserIn}`);
}, 2000);
