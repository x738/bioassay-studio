(function attachExperimentCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExperimentCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createExperimentCore() {
  'use strict';

  const VOLUME_TO_L = Object.freeze({
    l: 1,
    ml: 1e-3,
    'µl': 1e-6,
    'μl': 1e-6,
    ul: 1e-6,
  });

  const MASS_TO_G = Object.freeze({
    g: 1,
    mg: 1e-3,
    'µg': 1e-6,
    'μg': 1e-6,
    ug: 1e-6,
    ng: 1e-9,
  });

  const MOLAR_TO_M = Object.freeze({
    m: 1,
    mm: 1e-3,
    'µm': 1e-6,
    'μm': 1e-6,
    um: 1e-6,
    nm: 1e-9,
  });

  const MASS_CONCENTRATION_TO_G_PER_L = Object.freeze({
    'g/l': 1,
    'mg/ml': 1,
    'µg/µl': 1,
    'μg/μl': 1,
    'ug/ul': 1,
    'µg/ml': 1e-3,
    'μg/ml': 1e-3,
    'ug/ml': 1e-3,
    'ng/µl': 1e-3,
    'ng/μl': 1e-3,
    'ng/ul': 1e-3,
    'ng/ml': 1e-6,
  });

  const CHEMICALS = Object.freeze([
    { name: 'HEPES', formula: 'C8H18N2O4S', molecularWeight: 238.30, aliases: ['hepes free acid'] },
    { name: 'NaCl', formula: 'NaCl', molecularWeight: 58.44, aliases: ['氯化钠', 'sodium chloride'] },
    { name: 'KCl', formula: 'KCl', molecularWeight: 74.55, aliases: ['氯化钾', 'potassium chloride'] },
    { name: 'MgCl2', formula: 'MgCl2', molecularWeight: 95.21, aliases: ['氯化镁', 'magnesium chloride', 'anhydrous magnesium chloride'] },
    { name: 'MgCl2·6H2O', formula: 'MgCl2·6H2O', molecularWeight: 203.30, aliases: ['六水氯化镁', 'magnesium chloride hexahydrate'] },
    { name: 'CaCl2', formula: 'CaCl2', molecularWeight: 110.98, aliases: ['氯化钙', 'calcium chloride'] },
    { name: 'Tris', formula: 'C4H11NO3', molecularWeight: 121.14, aliases: ['tris base', '三羟甲基氨基甲烷'] },
    { name: 'Tris-HCl', formula: 'C4H12ClNO3', molecularWeight: 157.60, aliases: ['tris hydrochloride'] },
    { name: 'MES', formula: 'C6H13NO4S', molecularWeight: 195.24, aliases: ['mes free acid'] },
    { name: 'Bis-Tris', formula: 'C8H19NO5', molecularWeight: 209.24, aliases: ['bis tris'] },
    { name: 'EDTA', formula: 'C10H16N2O8', molecularWeight: 292.24, aliases: ['edta free acid', '乙二胺四乙酸'] },
    { name: 'Na2EDTA·2H2O', formula: 'C10H14N2Na2O8·2H2O', molecularWeight: 372.24, aliases: ['edta disodium dihydrate', 'edta二钠二水合物'] },
    { name: 'DTT', formula: 'C4H10O2S2', molecularWeight: 154.25, aliases: ['二硫苏糖醇', 'dithiothreitol'] },
    { name: 'PMSF', formula: 'C7H7FO2S', molecularWeight: 174.19, aliases: ['苯甲基磺酰氟'] },
    { name: 'SDS', formula: 'C12H25NaO4S', molecularWeight: 288.38, aliases: ['十二烷基硫酸钠'] },
    { name: 'Glycine', formula: 'C2H5NO2', molecularWeight: 75.07, aliases: ['甘氨酸'] },
    { name: 'Urea', formula: 'CH4N2O', molecularWeight: 60.06, aliases: ['尿素'] },
    { name: 'Sucrose', formula: 'C12H22O11', molecularWeight: 342.30, aliases: ['蔗糖'] },
    { name: 'Glycerol', formula: 'C3H8O3', molecularWeight: 92.09, aliases: ['甘油'] },
    { name: 'Imidazole', formula: 'C3H4N2', molecularWeight: 68.08, aliases: ['咪唑'] },
  ]);

  function finite(value, fallback = NaN) {
    if (value === '' || value === null || typeof value === 'undefined') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeUnit(unit) {
    return String(unit || '')
      .trim()
      .replace(/μ/g, 'µ')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  function assertPositive(value, label) {
    const parsed = finite(value);
    if (!(parsed > 0)) throw new Error(`${label}必须大于 0。`);
    return parsed;
  }

  function convertWithMap(value, fromUnit, toUnit, map, label) {
    const from = map[normalizeUnit(fromUnit)];
    const to = map[normalizeUnit(toUnit)];
    if (!from || !to) throw new Error(`${label}单位不支持：${fromUnit} → ${toUnit}`);
    return finite(value) * from / to;
  }

  function convertVolume(value, fromUnit, toUnit) {
    return convertWithMap(value, fromUnit, toUnit, VOLUME_TO_L, '体积');
  }

  function convertMass(value, fromUnit, toUnit) {
    return convertWithMap(value, fromUnit, toUnit, MASS_TO_G, '质量');
  }

  function convertMolarity(value, fromUnit, toUnit) {
    return convertWithMap(value, fromUnit, toUnit, MOLAR_TO_M, '摩尔浓度');
  }

  function smartVolume(liters) {
    const value = finite(liters);
    if (!Number.isFinite(value)) return { value: NaN, unit: 'mL' };
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.001) return { value: value * 1e6, unit: 'µL' };
    if (abs >= 1) return { value, unit: 'L' };
    return { value: value * 1e3, unit: 'mL' };
  }

  function smartMass(grams) {
    const value = finite(grams);
    if (!Number.isFinite(value)) return { value: NaN, unit: 'g' };
    const abs = Math.abs(value);
    if (abs > 0 && abs < 0.001) return { value: value * 1e6, unit: 'µg' };
    if (abs > 0 && abs < 1) return { value: value * 1e3, unit: 'mg' };
    return { value, unit: 'g' };
  }

  function roundValue(value, digits = 6) {
    if (!Number.isFinite(value)) return NaN;
    const scale = 10 ** digits;
    return Math.round((value + Number.EPSILON) * scale) / scale;
  }

  function formatNumber(value, maximumDigits = 4) {
    if (!Number.isFinite(value)) return '—';
    return new Intl.NumberFormat('zh-CN', {
      maximumFractionDigits: maximumDigits,
      minimumFractionDigits: 0,
      useGrouping: false,
    }).format(value);
  }

  function formatQuantity(quantity, maximumDigits = 4) {
    if (!quantity || !Number.isFinite(quantity.value)) return '—';
    return `${formatNumber(quantity.value, maximumDigits)} ${quantity.unit}`;
  }

  function calculateMolarity(input) {
    const concentrationM = convertMolarity(assertPositive(input.concentration, '目标浓度'), input.concentrationUnit || 'mM', 'M');
    const volumeL = convertVolume(assertPositive(input.volume, '目标体积'), input.volumeUnit || 'mL', 'L');
    const molecularWeight = assertPositive(input.molecularWeight, '分子量');
    const mass = smartMass(concentrationM * volumeL * molecularWeight);
    return {
      type: 'molarity',
      concentrationM,
      volumeL,
      molecularWeight,
      mass: { value: roundValue(mass.value), unit: mass.unit },
      formula: 'm = C × V × MW',
      basis: `${formatNumber(concentrationM)} mol/L × ${formatNumber(volumeL)} L × ${formatNumber(molecularWeight)} g/mol`,
    };
  }

  function calculateStock(input) {
    const stockM = convertMolarity(assertPositive(input.stockConcentration, '母液浓度'), input.stockUnit || 'M', 'M');
    const targetM = convertMolarity(assertPositive(input.targetConcentration, '目标浓度'), input.targetUnit || 'mM', 'M');
    const finalVolumeL = convertVolume(assertPositive(input.finalVolume, '终体积'), input.finalVolumeUnit || 'mL', 'L');
    if (targetM > stockM) throw new Error('目标浓度不能高于母液浓度。');
    const stockVolumeL = targetM * finalVolumeL / stockM;
    const solventVolumeL = finalVolumeL - stockVolumeL;
    return {
      type: 'stock',
      stockM,
      targetM,
      finalVolumeL,
      stockVolume: { ...smartVolume(stockVolumeL), value: roundValue(smartVolume(stockVolumeL).value) },
      solventVolume: { ...smartVolume(solventVolumeL), value: roundValue(smartVolume(solventVolumeL).value) },
      formula: 'C1V1 = C2V2',
      basis: `${formatNumber(stockM)} M × V1 = ${formatNumber(targetM)} M × ${formatNumber(finalVolumeL)} L`,
    };
  }

  function solveDilution(input) {
    const keys = ['c1', 'v1', 'c2', 'v2'];
    const values = Object.fromEntries(keys.map(key => [key, finite(input[key])]));
    const unknowns = keys.filter(key => !Number.isFinite(values[key]));
    if (unknowns.length !== 1) throw new Error('C1、V1、C2、V2 必须且只能留空一个。');
    keys.filter(key => key !== unknowns[0]).forEach(key => assertPositive(values[key], key.toUpperCase()));
    const unknown = unknowns[0];
    if (unknown === 'c1') values.c1 = values.c2 * values.v2 / values.v1;
    if (unknown === 'v1') values.v1 = values.c2 * values.v2 / values.c1;
    if (unknown === 'c2') values.c2 = values.c1 * values.v1 / values.v2;
    if (unknown === 'v2') values.v2 = values.c1 * values.v1 / values.c2;
    return {
      type: 'dilution',
      unknown,
      value: roundValue(values[unknown]),
      values,
      formula: 'C1V1 = C2V2',
    };
  }

  function convertMassConcentration(value, fromUnit, toUnit) {
    return convertWithMap(value, fromUnit, toUnit, MASS_CONCENTRATION_TO_G_PER_L, '质量浓度');
  }

  function convertPercentage(input) {
    const value = finite(input.value);
    if (!Number.isFinite(value) || value < 0) throw new Error('浓度必须为非负数。');
    const kind = String(input.kind || 'w/v').toLowerCase();
    if (kind === 'v/v') {
      const finalVolumeMl = convertVolume(assertPositive(input.finalVolume, '终体积'), input.finalVolumeUnit || 'mL', 'mL');
      const soluteMl = value * finalVolumeMl / 100;
      return {
        type: 'percentage',
        kind,
        percent: value,
        solute: { ...smartVolume(soluteMl / 1000), value: roundValue(smartVolume(soluteMl / 1000).value) },
        solvent: { ...smartVolume((finalVolumeMl - soluteMl) / 1000), value: roundValue(smartVolume((finalVolumeMl - soluteMl) / 1000).value) },
        note: 'v/v 与质量浓度互换需要密度，本计算不假设密度。',
      };
    }
    if (kind === 'w/v') {
      const finalVolumeMl = convertVolume(assertPositive(input.finalVolume, '终体积'), input.finalVolumeUnit || 'mL', 'mL');
      const massG = value * finalVolumeMl / 100;
      const mass = smartMass(massG);
      return {
        type: 'percentage',
        kind,
        percent: value,
        gPerL: value * 10,
        mgPerMl: value * 10,
        mass: { value: roundValue(mass.value), unit: mass.unit },
      };
    }
    const targetUnit = input.targetUnit || 'mg/mL';
    const converted = convertMassConcentration(value, input.sourceUnit || 'mg/mL', targetUnit);
    return {
      type: 'percentage',
      kind: 'mass',
      source: { value, unit: input.sourceUnit || 'mg/mL' },
      converted: { value: roundValue(converted), unit: targetUnit },
    };
  }

  function findChemical(name, chemicals = CHEMICALS) {
    const query = String(name || '').trim().toLowerCase();
    if (!query) return null;
    return chemicals.find(item => {
      if (String(item.name).toLowerCase() === query) return true;
      if (String(item.formula || '').toLowerCase() === query) return true;
      return (item.aliases || []).some(alias => String(alias).toLowerCase() === query);
    }) || null;
  }

  function calculateComponent(component, context) {
    const name = String(component.name || '').trim() || '未命名成分';
    const finalVolumeMl = convertVolume(assertPositive(context.finalVolume, '终体积'), context.finalVolumeUnit || 'mL', 'mL');
    const targetValue = assertPositive(component.targetValue, `${name} 目标浓度`);
    const targetUnit = component.targetUnit || 'mM';
    const sourceType = component.sourceType || 'auto';
    const chemical = component.chemical || findChemical(name, context.chemicals);
    const stock = component.stock || null;

    if ((sourceType === 'stock' || (sourceType === 'auto' && stock)) && stock) {
      const result = calculateStock({
        stockConcentration: stock.concentration,
        stockUnit: stock.unit,
        targetConcentration: targetValue,
        targetUnit,
        finalVolume: finalVolumeMl,
        finalVolumeUnit: 'mL',
      });
      return {
        ...component,
        name,
        sourceType: 'stock',
        stockId: stock.id,
        molecularWeight: finite(component.molecularWeight, finite(chemical?.molecularWeight)),
        actualAmount: result.stockVolume,
        basis: result.basis,
        calculation: result,
      };
    }

    if (normalizeUnit(targetUnit) === '%(w/v)' || normalizeUnit(targetUnit) === '%w/v' || normalizeUnit(targetUnit) === 'w/v%') {
      const result = convertPercentage({ value: targetValue, kind: 'w/v', finalVolume: finalVolumeMl, finalVolumeUnit: 'mL' });
      return {
        ...component,
        name,
        sourceType: 'percent-wv',
        actualAmount: result.mass,
        basis: `${formatNumber(targetValue)}% (w/v) × ${formatNumber(finalVolumeMl)} mL`,
        calculation: result,
      };
    }

    if (normalizeUnit(targetUnit) === '%(v/v)' || normalizeUnit(targetUnit) === '%v/v' || normalizeUnit(targetUnit) === 'v/v%') {
      const result = convertPercentage({ value: targetValue, kind: 'v/v', finalVolume: finalVolumeMl, finalVolumeUnit: 'mL' });
      return {
        ...component,
        name,
        sourceType: 'percent-vv',
        actualAmount: result.solute,
        basis: `${formatNumber(targetValue)}% (v/v) × ${formatNumber(finalVolumeMl)} mL`,
        calculation: result,
      };
    }

    const molecularWeight = finite(component.molecularWeight, finite(chemical?.molecularWeight));
    if (!(molecularWeight > 0)) throw new Error(`${name} 缺少有效分子量，且没有可用母液。`);
    const result = calculateMolarity({
      concentration: targetValue,
      concentrationUnit: targetUnit,
      volume: finalVolumeMl,
      volumeUnit: 'mL',
      molecularWeight,
    });
    return {
      ...component,
      name,
      sourceType: 'solid',
      molecularWeight,
      actualAmount: result.mass,
      basis: result.basis,
      calculation: result,
    };
  }

  function generateProtocol(input) {
    const components = Array.isArray(input.components) ? input.components : [];
    const finalVolumeMl = convertVolume(assertPositive(input.finalVolume, '终体积'), input.finalVolumeUnit || 'mL', 'mL');
    const initialWaterMl = roundValue(finalVolumeMl * 0.8, 3);
    const steps = [`加入约 ${formatNumber(initialWaterMl)} mL ddH₂O。`];
    components.forEach(component => {
      if (!component.actualAmount || !Number.isFinite(component.actualAmount.value)) return;
      const sourceText = component.sourceType === 'stock' ? '母液' : '';
      steps.push(`加入 ${component.name}${sourceText} ${formatQuantity(component.actualAmount)}，充分混匀。`);
    });
    if (String(input.targetPh || '').trim()) steps.push(`调节 pH 至 ${String(input.targetPh).trim()}。`);
    steps.push(`用 ddH₂O 补足终体积至 ${formatNumber(finalVolumeMl)} mL。`);
    if (input.filter !== false) steps.push('按实验需要过滤除菌或澄清。');
    if (String(input.storage || '').trim()) steps.push(`按 ${String(input.storage).trim()} 条件保存并标注日期。`);
    else steps.push('分装、标记名称与日期，并按试剂稳定性选择保存条件。');
    return steps;
  }

  function calculateBuffer(input) {
    const components = (input.components || []).filter(component => String(component.name || '').trim());
    if (!components.length) throw new Error('至少需要一个有效成分。');
    const calculated = components.map(component => calculateComponent(component, input));
    return {
      type: 'buffer',
      name: String(input.name || '未命名 Buffer').trim(),
      finalVolume: assertPositive(input.finalVolume, '终体积'),
      finalVolumeUnit: input.finalVolumeUnit || 'mL',
      targetPh: String(input.targetPh || '').trim(),
      storage: String(input.storage || '').trim(),
      components: calculated,
      steps: generateProtocol({ ...input, components: calculated }),
      calculatedAt: new Date().toISOString(),
    };
  }

  function scaleRecipe(recipe, targetVolume, targetVolumeUnit) {
    const previousMl = convertVolume(assertPositive(recipe.targetVolume, '原目标体积'), recipe.targetVolumeUnit || 'mL', 'mL');
    const nextMl = convertVolume(assertPositive(targetVolume, '新目标体积'), targetVolumeUnit || 'mL', 'mL');
    const factor = nextMl / previousMl;
    return {
      ...recipe,
      targetVolume,
      targetVolumeUnit: targetVolumeUnit || 'mL',
      components: (recipe.components || []).map(component => ({
        ...component,
        actualAmount: component.actualAmount && Number.isFinite(component.actualAmount.value)
          ? { ...component.actualAmount, value: roundValue(component.actualAmount.value * factor) }
          : component.actualAmount,
      })),
      scaleFactor: factor,
    };
  }

  function searchableText(record) {
    const values = [
      record.name,
      record.title,
      record.category,
      record.purpose,
      record.notes,
      record.text,
      record.markdown,
      record.materials,
      record.cautions,
      record.troubleshooting,
      record.references,
      ...(record.tags || []),
      ...(record.steps || []),
      ...(record.components || []).flatMap(component => [component.name, component.targetUnit, component.basis]),
    ];
    return values.filter(Boolean).join(' ').toLowerCase();
  }

  function searchRecords(records, query) {
    const normalized = String(query || '').trim().toLowerCase();
    if (!normalized) return records;
    const terms = normalized.split(/\s+/).filter(Boolean);
    return records.filter(record => {
      const haystack = searchableText(record);
      return terms.every(term => haystack.includes(term));
    });
  }

  return {
    CHEMICALS,
    normalizeUnit,
    convertVolume,
    convertMass,
    convertMolarity,
    convertMassConcentration,
    smartVolume,
    smartMass,
    formatNumber,
    formatQuantity,
    calculateMolarity,
    calculateStock,
    solveDilution,
    convertPercentage,
    findChemical,
    calculateComponent,
    generateProtocol,
    calculateBuffer,
    scaleRecipe,
    searchRecords,
  };
});
