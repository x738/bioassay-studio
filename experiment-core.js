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
    { name: 'HEPES', formula: 'C8H18N2O4S', molecularWeight: 238.30, aliases: ['hepes free acid', '羟乙基哌嗪乙硫磺酸'] },
    { name: 'NaCl', formula: 'NaCl', molecularWeight: 58.44, aliases: ['氯化钠', 'sodium chloride'] },
    { name: 'KCl', formula: 'KCl', molecularWeight: 74.55, aliases: ['氯化钾', 'potassium chloride'] },
    { name: 'MgCl2', formula: 'MgCl2', molecularWeight: 95.21, aliases: ['氯化镁', 'magnesium chloride', 'anhydrous magnesium chloride'] },
    { name: 'MgCl2·6H2O', formula: 'MgCl2·6H2O', molecularWeight: 203.30, aliases: ['六水氯化镁', 'magnesium chloride hexahydrate'] },
    { name: 'CaCl2', formula: 'CaCl2', molecularWeight: 110.98, aliases: ['氯化钙', 'calcium chloride'] },
    { name: 'CaCl2·2H2O', formula: 'CaCl2·2H2O', molecularWeight: 147.02, aliases: ['二水氯化钙', 'calcium chloride dihydrate'] },
    { name: 'Tris', formula: 'C4H11NO3', molecularWeight: 121.14, aliases: ['tris base', '三羟甲基氨基甲烷'] },
    { name: 'Tris-HCl', formula: 'C4H12ClNO3', molecularWeight: 157.60, aliases: ['tris hydrochloride'] },
    { name: 'MES', formula: 'C6H13NO4S', molecularWeight: 195.24, aliases: ['mes free acid'] },
    { name: 'Bis-Tris', formula: 'C8H19NO5', molecularWeight: 209.24, aliases: ['bis tris'] },
    { name: 'MOPS', formula: 'C7H15NO4S', molecularWeight: 209.26, aliases: ['3-(n-morpholino)propanesulfonic acid', '吗啉丙磺酸'] },
    { name: 'PIPES', formula: 'C8H18N2O6S2', molecularWeight: 302.37, aliases: ['哌嗪二乙磺酸'] },
    { name: 'EDTA', formula: 'C10H16N2O8', molecularWeight: 292.24, aliases: ['edta free acid', '乙二胺四乙酸'] },
    { name: 'Na2EDTA·2H2O', formula: 'C10H14N2Na2O8·2H2O', molecularWeight: 372.24, aliases: ['edta disodium dihydrate', 'edta二钠二水合物'] },
    { name: 'EGTA', formula: 'C14H24N2O10', molecularWeight: 380.35, aliases: ['乙二醇双氨乙基醚四乙酸'] },
    { name: 'DTT', formula: 'C4H10O2S2', molecularWeight: 154.25, aliases: ['二硫苏糖醇', 'dithiothreitol'] },
    { name: 'TCEP·HCl', formula: 'C9H16ClO6P', molecularWeight: 286.65, aliases: ['tcep hydrochloride', '三(2-羧乙基)膦盐酸盐'] },
    { name: 'β-Mercaptoethanol', formula: 'C2H6OS', molecularWeight: 78.13, aliases: ['beta-mercaptoethanol', '2-mercaptoethanol', 'β-巯基乙醇', '2-巯基乙醇'] },
    { name: 'PMSF', formula: 'C7H7FO2S', molecularWeight: 174.19, aliases: ['苯甲基磺酰氟'] },
    { name: 'SDS', formula: 'C12H25NaO4S', molecularWeight: 288.38, aliases: ['十二烷基硫酸钠'] },
    { name: 'Glycine', formula: 'C2H5NO2', molecularWeight: 75.07, aliases: ['甘氨酸'] },
    { name: 'Urea', formula: 'CH4N2O', molecularWeight: 60.06, aliases: ['尿素'] },
    { name: 'Thiourea', formula: 'CH4N2S', molecularWeight: 76.12, aliases: ['硫脲'] },
    { name: 'Sucrose', formula: 'C12H22O11', molecularWeight: 342.30, aliases: ['蔗糖'] },
    { name: 'D-Glucose', formula: 'C6H12O6', molecularWeight: 180.16, aliases: ['glucose', '无水葡萄糖', 'dextrose'] },
    { name: 'Glycerol', formula: 'C3H8O3', molecularWeight: 92.09, aliases: ['甘油'] },
    { name: 'Imidazole', formula: 'C3H4N2', molecularWeight: 68.08, aliases: ['咪唑'] },
    { name: 'NaH2PO4', formula: 'NaH2PO4', molecularWeight: 119.98, aliases: ['无水磷酸二氢钠', 'sodium phosphate monobasic anhydrous'] },
    { name: 'NaH2PO4·H2O', formula: 'NaH2PO4·H2O', molecularWeight: 137.99, aliases: ['一水磷酸二氢钠', 'sodium phosphate monobasic monohydrate'] },
    { name: 'Na2HPO4', formula: 'Na2HPO4', molecularWeight: 141.96, aliases: ['无水磷酸氢二钠', 'sodium phosphate dibasic anhydrous'] },
    { name: 'Na2HPO4·2H2O', formula: 'Na2HPO4·2H2O', molecularWeight: 177.99, aliases: ['二水磷酸氢二钠', 'sodium phosphate dibasic dihydrate'] },
    { name: 'KH2PO4', formula: 'KH2PO4', molecularWeight: 136.09, aliases: ['磷酸二氢钾', 'potassium phosphate monobasic'] },
    { name: 'K2HPO4', formula: 'K2HPO4', molecularWeight: 174.18, aliases: ['磷酸氢二钾', 'potassium phosphate dibasic'] },
    { name: 'Sodium acetate', formula: 'C2H3NaO2', molecularWeight: 82.03, aliases: ['无水乙酸钠', '醋酸钠', 'sodium acetate anhydrous'] },
    { name: 'Sodium acetate·3H2O', formula: 'C2H3NaO2·3H2O', molecularWeight: 136.08, aliases: ['三水乙酸钠', 'sodium acetate trihydrate'] },
    { name: 'Ammonium sulfate', formula: '(NH4)2SO4', molecularWeight: 132.14, aliases: ['硫酸铵'] },
    { name: 'Ammonium bicarbonate', formula: 'NH4HCO3', molecularWeight: 79.06, aliases: ['碳酸氢铵'] },
    { name: 'APS', formula: '(NH4)2S2O8', molecularWeight: 228.20, aliases: ['ammonium persulfate', '过硫酸铵'] },
    { name: 'Boric acid', formula: 'H3BO3', molecularWeight: 61.83, aliases: ['硼酸'] },
    { name: 'Acrylamide', formula: 'C3H5NO', molecularWeight: 71.08, aliases: ['丙烯酰胺'] },
    { name: 'Bis-acrylamide', formula: 'C7H10N2O2', molecularWeight: 154.17, aliases: ['n,n-methylenebisacrylamide', '甲叉双丙烯酰胺'] },
    { name: 'TEMED', formula: 'C6H16N2', molecularWeight: 116.20, aliases: ['四甲基乙二胺'] },
    { name: 'NaOH', formula: 'NaOH', molecularWeight: 40.00, aliases: ['氢氧化钠', 'sodium hydroxide'] },
    { name: 'KOH', formula: 'KOH', molecularWeight: 56.11, aliases: ['氢氧化钾', 'potassium hydroxide'] },
    { name: 'Triton X-100', formula: 'mixture', molecularWeight: null, aliases: ['triton x100'], notes: '混合物，无固定分子量；通常按 % (v/v) 配制。' },
    { name: 'Tween 20', formula: 'mixture', molecularWeight: null, aliases: ['polysorbate 20', '吐温20'], notes: '混合物，无固定分子量；通常按 % (v/v) 配制。' },
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

  function normalizeChemicalName(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .replace(/[‐‑‒–—−]/g, '-')
      .replace(/[·•]/g, '.')
      .replace(/[₂]/g, '2')
      .replace(/[₃]/g, '3')
      .replace(/[₄]/g, '4')
      .replace(/\s+/g, '');
  }

  function findChemical(name, chemicals = CHEMICALS) {
    const query = normalizeChemicalName(name);
    if (!query) return null;
    return chemicals.find(item => {
      if (normalizeChemicalName(item.name) === query) return true;
      if (normalizeChemicalName(item.formula) === query) return true;
      return (item.aliases || []).some(alias => normalizeChemicalName(alias) === query);
    }) || null;
  }

  function findChemicalMatches(name, chemicals = CHEMICALS, limit = 8) {
    const query = normalizeChemicalName(name);
    const unique = new Set();
    const matches = [];
    for (const item of chemicals) {
      const terms = [item.name, item.formula, ...(item.aliases || [])].map(normalizeChemicalName).filter(Boolean);
      const score = !query ? 3
        : terms.some(term => term === query) ? 0
          : terms.some(term => term.startsWith(query)) ? 1
            : terms.some(term => term.includes(query)) ? 2
              : 9;
      const key = normalizeChemicalName(item.name);
      if (score >= 9 || unique.has(key)) continue;
      unique.add(key);
      matches.push({ item, score });
    }
    return matches
      .sort((a, b) => a.score - b.score || String(a.item.name).localeCompare(String(b.item.name), 'en'))
      .slice(0, Math.max(1, Number(limit) || 8))
      .map(entry => entry.item);
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
    normalizeChemicalName,
    findChemical,
    findChemicalMatches,
    calculateComponent,
    generateProtocol,
    calculateBuffer,
    scaleRecipe,
    searchRecords,
  };
});
