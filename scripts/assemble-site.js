/* Copy the public website into public/. Netlify publishes that directory.

   Server functions stay in netlify/functions, outside this folder, so a
   deploy cannot serve them as ordinary files. Anything not listed here
   (duplicate function copies, package.json, the README) is left out. */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'public');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

function copyFile(rel) {
  const dest = path.join(out, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dest);
}

function copyDir(rel) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const child = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) copyDir(child);
    else if (entry.isFile()) copyFile(child);
  }
}

for (const name of fs.readdirSync(root)) {
  if (name.endsWith('.html')) copyFile(name);
}
copyDir('assets');
copyFile('data/menus.json');
