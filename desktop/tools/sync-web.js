'use strict';

const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const sourceRoot = path.resolve(desktopRoot, '..');
const targetRoot = path.join(desktopRoot, 'web');
const include = [
  '.nojekyll',
  'index.html',
  'styles.css',
  'experiment-library.css',
  'analysis-core.js',
  'experiment-core.js',
  'app.js',
  'experiment-library.js',
  'README.md',
  'privacy.html',
  'manifest.webmanifest',
  'icon.svg',
  'service-worker.js',
  'robots.txt',
  'THIRD_PARTY_NOTICES.txt',
  'vendor',
];

fs.rmSync(targetRoot, { recursive: true, force: true });
fs.mkdirSync(targetRoot, { recursive: true });
for (const relative of include) {
  const source = path.join(sourceRoot, relative);
  const target = path.join(targetRoot, relative);
  if (!fs.existsSync(source)) throw new Error(`Missing web asset: ${source}`);
  fs.cpSync(source, target, { recursive: true });
}
console.log(`Synced BioAssay Studio web assets to ${targetRoot}`);
