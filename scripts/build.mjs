import { cp, mkdir, rm } from 'node:fs/promises';

const files = ['index.html', 'app.js', 'style.css', 'favicon.svg', 'tracking.mjs', 'recognition.mjs', 'pdf.mjs', 'cloud.mjs', 'firebase-config.js'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist');
for (const file of files) await cp(file, `dist/${file}`);
