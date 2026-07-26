const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workspaceBuild = path.resolve(__dirname, '../outputs/bioassay-studio');
const root = fs.existsSync(workspaceBuild) ? workspaceBuild : path.resolve(__dirname, '..');
const files = [
  'vendor/tesseract/tesseract.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-lstm.wasm.js',
  'vendor/tesseract/core/tesseract-core-lstm.wasm',
  'vendor/tesseract/lang/chi_sim.traineddata.gz',
  'vendor/tesseract/lang/eng.traineddata.gz',
  'vendor/pako_inflate.min.js',
  'vendor/PAKO-LICENSE.txt',
];

for (const relative of files) {
  const absolute = path.join(root, relative);
  assert.ok(fs.existsSync(absolute), `${relative} must exist`);
  assert.ok(fs.statSync(absolute).size > 1000, `${relative} must not be empty`);
}

const library = fs.readFileSync(path.join(root, 'experiment-library.js'), 'utf8');
assert.match(library, /Tesseract\.createWorker\('chi_sim\+eng'/);
assert.match(library, /importImagesAsProtocols/);
assert.match(library, /molecularWeightSource/);
assert.match(library, /ExperimentLibraryApi/);
assert.match(library, /PUBCHEM_BASE_URL/);
assert.match(library, /PubChem PUG REST/);
assert.match(library, /lookupChemicalOnline/);

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const privacy = fs.readFileSync(path.join(root, 'privacy.html'), 'utf8');
assert.match(app, /chooseTiffPage/);
assert.match(app, /vendor\/pako_inflate\.min\.js/);
assert.match(app, /runWbBatch/);
assert.match(app, /saveQpcrResultsToLibrary/);
assert.match(app, /saveWbResultsToLibrary/);
assert.match(app, /saveWbBatchToLibrary/);
assert.match(app, /savePairResultsToLibrary/);
assert.match(index, /id="tiffPageDialog"/);
assert.match(index, /id="wbBatchInput"/);
assert.match(index, /script-src 'self' 'wasm-unsafe-eval'/);
assert.match(index, /connect-src 'self' data:/);
assert.match(index, /connect-src[^"]*https:\/\/pubchem\.ncbi\.nlm\.nih\.gov/);
assert.match(privacy, /PubChem 在线补全默认关闭|在线补全默认关闭/);

console.log('Experiment library offline assets and integration checks passed.');
