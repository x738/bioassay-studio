const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workspaceBuild = path.resolve(__dirname, '../outputs/bioassay-studio');
const appRoot = fs.existsSync(workspaceBuild) ? workspaceBuild : path.resolve(__dirname, '..');
const core = require(path.join(appRoot, 'analysis-core.js'));

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

const regression = core.linearRegression([
  { x: 0, y: 0.1 },
  { x: 1, y: 2.1 },
  { x: 2, y: 4.1 },
]);
close(regression.slope, 2);
close(regression.intercept, 0.1);
close(regression.r2, 1);

const replicate = core.replicateSummary([1, 2, 3]);
assert.equal(replicate.n, 3);
close(replicate.mean, 2);
close(replicate.sd, 1);
close(replicate.cv, 50);

const coomassie = core.coomassieSampleResult({
  absorbances: [0.3, 0.3, 0.3],
  blankAbsorbance: 0.1,
  slope: 0.2,
  intercept: 0,
  dilution: 0,
  extractionVolume: 5,
  sampleMass: 0.5,
});
close(coomassie.measuredConcentration, 1);
assert.equal(coomassie.dilutionFactor, 1);
close(coomassie.originalConcentration, 1);
close(coomassie.proteinContent, 10);

close(core.suggestedLoadVolume(10, 200, 100), 20);
assert.ok(Number.isNaN(core.suggestedLoadVolume(10, 200, 0)));
assert.equal(core.classifySaturation(0.13, 0, 0), 'bad');
assert.equal(core.classifySaturation(0.02, 0, 0), 'warn');
assert.equal(core.classifySaturation(0, 0, 0), 'good');

const profile = [
  1, 1, 1, 1, 2, 5, 10, 18, 24, 18, 10, 5, 2, 1, 1, 1, 1,
];
const bounds = core.refineSignalBounds(profile);
assert.equal(bounds.usable, true);
assert.ok(bounds.left <= 5);
assert.ok(bounds.right >= 11);
assert.ok(bounds.center > 7 && bounds.center < 9);

const rois = core.separateNeighborRois([
  { id: 'a', x: 0, y: 0, width: 20, height: 10 },
  { id: 'b', x: 15, y: 0, width: 20, height: 10 },
]);
assert.ok(rois[0].x + rois[0].width <= rois[1].x);

const placement = core.figureFramePlacement(100, 50, 200, 100, {
  zoomPercent: 100,
});
close(placement.scale, 2);
close(placement.drawWidth, 200);
close(placement.drawHeight, 100);

const annotations = core.editLaneAnnotations(
  ['泳道 1', '泳道 2'],
  ['1.0', '0.8'],
  'insert',
  1,
);
assert.deepEqual(annotations.names, ['泳道 1', '泳道 2', '泳道 3']);
assert.deepEqual(annotations.values, ['1.0', '—', '0.8']);

console.log('Analysis core tests passed (9 groups).');
