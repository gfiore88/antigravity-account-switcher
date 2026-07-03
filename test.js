const fs = require('fs');
const path = require('path');
const os = require('os');
const VSCDB_PATH = path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb');
console.log("VSCDB exists:", fs.existsSync(VSCDB_PATH));
