// Inlines src/logic.js into src/index.template.html -> index.html
const fs = require('fs');
const logic = fs.readFileSync('src/logic.js', 'utf8').replace(/if \(typeof module[^\n]*\n?/, '');
fs.writeFileSync('index.html', fs.readFileSync('src/index.template.html', 'utf8').replace('/*@@LOGIC@@*/', () => logic));
// syntax check of the page scripts
const html = fs.readFileSync('index.html', 'utf8'); const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
scripts.forEach((s, i) => fs.writeFileSync('raw/script' + i + '.js', s));
console.log('built index.html', html.length, 'bytes,', scripts.length, 'scripts');
