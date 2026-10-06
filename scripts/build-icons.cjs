const fs = require('node:fs');
const path = require('node:path');
const lucide = require('lucide');
const names = ['Upload', 'Download', 'Pause', 'Play', 'X', 'Link', 'UserRound', 'ShieldCheck', 'File', 'RefreshCw', 'Copy', 'LockKeyhole', 'Eye', 'LogOut'];
const symbols = names.map((name) => `<symbol id="${name}" viewBox="0 0 24 24">${lucide[name].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('')}</symbol>`).join('');
fs.writeFileSync(path.join(__dirname, '..', 'transfer-icons.svg'), `<svg xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${symbols}</svg>\n`);
