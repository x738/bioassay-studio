const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const workspaceBuild = path.resolve(__dirname, '../outputs/bioassay-studio');
const appRoot = fs.existsSync(workspaceBuild) ? workspaceBuild : path.resolve(__dirname, '..');
const core = require(path.join(appRoot, 'experiment-core.js'));

function close(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be close to ${expected}`);
}

const hepes = core.calculateMolarity({
  concentration: 50,
  concentrationUnit: 'mM',
  volume: 50,
  volumeUnit: 'mL',
  molecularWeight: 238.30,
});
assert.equal(hepes.mass.unit, 'mg');
close(hepes.mass.value, 595.75);

const stock = core.calculateStock({
  stockConcentration: 1,
  stockUnit: 'M',
  targetConcentration: 50,
  targetUnit: 'mM',
  finalVolume: 50,
  finalVolumeUnit: 'mL',
});
assert.equal(stock.stockVolume.unit, 'mL');
close(stock.stockVolume.value, 2.5);
close(stock.solventVolume.value, 47.5);

const dilution = core.solveDilution({ c1: 1, v1: '', c2: 0.05, v2: 50 });
assert.equal(dilution.unknown, 'v1');
close(dilution.value, 2.5);

const percent = core.convertPercentage({
  value: 10,
  kind: 'v/v',
  finalVolume: 50,
  finalVolumeUnit: 'mL',
});
close(percent.solute.value, 5);
assert.equal(percent.solute.unit, 'mL');

const buffer = core.calculateBuffer({
  name: 'Extraction Buffer',
  finalVolume: 50,
  finalVolumeUnit: 'mL',
  targetPh: '7.5',
  storage: '4℃',
  chemicals: core.CHEMICALS,
  components: [
    { name: 'HEPES', targetValue: 50, targetUnit: 'mM', sourceType: 'solid' },
    {
      name: 'MgCl2',
      targetValue: 5,
      targetUnit: 'mM',
      sourceType: 'stock',
      stock: { id: 'stock-mg', concentration: 1, unit: 'M' },
    },
    { name: 'Glycerol', targetValue: 10, targetUnit: '% (v/v)', sourceType: 'auto' },
  ],
});
assert.equal(buffer.components.length, 3);
close(buffer.components[0].actualAmount.value, 595.75);
close(buffer.components[1].actualAmount.value, 250);
assert.equal(buffer.components[1].actualAmount.unit, 'µL');
close(buffer.components[2].actualAmount.value, 5);
assert.ok(buffer.steps.some(step => step.includes('pH')));
assert.ok(buffer.steps.some(step => step.includes('补足终体积')));

const found = core.searchRecords([
  { name: 'BN-PAGE 提取液', components: [{ name: 'HEPES' }] },
  { name: 'PBS', components: [{ name: 'NaCl' }] },
], 'HEPES');
assert.equal(found.length, 1);
assert.equal(found[0].name, 'BN-PAGE 提取液');

assert.equal(core.findChemical('氯化钠').molecularWeight, 58.44);
assert.equal(core.findChemical('六水氯化镁').molecularWeight, 203.30);
assert.equal(core.findChemical('吐温20').molecularWeight, null);
assert.ok(core.findChemicalMatches('phos').some(item => item.name === 'KH2PO4'));
assert.ok(core.CHEMICALS.length >= 45);

console.log('Experiment core tests passed (7 groups).');
