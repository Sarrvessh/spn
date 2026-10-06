const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
function check(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    if (item.name.startsWith('.') || item.name === 'node_modules') continue;
    const file = path.join(directory,item.name);
    if (item.isDirectory()) check(file);
    else if (/\.(c?js)$/.test(item.name)) {
      const result = spawnSync(process.execPath, ['--check',file], { encoding:'utf8' });
      if (result.status !== 0) { process.stderr.write(result.stderr); process.exitCode = 1; }
    }
  }
}
check(path.resolve(__dirname,'..'));
