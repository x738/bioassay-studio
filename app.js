(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const qpcrHost = $('#qpcrStepContent');
  const toast = $('#toast');
  const sheetDialog = $('#sheetDialog');
  const core = window.BioAssayCore;
  const APP_VERSION = '2.5.0';
  const auditLog = [];
  const history = { undo: [], redo: [], applying: false, max: 50 };

  const qpcr = {
    step: 1,
    headers: [],
    rows: [],
    mapping: { sample: '', gene: '', ct: '', replicate: '' },
    qc: { min: 5, max: 40, sd: 2, deviation: 1 },
    efficiencies: {},
    references: [],
    controls: [],
    results: [],
    resultView: 'table',
    chart: null,
    pendingWorkbook: null,
  };

  const wb = {
    image: null,
    fileName: '',
    imageCtx: null,
    rois: [],
    referenceId: '',
    backgroundMode: 'global',
    drawing: null,
    dragging: null,
    tempROI: null,
    nextId: 1,
    profileRoiId: '',
    selectedId: '',
    source: null,
  };

  const pair = {
    reference: { key: 'reference', label: '内参', fileName: '', image: null, imageCtx: null, canvas: null, ctx: null, rois: [], drawing: null, tempROI: null, nextId: 1, source: null },
    target: { key: 'target', label: '目的蛋白', fileName: '', image: null, imageCtx: null, canvas: null, ctx: null, rois: [], drawing: null, tempROI: null, nextId: 1, source: null },
    baseline: '',
    defaultLoadVolume: 20,
    loads: {},
  };

  const figure = {
    images: [],
    editing: false,
    editTool: 'select',
    selectedGuide: null,
    dragging: null,
    layouts: [],
  };

  const foldChangeErrorBars = {
    id: 'foldChangeErrorBars',
    afterDatasetsDraw(chart) {
      const { ctx, data, scales } = chart;
      data.datasets.forEach((dataset, datasetIndex) => {
        const bars = chart.getDatasetMeta(datasetIndex).data;
        const errors = dataset.errorBars || [];
        bars.forEach((bar, index) => {
          const value = dataset.data[index];
          const error = errors[index];
          if (!Number.isFinite(value) || !Number.isFinite(error) || error <= 0) return;
          const x = bar.x;
          const upper = scales.y.getPixelForValue(value + error);
          const lower = scales.y.getPixelForValue(Math.max(0, value - error));
          ctx.save();
          ctx.strokeStyle = '#39465b';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(x, upper); ctx.lineTo(x, lower);
          ctx.moveTo(x - 4, upper); ctx.lineTo(x + 4, upper);
          ctx.moveTo(x - 4, lower); ctx.lineTo(x + 4, lower);
          ctx.stroke();
          ctx.restore();
        });
      });
    },
  };

  const canvas = $('#wbCanvas');
  const ctx = canvas.getContext('2d');
  pair.reference.canvas = $('#pairReferenceCanvas');
  pair.reference.ctx = pair.reference.canvas.getContext('2d');
  pair.target.canvas = $('#pairTargetCanvas');
  pair.target.ctx = pair.target.canvas.getContext('2d');
  const figureCanvas = $('#wbFigureCanvas');
  const figureCtx = figureCanvas.getContext('2d');
  const wbProfileCanvas = $('#wbProfileCanvas');
  const wbProfileCtx = wbProfileCanvas.getContext('2d');
  let toastTimer;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function number(value, fallback = NaN) {
    const parsed = Number.parseFloat(String(value ?? '').replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function mean(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
  }

  function sd(values) {
    if (values.length < 2) return 0;
    const average = mean(values);
    return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
  }

  function fmt(value, digits = 3) {
    return Number.isFinite(value) ? value.toFixed(digits) : '—';
  }

  function toastMessage(message) {
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function recordAudit(action, detail = {}) {
    auditLog.push({ at: new Date().toISOString(), action, detail });
    if (auditLog.length > 1000) auditLog.shift();
  }

  function cloneData(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function editableSnapshot() {
    return {
      wb: { rois: cloneData(wb.rois), referenceId: wb.referenceId, profileRoiId: wb.profileRoiId, selectedId: wb.selectedId, backgroundMode: wb.backgroundMode, nextId: wb.nextId },
      pair: {
        baseline: pair.baseline, defaultLoadVolume: pair.defaultLoadVolume, loads: cloneData(pair.loads),
        reference: { rois: cloneData(pair.reference.rois), nextId: pair.reference.nextId },
        target: { rois: cloneData(pair.target.rois), nextId: pair.target.nextId },
      },
      figure: {
        editing: figure.editing,
        entries: figure.images.map(entry => ({ protein: entry.protein, mass: entry.mass, rotation: entry.rotation, manualCenters: entry.manualCenters ? [...entry.manualCenters] : null })),
      },
      controls: captureProjectControls(),
    };
  }

  function applyEditableSnapshot(snapshot) {
    if (!snapshot) return;
    history.applying = true;
    Object.assign(wb, cloneData(snapshot.wb || {}));
    pair.baseline = snapshot.pair?.baseline || '';
    pair.defaultLoadVolume = number(snapshot.pair?.defaultLoadVolume, 20);
    pair.loads = cloneData(snapshot.pair?.loads || {});
    for (const key of ['reference', 'target']) {
      pair[key].rois = cloneData(snapshot.pair?.[key]?.rois || []);
      pair[key].nextId = Math.max(1, number(snapshot.pair?.[key]?.nextId, pair[key].rois.length + 1));
    }
    (snapshot.figure?.entries || []).forEach((saved, index) => {
      if (!figure.images[index]) return;
      Object.assign(figure.images[index], saved);
      if (!saved.manualCenters) delete figure.images[index].manualCenters;
    });
    figure.editing = Boolean(snapshot.figure?.editing);
    figure.editTool = 'select';
    figure.selectedGuide = null;
    applyProjectControls(snapshot.controls || {});
    updateWb();
    renderPairResults();
    renderFigurePanelInputs();
    if (figure.images.length) renderWbFigure();
    history.applying = false;
    updateHistoryButtons();
  }

  function pushHistory(label) {
    if (history.applying) return;
    history.undo.push({ label, snapshot: editableSnapshot() });
    if (history.undo.length > history.max) history.undo.shift();
    history.redo = [];
    updateHistoryButtons();
  }

  function updateHistoryButtons() {
    if (!$('#undoAction')) return;
    $('#undoAction').disabled = !history.undo.length;
    $('#redoAction').disabled = !history.redo.length;
    $('#undoAction').title = history.undo.length ? `撤销：${history.undo.at(-1).label}（Ctrl+Z）` : '没有可撤销操作';
    $('#redoAction').title = history.redo.length ? `重做：${history.redo.at(-1).label}（Ctrl+Y）` : '没有可重做操作';
  }

  function undoAction() {
    const entry = history.undo.pop();
    if (!entry) return;
    history.redo.push({ label: entry.label, snapshot: editableSnapshot() });
    applyEditableSnapshot(entry.snapshot);
    recordAudit('undo', { label: entry.label });
    toastMessage(`已撤销：${entry.label}`);
  }

  function redoAction() {
    const entry = history.redo.pop();
    if (!entry) return;
    history.undo.push({ label: entry.label, snapshot: editableSnapshot() });
    applyEditableSnapshot(entry.snapshot);
    recordAudit('redo', { label: entry.label });
    toastMessage(`已重做：${entry.label}`);
  }

  async function sha256Hex(buffer) {
    if (!window.crypto?.subtle) return 'unavailable';
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function tiffRawPlane(ifd) {
    const width = ifd.width;
    const height = ifd.height;
    const bits = Math.min(32, ifd.t258?.[0] || 8);
    const channels = ifd.t277?.[0] || ifd.t258?.length || 1;
    const photometric = ifd.t262?.[0] ?? (channels === 1 ? 1 : 2);
    if (![8, 16].includes(bits) || !ifd.data || ![1, 3, 4].includes(channels)) return null;
    const maximum = 2 ** bits - 1;
    const values = new Float64Array(width * height);
    const bytes = ifd.data;
    const read = offset => bits === 16 ? bytes[offset] + bytes[offset + 1] * 256 : bytes[offset];
    const bytesPerSample = bits / 8;
    for (let index = 0; index < values.length; index += 1) {
      const offset = index * channels * bytesPerSample;
      let gray;
      if (channels === 1) gray = read(offset);
      else gray = 0.299 * read(offset) + 0.587 * read(offset + bytesPerSample) + 0.114 * read(offset + bytesPerSample * 2);
      values[index] = photometric === 0 ? maximum - gray : gray;
    }
    return { width, height, bitDepth: bits, channels, maxValue: maximum, values };
  }

  async function decodeSourceFile(file) {
    const buffer = await file.arrayBuffer();
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const isTiff = ['tif', 'tiff'].includes(extension) || /tiff/i.test(file.type);
    const lossy = ['jpg', 'jpeg'].includes(extension) || /jpeg/i.test(file.type);
    const source = {
      fileName: file.name, mimeType: file.type || 'application/octet-stream', byteSize: file.size,
      sha256: await sha256Hex(buffer), format: isTiff ? 'TIFF' : extension.toUpperCase() || 'IMAGE',
      bitDepth: 8, width: 0, height: 0, lossy, raw: null, warnings: [], originalSource: '',
    };
    let image;
    if (isTiff) {
      if (!window.UTIF) throw new Error('TIFF 解码组件未载入');
      const ifds = UTIF.decode(buffer);
      const ifd = [...ifds].filter(entry => entry.t256 && entry.t257).sort((a, b) => (b.t256[0] * b.t257[0]) - (a.t256[0] * a.t257[0]))[0];
      if (!ifd) throw new Error('TIFF 中没有可读取的图像页');
      UTIF.decodeImage(buffer, ifd, ifds);
      source.bitDepth = Math.min(32, ifd.t258?.[0] || 8);
      source.width = ifd.width;
      source.height = ifd.height;
      source.raw = tiffRawPlane(ifd);
      const preview = document.createElement('canvas');
      preview.width = ifd.width; preview.height = ifd.height;
      const previewCtx = preview.getContext('2d');
      const imageData = previewCtx.createImageData(ifd.width, ifd.height);
      if (source.raw) {
        for (let index = 0; index < source.raw.values.length; index += 1) {
          const display = clamp(Math.round(source.raw.values[index] / source.raw.maxValue * 255), 0, 255);
          const offset = index * 4;
          imageData.data[offset] = imageData.data[offset + 1] = imageData.data[offset + 2] = display;
          imageData.data[offset + 3] = 255;
        }
      } else {
        imageData.data.set(UTIF.toRGBA8(ifd));
        source.warnings.push('该 TIFF 像素布局暂不支持原始位深计算，当前按 8-bit 预览分析。');
      }
      previewCtx.putImageData(imageData, 0, 0);
      source.originalSource = preview.toDataURL('image/png');
      image = await imageFromSource(source.originalSource);
    } else {
      source.originalSource = await fileToDataUrl(file);
      image = await imageFromSource(source.originalSource);
      source.width = image.naturalWidth;
      source.height = image.naturalHeight;
      if (lossy) source.warnings.push('JPEG 为有损格式，压缩伪影可能影响弱条带定量；建议优先使用原始 TIFF/PNG。');
    }
    if (source.bitDepth <= 8) source.warnings.push('当前为 8-bit 图像；强条带更易饱和，请重点检查 QC。');
    return { image, source };
  }

  function sourceMetaText(source) {
    if (!source) return '尚未载入原始图像';
    const sizeMb = Number.isFinite(number(source.byteSize)) ? `${(source.byteSize / 1024 / 1024).toFixed(2)} MB` : '大小未知';
    const digest = source.sha256 === 'unavailable' ? '浏览器不支持' : source.sha256 ? `${source.sha256.slice(0, 12)}…` : '未记录';
    const warnings = Array.isArray(source.warnings) ? source.warnings : [];
    const warning = warnings.length ? ` · 提醒：${warnings.join('；')}` : ' · 原始像素路径可用';
    return `${source.fileName} · ${source.width} × ${source.height}px · ${source.format} ${source.bitDepth}-bit · ${sizeMb} · SHA-256 ${digest}${warning}`;
  }

  function sourceMetadata(source) {
    if (!source) return null;
    const { raw, originalSource, ...metadata } = source;
    return metadata;
  }

  function exportIntegrityReport() {
    const report = {
      schema: 'bioassay-studio-integrity-report', version: APP_VERSION, generatedAt: new Date().toISOString(),
      sources: { wb: wb.source, pairReference: pair.reference.source, pairTarget: pair.target.source, figure: figure.images.map(entry => entry.source || null) },
      roiCounts: { wb: wb.rois.length, pairReference: pair.reference.rois.length, pairTarget: pair.target.rois.length },
      auditLog,
    };
    const clean = JSON.stringify(report, (key, value) => key === 'raw' ? undefined : value, 2);
    downloadText(`bioassay-integrity-${new Date().toISOString().slice(0, 10)}.json`, clean, 'application/json;charset=utf-8');
    toastMessage('完整性报告已开始下载。');
  }

  function downloadText(filename, content, type = 'text/csv;charset=utf-8') {
    const blob = new Blob(["\ufeff", content], { type });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function downloadBlob(filename, blob) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { cell += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"') quoted = true;
      else if (char === ',') { row.push(cell.trim()); cell = ''; }
      else if (char === '\n') { row.push(cell.trim()); rows.push(row); row = []; cell = ''; }
      else if (char !== '\r') cell += char;
    }
    if (cell.length || row.length) { row.push(cell.trim()); rows.push(row); }
    return rows.filter(rowValues => rowValues.some(value => value !== ''));
  }

  function normalizeHeader(value) {
    return String(value ?? '').trim().toLowerCase().replace(/[\s_\-()]/g, '');
  }

  function guessMapping(headers) {
    const match = (patterns) => headers.find(header => patterns.some(pattern => normalizeHeader(header).includes(pattern))) || '';
    return {
      sample: match(['sample', 'samplename', '样本', 'group', '组别']),
      gene: match(['target', 'gene', 'detector', 'primer', '基因', '靶标']),
      ct: match(['ct', 'cq', 'cp', 'thresholdcycle']),
      replicate: match(['replicate', 'rep', 'biologicalsample', '生物学重复', '重复编号', '个体']),
    };
  }

  function hasMapping() {
    return ['sample', 'gene', 'ct'].every(key => Boolean(qpcr.mapping[key]));
  }

  function sourceValue(row, key) {
    return row.cells[qpcr.mapping[key]];
  }

  function qValue(row, key) {
    return key === 'ct' ? number(sourceValue(row, key)) : String(sourceValue(row, key) ?? '').trim();
  }

  function validQpcrRows() {
    return qpcr.rows.filter(row => row.use && qValue(row, 'sample') && qValue(row, 'gene') && Number.isFinite(qValue(row, 'ct')));
  }

  function groupQpcrRows() {
    const groups = new Map();
    validQpcrRows().forEach(row => {
      const sample = qValue(row, 'sample');
      const gene = qValue(row, 'gene');
      const replicate = qValue(row, 'replicate');
      const key = `${sample}|||${replicate}|||${gene}`;
      if (!groups.has(key)) groups.set(key, { key, sample, replicate, gene, rows: [] });
      groups.get(key).rows.push(row);
    });
    return [...groups.values()].map(group => {
      const values = group.rows.map(row => qValue(row, 'ct'));
      return { ...group, values, meanCt: mean(values), ctSd: sd(values), n: values.length };
    });
  }

  function rowFlag(row) {
    const ct = qValue(row, 'ct');
    if (!Number.isFinite(ct)) return 'Ct 非数值';
    if (ct < qpcr.qc.min || ct > qpcr.qc.max) return '超出 Ct 范围';
    const sample = qValue(row, 'sample');
    const gene = qValue(row, 'gene');
    const replicate = qValue(row, 'replicate');
    const group = qpcr.rows.filter(candidate => qValue(candidate, 'sample') === sample && qValue(candidate, 'gene') === gene && qValue(candidate, 'replicate') === replicate)
      .map(candidate => qValue(candidate, 'ct')).filter(Number.isFinite);
    if (group.length > 2 && sd(group) > qpcr.qc.sd) return `组内 SD > ${qpcr.qc.sd}`;
    if (group.length > 2 && Math.abs(ct - mean(group)) > qpcr.qc.deviation) return `偏离均值 > ${qpcr.qc.deviation}`;
    return '';
  }

  function demoRows() {
    const source = [
      ['Control', 'GAPDH', 18.02], ['Control', 'GAPDH', 18.15], ['Control', 'GAPDH', 18.08],
      ['Control', 'IL6', 28.95], ['Control', 'IL6', 29.11], ['Control', 'IL6', 29.04],
      ['Control', 'TNFα', 27.86], ['Control', 'TNFα', 27.92], ['Control', 'TNFα', 28.01],
      ['Control', 'IL10', 26.75], ['Control', 'IL10', 26.84], ['Control', 'IL10', 26.79],
      ['Treatment A', 'GAPDH', 18.20], ['Treatment A', 'GAPDH', 18.14], ['Treatment A', 'GAPDH', 18.26],
      ['Treatment A', 'IL6', 25.05], ['Treatment A', 'IL6', 25.13], ['Treatment A', 'IL6', 25.01],
      ['Treatment A', 'TNFα', 24.81], ['Treatment A', 'TNFα', 24.92], ['Treatment A', 'TNFα', 24.86],
      ['Treatment A', 'IL10', 28.08], ['Treatment A', 'IL10', 28.17], ['Treatment A', 'IL10', 28.11],
      ['Treatment B', 'GAPDH', 18.05], ['Treatment B', 'GAPDH', 18.17], ['Treatment B', 'GAPDH', 18.10],
      ['Treatment B', 'IL6', 26.33], ['Treatment B', 'IL6', 26.43], ['Treatment B', 'IL6', 26.38],
      ['Treatment B', 'TNFα', 26.01], ['Treatment B', 'TNFα', 26.12], ['Treatment B', 'TNFα', 26.06],
      ['Treatment B', 'IL10', 27.41], ['Treatment B', 'IL10', 27.52], ['Treatment B', 'IL10', 27.48],
    ];
    return { headers: ['Sample', 'Target', 'Cq'], grid: source };
  }

  function ingestGrid(headers, grid) {
    qpcr.headers = headers.map(header => String(header ?? '').trim());
    qpcr.rows = grid.filter(row => row.some(value => String(value ?? '').trim() !== '')).map((row, index) => {
      const cells = {};
      qpcr.headers.forEach((header, columnIndex) => { cells[header] = row[columnIndex] ?? ''; });
      return { id: `row-${index}-${Date.now()}`, cells, use: true };
    });
    qpcr.mapping = guessMapping(qpcr.headers);
    qpcr.efficiencies = {};
    qpcr.references = [];
    qpcr.controls = [];
    qpcr.results = [];
    qpcr.step = 2;
    renderQpcr();
    toastMessage(`已读取 ${qpcr.rows.length} 行数据，请确认列匹配。`);
  }

  function getGenes() {
    return [...new Set(qpcr.rows.map(row => qValue(row, 'gene')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function getSamples() {
    return [...new Set(qpcr.rows.map(row => qValue(row, 'sample')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function defaultConfiguration() {
    const genes = getGenes();
    const samples = getSamples();
    genes.forEach(gene => {
      if (!Number.isFinite(number(qpcr.efficiencies[gene]))) qpcr.efficiencies[gene] = 100;
    });
    if (!qpcr.references.length && genes.length) {
      qpcr.references = [genes.find(gene => /gapdh|actb|actin|18s|rplp0|ubq5/i.test(gene)) || genes[0]];
    }
    if (!qpcr.controls.length && samples.length) {
      qpcr.controls = [samples.find(sample => /control|ctrl|vehicle|对照/i.test(sample)) || samples[0]];
    }
  }

  function stepHtmlImport() {
    return `
      <div class="step-header"><div><h3>导入 qPCR 原始数据</h3><p>支持 .csv、.tsv、.xlsx、.xls。数据保留在当前浏览器中处理。</p></div></div>
      <div id="qpcrUploadArea" class="upload-area">
        <div><div class="upload-badge">CSV / EXCEL</div><h4>点击选择文件，或将文件拖放到此处</h4><p>建议包含样本名称、目标基因和 Ct/Cq 三列。不同仪器导出的附加列可以保留，下一步手动匹配。</p><label class="button button-primary file-button direct-file-picker"><span>选择 qPCR 数据文件</span><input id="qpcrFileInput" type="file" accept=".csv,.tsv,.txt,.xlsx,.xls" aria-label="从电脑选择 qPCR 数据文件" /></label><div class="upload-footer">也可先点击右上角“载入示例数据”熟悉流程。</div></div>
      </div>`;
  }

  function selectOptions(selected) {
    return `<option value="">请选择列</option>${qpcr.headers.map(header => `<option value="${escapeHtml(header)}" ${header === selected ? 'selected' : ''}>${escapeHtml(header)}</option>`).join('')}`;
  }

  function stepHtmlMapping() {
    const preview = qpcr.rows.slice(0, 6);
    return `
      <div class="step-header"><div><h3>匹配数据列</h3><p>已自动识别常见列名；请确认 Sample、Gene/Target 和 Ct/Cq 对应的列。</p></div><span class="pill info">已读入 ${qpcr.rows.length} 行</span></div>
      <div class="mapping-grid">
        <label>样本列 <select data-map="sample">${selectOptions(qpcr.mapping.sample)}</select></label>
        <label>基因 / 靶标列 <select data-map="gene">${selectOptions(qpcr.mapping.gene)}</select></label>
        <label>Ct / Cq 数值列 <select data-map="ct">${selectOptions(qpcr.mapping.ct)}</select></label>
        <label>生物学重复列 <span class="field-hint">可选</span><select data-map="replicate">${selectOptions(qpcr.mapping.replicate)}</select></label>
      </div>
      <div class="preview-card"><h4>数据预览</h4><div class="table-wrap"><table><thead><tr>${qpcr.headers.map(header => `<th>${escapeHtml(header)}${header === qpcr.mapping.sample ? ' · 样本' : header === qpcr.mapping.gene ? ' · 基因' : header === qpcr.mapping.ct ? ' · Ct' : header === qpcr.mapping.replicate ? ' · 生物学重复' : ''}</th>`).join('')}</tr></thead><tbody>${preview.map(row => `<tr>${qpcr.headers.map(header => `<td>${escapeHtml(row.cells[header])}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>
      <div class="actions-row"><button id="resetQpcr" class="button button-ghost">重新导入</button><button id="confirmMapping" class="button button-primary">确认匹配，进入质控</button></div>`;
  }

  function stepHtmlQcConfig() {
    const flags = qpcr.rows.filter(row => rowFlag(row));
    const used = qpcr.rows.filter(row => row.use).length;
    const genes = getGenes();
    const samples = getSamples();
    return `
      <div class="step-header"><div><h3>原始数据质控与实验设计</h3><p>可直接修改 Ct 值、排除异常重复；再选择内参与 ΔΔCt 的对照样本。</p></div><div class="status-pills"><span class="pill info">${qpcr.rows.length} 原始行</span><span class="pill good">${used} 纳入</span><span class="pill ${flags.length ? 'warn' : 'good'}">${flags.length} 条提示</span></div></div>
      <div class="qc-card">
        <div class="qc-settings">
          <label>最小 Ct<input data-qc="min" type="number" step="0.1" value="${qpcr.qc.min}" /></label>
          <label>最大 Ct<input data-qc="max" type="number" step="0.1" value="${qpcr.qc.max}" /></label>
          <label>组内 SD 阈值<input data-qc="sd" type="number" step="0.1" value="${qpcr.qc.sd}" /></label>
          <label>偏离均值阈值<input data-qc="deviation" type="number" step="0.1" value="${qpcr.qc.deviation}" /></label>
        </div>
        <div class="table-wrap"><table><thead><tr><th>纳入</th><th>样本</th><th>基因</th><th>Ct / Cq</th><th>QC 状态</th></tr></thead><tbody>
          ${qpcr.rows.map(row => { const flag = rowFlag(row); return `<tr class="${flag ? 'flagged' : ''}"><td><input class="use-check" data-use="${row.id}" type="checkbox" ${row.use ? 'checked' : ''} /></td><td>${escapeHtml(qValue(row, 'sample'))}</td><td>${escapeHtml(qValue(row, 'gene'))}</td><td><input class="table-input" data-ct="${row.id}" type="number" step="0.001" value="${escapeHtml(sourceValue(row, 'ct'))}" /></td><td>${flag ? `<span class="pill warn">${escapeHtml(flag)}</span>` : '<span class="pill good">正常</span>'}</td></tr>`; }).join('')}
        </tbody></table></div>
      </div>
      <div class="config-card"><h4>内参基因</h4><p>可多选。多个内参会先在同一样本中取平均 Ct。</p><div class="gene-chips">${genes.map(gene => `<button class="choice-chip ${qpcr.references.includes(gene) ? 'selected' : ''}" data-reference="${escapeHtml(gene)}">${escapeHtml(gene)}</button>`).join('')}</div></div>
      <div class="config-card"><h4>对照样本 / 组</h4><p>选定的样本将定义每个靶基因 ΔΔCt 的基线。</p><div class="sample-chips">${samples.map(sample => `<button class="choice-chip ${qpcr.controls.includes(sample) ? 'selected' : ''}" data-control="${escapeHtml(sample)}">${escapeHtml(sample)}</button>`).join('')}</div></div>
      <div class="config-card"><h4>引物扩增效率</h4><p>按标准曲线填写扩增效率（%）；100% 对应每循环扩增因子 2.00。结果会同时保留 Livak 2<sup>−ΔΔCt</sup> 和效率校正值。</p><div class="compact-control-grid">${genes.map(gene => `<label>${escapeHtml(gene)}<input data-efficiency-gene="${escapeHtml(gene)}" type="number" min="1" max="150" step="0.1" value="${fmt(number(qpcr.efficiencies[gene], 100), 1)}" /></label>`).join('')}</div><p class="muted">没有标准曲线时保留 100%；效率异常或不同引物差异较大时，优先复核引物和标准曲线。</p></div>
      <div class="actions-row"><button id="backToMapping" class="button button-ghost">返回匹配列</button><button id="calculateQpcr" class="button button-primary">计算 ΔΔCt 结果</button></div>`;
  }

  function efficiencyFactor(gene) {
    return 1 + clamp(number(qpcr.efficiencies[gene], 100), 1, 150) / 100;
  }

  function geometricMean(values) {
    const valid = values.filter(value => Number.isFinite(value) && value > 0);
    return valid.length ? Math.exp(mean(valid.map(value => Math.log(value)))) : NaN;
  }

  function calculateResults() {
    const stats = groupQpcrRows();
    const bySampleGene = new Map(stats.map(item => [`${item.sample}|||${item.replicate}|||${item.gene}`, item]));
    const controlDct = new Map();
    stats.forEach(item => {
      if (qpcr.references.includes(item.gene) || !qpcr.controls.includes(item.sample)) return;
      const referenceStats = qpcr.references.map(reference => bySampleGene.get(`${item.sample}|||${item.replicate}|||${reference}`)).filter(Boolean);
      if (!referenceStats.length) return;
      const refCt = mean(referenceStats.map(reference => reference.meanCt));
      const dct = item.meanCt - refCt;
      if (!controlDct.has(item.gene)) controlDct.set(item.gene, []);
      controlDct.get(item.gene).push(dct);
    });
    const controlStats = new Map([...controlDct.entries()].map(([gene, values]) => [gene, { mean: mean(values), sd: sd(values), n: values.length }]));
    const provisional = stats.filter(item => !qpcr.references.includes(item.gene)).map(item => {
      const referenceStats = qpcr.references.map(reference => bySampleGene.get(`${item.sample}|||${item.replicate}|||${reference}`)).filter(Boolean);
      const refCt = mean(referenceStats.map(reference => reference.meanCt));
      const refSd = Math.sqrt(referenceStats.reduce((sum, reference) => sum + reference.ctSd ** 2, 0) / Math.max(referenceStats.length, 1));
      const deltaCt = item.meanCt - refCt;
      const deltaCtSd = Math.sqrt(item.ctSd ** 2 + refSd ** 2);
      const baseline = controlStats.get(item.gene);
      const deltaDeltaCt = baseline ? deltaCt - baseline.mean : NaN;
      const deltaDeltaCtSd = baseline ? Math.sqrt(deltaCtSd ** 2 + baseline.sd ** 2) : NaN;
      const foldChange = Number.isFinite(deltaDeltaCt) ? 2 ** (-deltaDeltaCt) : NaN;
      const foldChangeSd = Number.isFinite(foldChange) && Number.isFinite(deltaDeltaCtSd) ? foldChange * Math.LN2 * deltaDeltaCtSd : NaN;
      const targetQuantity = efficiencyFactor(item.gene) ** (-item.meanCt);
      const referenceQuantity = geometricMean(referenceStats.map(reference => efficiencyFactor(reference.gene) ** (-reference.meanCt)));
      const normalizedQuantity = targetQuantity / referenceQuantity;
      return { ...item, refCt, deltaCt, deltaCtSd, deltaDeltaCt, deltaDeltaCtSd, foldChange, foldChangeSd, normalizedQuantity, baselineN: baseline?.n || 0 };
    });
    const efficiencyBaselines = new Map();
    provisional.forEach(item => {
      if (!qpcr.controls.includes(item.sample) || !Number.isFinite(item.normalizedQuantity) || item.normalizedQuantity <= 0) return;
      if (!efficiencyBaselines.has(item.gene)) efficiencyBaselines.set(item.gene, []);
      efficiencyBaselines.get(item.gene).push(item.normalizedQuantity);
    });
    qpcr.results = provisional.map(item => {
      const baselineValues = efficiencyBaselines.get(item.gene) || [];
      const efficiencyBaseline = geometricMean(baselineValues);
      const efficiencyFold = Number.isFinite(efficiencyBaseline) && efficiencyBaseline > 0 ? item.normalizedQuantity / efficiencyBaseline : NaN;
      return { ...item, efficiencyFold, efficiencyBaselineN: baselineValues.length };
    }).sort((a, b) => a.gene.localeCompare(b.gene, 'zh-CN') || a.sample.localeCompare(b.sample, 'zh-CN') || a.replicate.localeCompare(b.replicate, 'zh-CN'));
  }

  function biologicalSummaries() {
    const groups = new Map();
    qpcr.results.forEach(result => {
      const key = `${result.sample}|||${result.gene}`;
      if (!groups.has(key)) groups.set(key, { sample: result.sample, gene: result.gene, fold: [], efficiency: [] });
      if (Number.isFinite(result.foldChange)) groups.get(key).fold.push(result.foldChange);
      if (Number.isFinite(result.efficiencyFold)) groups.get(key).efficiency.push(result.efficiencyFold);
    });
    return [...groups.values()].map(group => ({
      ...group,
      n: group.fold.length,
      meanFold: mean(group.fold),
      sdFold: sd(group.fold),
      semFold: group.fold.length ? sd(group.fold) / Math.sqrt(group.fold.length) : NaN,
      meanEfficiencyFold: mean(group.efficiency),
      sdEfficiencyFold: sd(group.efficiency),
    })).sort((a, b) => a.gene.localeCompare(b.gene, 'zh-CN') || a.sample.localeCompare(b.sample, 'zh-CN'));
  }

  function resultTableHtml() {
    if (!qpcr.results.length) return '<tr class="empty-row"><td colspan="13">没有可计算的结果。请确认内参、对照样本和有效 Ct 数据。</td></tr>';
    return qpcr.results.map(result => `<tr><td>${escapeHtml(result.sample)}${qpcr.controls.includes(result.sample) ? ' <span class="pill info">对照</span>' : ''}</td><td>${escapeHtml(result.replicate || '—')}</td><td><b>${escapeHtml(result.gene)}</b></td><td>${result.n}</td><td>${fmt(result.meanCt)}</td><td>${fmt(result.ctSd)}</td><td>${fmt(result.refCt)}</td><td>${fmt(result.deltaCt)} ± ${fmt(result.deltaCtSd)}</td><td>${fmt(result.deltaDeltaCt)} ± ${fmt(result.deltaDeltaCtSd)}</td><td><b>${fmt(result.foldChange, 4)}</b></td><td><b>${fmt(result.efficiencyFold, 4)}</b></td><td>${fmt(result.foldChangeSd, 4)}</td><td>${result.baselineN ? `${result.baselineN} 个对照重复` : '—'}</td></tr>`).join('');
  }

  function biologicalSummaryHtml() {
    const rows = biologicalSummaries();
    if (!rows.length) return '<tr class="empty-row"><td colspan="8">没有生物学重复汇总。</td></tr>';
    return rows.map(row => `<tr><td>${escapeHtml(row.sample)}</td><td><b>${escapeHtml(row.gene)}</b></td><td>${row.n}</td><td>${fmt(row.meanFold, 4)}</td><td>${fmt(row.sdFold, 4)}</td><td>${fmt(row.semFold, 4)}</td><td>${fmt(row.meanEfficiencyFold, 4)}</td><td>${fmt(row.sdEfficiencyFold, 4)}</td></tr>`).join('');
  }

  function stepHtmlResults() {
    const up = qpcr.results.filter(result => result.foldChange > 1.5).length;
    const down = qpcr.results.filter(result => result.foldChange < 0.67).length;
    const targetGenes = [...new Set(qpcr.results.map(result => result.gene))];
    return `
      <div class="step-header"><div><h3>相对表达结果</h3><p>同时给出 Livak 2<sup>−ΔΔCt</sup> 与按各基因扩增效率校正的相对表达量；100% 效率时两者应接近。</p></div><button id="exportQpcr" class="button button-secondary">导出结果 CSV</button></div>
      <div class="result-cards"><div class="metric-card"><strong>${qpcr.results.length}</strong><span>样本 × 靶基因比较</span></div><div class="metric-card"><strong>${targetGenes.length}</strong><span>靶基因</span></div><div class="metric-card up"><strong>↑ ${up}</strong><span>上调（FC &gt; 1.5）</span></div><div class="metric-card down"><strong>↓ ${down}</strong><span>下调（FC &lt; 0.67）</span></div></div>
      <div class="result-tabs"><button class="result-tab ${qpcr.resultView === 'table' ? 'active' : ''}" data-result-view="table">结果表</button><button class="result-tab ${qpcr.resultView === 'chart' ? 'active' : ''}" data-result-view="chart">柱状图</button></div>
      <div id="resultTablePanel" class="${qpcr.resultView === 'table' ? '' : 'hide'}"><div class="table-wrap"><table><thead><tr><th>样本 / 组</th><th>生物学重复</th><th>基因</th><th>技术重复 N</th><th>Mean Ct</th><th>Ct SD</th><th>Ref Ct</th><th>ΔCt</th><th>ΔΔCt</th><th>Livak FC</th><th>效率校正 FC</th><th>传播误差</th><th>基线</th></tr></thead><tbody>${resultTableHtml()}</tbody></table></div><h4>生物学重复汇总</h4><p class="muted">仅当已映射“生物学重复”列时，N、SD 和 SEM 才代表独立生物学重复；未映射时 N 通常为 1。</p><div class="table-wrap"><table><thead><tr><th>样本 / 组</th><th>基因</th><th>生物学 N</th><th>Livak 均值</th><th>SD</th><th>SEM</th><th>效率校正均值</th><th>效率校正 SD</th></tr></thead><tbody>${biologicalSummaryHtml()}</tbody></table></div></div>
      <div id="resultChartPanel" class="chart-panel ${qpcr.resultView === 'chart' ? '' : 'hide'}"><canvas id="qpcrChart"></canvas></div>
      <div class="actions-row"><button id="reconfigureQpcr" class="button button-ghost">返回质控与设置</button><span class="muted">提示：显著性检验需依据实验设计另行选择统计方法；本工具不将技术重复直接作为生物学重复。</span></div>`;
  }

  function renderQpcr() {
    $$('.wizard-step').forEach(element => {
      const step = Number(element.dataset.step);
      element.classList.toggle('active', step === qpcr.step);
      element.classList.toggle('done', step < qpcr.step);
    });
    qpcrHost.innerHTML = qpcr.step === 1 ? stepHtmlImport() : qpcr.step === 2 ? stepHtmlMapping() : qpcr.step === 3 ? stepHtmlQcConfig() : stepHtmlResults();
    bindQpcrStep();
    if (qpcr.step === 4 && qpcr.resultView === 'chart') setTimeout(renderQpcrChart, 0);
  }

  function bindQpcrStep() {
    if (qpcr.step === 1) {
      const area = $('#qpcrUploadArea');
      const input = $('#qpcrFileInput');
      ['dragenter', 'dragover'].forEach(eventName => area.addEventListener(eventName, event => { event.preventDefault(); area.classList.add('dragover'); }));
      ['dragleave', 'drop'].forEach(eventName => area.addEventListener(eventName, event => { event.preventDefault(); area.classList.remove('dragover'); }));
      area.addEventListener('drop', event => { const file = event.dataTransfer.files[0]; if (file) loadQpcrFile(file); });
      input.addEventListener('change', event => { if (event.target.files[0]) loadQpcrFile(event.target.files[0]); });
    }
    if (qpcr.step === 2) {
      $$('[data-map]').forEach(select => select.addEventListener('change', event => { qpcr.mapping[event.target.dataset.map] = event.target.value; renderQpcr(); }));
      $('#confirmMapping').addEventListener('click', () => {
        if (!hasMapping()) return toastMessage('请完整选择样本、基因和 Ct/Cq 三列。');
        if (!validQpcrRows().length) return toastMessage('未找到有效数据，请检查列匹配与 Ct 数值。');
        defaultConfiguration(); qpcr.step = 3; renderQpcr();
      });
      $('#resetQpcr').addEventListener('click', () => { qpcr.step = 1; renderQpcr(); });
    }
    if (qpcr.step === 3) {
      $$('[data-qc]').forEach(input => input.addEventListener('change', event => { qpcr.qc[event.target.dataset.qc] = number(event.target.value, qpcr.qc[event.target.dataset.qc]); renderQpcr(); }));
      $$('[data-use]').forEach(input => input.addEventListener('change', event => { const row = qpcr.rows.find(item => item.id === event.target.dataset.use); row.use = event.target.checked; renderQpcr(); }));
      $$('[data-ct]').forEach(input => input.addEventListener('change', event => { const row = qpcr.rows.find(item => item.id === event.target.dataset.ct); row.cells[qpcr.mapping.ct] = event.target.value; renderQpcr(); }));
      $$('[data-reference]').forEach(button => button.addEventListener('click', () => { const gene = button.dataset.reference; qpcr.references = qpcr.references.includes(gene) ? qpcr.references.filter(item => item !== gene) : [...qpcr.references, gene]; renderQpcr(); }));
      $$('[data-control]').forEach(button => button.addEventListener('click', () => { const sample = button.dataset.control; qpcr.controls = qpcr.controls.includes(sample) ? qpcr.controls.filter(item => item !== sample) : [...qpcr.controls, sample]; renderQpcr(); }));
      $$('[data-efficiency-gene]').forEach(input => input.addEventListener('change', event => {
        const gene = event.target.dataset.efficiencyGene;
        qpcr.efficiencies[gene] = clamp(number(event.target.value, 100), 1, 150);
        renderQpcr();
      }));
      $('#backToMapping').addEventListener('click', () => { qpcr.step = 2; renderQpcr(); });
      $('#calculateQpcr').addEventListener('click', () => {
        if (!qpcr.references.length) return toastMessage('请至少选择一个内参基因。');
        if (!qpcr.controls.length) return toastMessage('请至少选择一个对照样本。');
        calculateResults();
        if (!qpcr.results.length) return toastMessage('没有可计算的靶基因结果，请检查数据是否包含内参和靶基因。');
        qpcr.step = 4; renderQpcr();
      });
    }
    if (qpcr.step === 4) {
      $$('[data-result-view]').forEach(button => button.addEventListener('click', () => { qpcr.resultView = button.dataset.resultView; renderQpcr(); }));
      $('#reconfigureQpcr').addEventListener('click', () => { qpcr.step = 3; renderQpcr(); });
      $('#exportQpcr').addEventListener('click', exportQpcr);
    }
  }

  async function loadQpcrFile(file) {
    try {
      const extension = file.name.split('.').pop().toLowerCase();
      if (['xlsx', 'xls'].includes(extension)) {
        if (!window.XLSX) throw new Error('Excel 解析组件未加载。');
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        if (workbook.SheetNames.length === 1) return ingestSheet(workbook, workbook.SheetNames[0]);
        qpcr.pendingWorkbook = workbook;
        $('#sheetChoices').innerHTML = workbook.SheetNames.map((name, index) => {
          const sheet = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '' });
          return `<label class="sheet-choice"><input type="radio" name="sheet" value="${escapeHtml(name)}" ${index === 0 ? 'checked' : ''}/><div><b>${escapeHtml(name)}</b><span>${Math.max(0, sheet.length - 1)} 数据行 · ${sheet[0]?.length || 0} 列</span></div></label>`;
        }).join('');
        sheetDialog.showModal();
      } else {
        const text = await file.text();
        const grid = parseCSV(text.replace(/^\uFEFF/, ''));
        if (grid.length < 2) throw new Error('文件至少需要一行表头和一行数据。');
        ingestGrid(grid[0], grid.slice(1));
      }
    } catch (error) { toastMessage(`导入失败：${error.message}`); }
  }

  function ingestSheet(workbook, sheetName) {
    const grid = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
    if (grid.length < 2) return toastMessage('所选工作表没有足够的数据。');
    ingestGrid(grid[0], grid.slice(1));
  }

  function renderQpcrChart() {
    const chartElement = $('#qpcrChart');
    if (!chartElement || !window.Chart) return;
    if (qpcr.chart) { qpcr.chart.destroy(); qpcr.chart = null; }
    const genes = [...new Set(qpcr.results.map(result => result.gene))];
    const samples = [...new Set(qpcr.results.map(result => result.sample))];
    const summaries = new Map();
    qpcr.results.forEach(result => {
      const key = `${result.sample}|||${result.gene}`;
      if (!summaries.has(key)) summaries.set(key, []);
      if (Number.isFinite(result.foldChange)) summaries.get(key).push(result.foldChange);
    });
    const colors = ['#60758b', '#f0a47b', '#6ea4c9', '#9a87bd', '#4aae83', '#d97189'];
    qpcr.chart = new Chart(chartElement, {
      type: 'bar',
      data: { labels: genes, datasets: samples.map((sample, index) => ({ label: `${sample}${qpcr.controls.includes(sample) ? '（对照）' : ''}`, data: genes.map(gene => { const values = summaries.get(`${sample}|||${gene}`) || []; return values.length ? mean(values) : null; }), errorBars: genes.map(gene => { const values = summaries.get(`${sample}|||${gene}`) || []; return values.length > 1 ? sd(values) : null; }), backgroundColor: colors[index % colors.length], borderRadius: 4 })) },
      plugins: [foldChangeErrorBars],
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'top', labels: { boxWidth: 10, usePointStyle: true } }, tooltip: { callbacks: { label: context => { const error = context.dataset.errorBars?.[context.dataIndex]; return `${context.dataset.label}: ${fmt(context.raw, 4)} ± ${fmt(error, 4)} fold`; } } } }, scales: { y: { beginAtZero: true, title: { display: true, text: '相对表达量（fold change）' }, grid: { color: '#e9edf4' } }, x: { title: { display: true, text: '靶基因' }, grid: { display: false } } } },
    });
  }

  function exportQpcr() {
    const header = ['Sample/Group', 'Biological replicate', 'Gene', 'Technical replicate N', 'Mean Ct', 'Ct SD', 'Reference Ct', 'ΔCt', 'ΔCt SD', 'ΔΔCt', 'ΔΔCt SD', 'Livak Fold Change', 'Efficiency corrected Fold Change', 'Primer efficiency (%)', 'Propagated FC error', 'Control replicate N'];
    const body = qpcr.results.map(result => [result.sample, result.replicate, result.gene, result.n, result.meanCt, result.ctSd, result.refCt, result.deltaCt, result.deltaCtSd, result.deltaDeltaCt, result.deltaDeltaCtSd, result.foldChange, result.efficiencyFold, number(qpcr.efficiencies[result.gene], 100), result.foldChangeSd, result.baselineN]);
    const summaryHeader = ['Biological summary', 'Sample/Group', 'Gene', 'Biological N', 'Livak mean', 'Livak SD', 'Livak SEM', 'Efficiency corrected mean', 'Efficiency corrected SD'];
    const summaryBody = biologicalSummaries().map(row => ['summary', row.sample, row.gene, row.n, row.meanFold, row.sdFold, row.semFold, row.meanEfficiencyFold, row.sdEfficiencyFold]);
    const csv = [header, ...body, [], summaryHeader, ...summaryBody].map(row => row.map(csvCell).join(',')).join('\n');
    downloadText('qpcr-ddct-results.csv', csv);
    toastMessage('qPCR 结果 CSV 已开始下载。');
  }

  function resetQpcrWithDemo() {
    const demo = demoRows();
    ingestGrid(demo.headers, demo.grid);
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(canvas.width, Math.round((event.clientX - rect.left) * canvas.width / rect.width))), y: Math.max(0, Math.min(canvas.height, Math.round((event.clientY - rect.top) * canvas.height / rect.height))) };
  }

  function normalizedRect(start, end) {
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    return { x, y, width: Math.max(1, Math.abs(end.x - start.x)), height: Math.max(1, Math.abs(end.y - start.y)) };
  }

  function drawRoi(rect, type, name, temporary = false) {
    const color = type === 'background' ? '#ffc85c' : '#67c9ff';
    ctx.save();
    ctx.lineWidth = Math.max(2, canvas.width / 650);
    ctx.strokeStyle = color;
    ctx.fillStyle = type === 'background' ? 'rgba(255, 200, 92, .14)' : 'rgba(103, 201, 255, .13)';
    if (temporary || rect.auto) ctx.setLineDash(rect.auto ? [6, 4] : [8, 6]);
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
    ctx.font = `${Math.max(13, canvas.width / 60)}px sans-serif`;
    const label = rect.auto ? (type === 'background' ? '自动背景' : name) : `${type === 'background' ? '背景' : '条带'} · ${name}`;
    const textWidth = ctx.measureText(label).width + 12;
    const labelHeight = Math.max(20, canvas.width / 35);
    const labelY = Math.max(0, rect.y - labelHeight * (1 + (rect.labelLevel || 0)));
    ctx.fillStyle = color;
    ctx.fillRect(rect.x, labelY, textWidth, labelHeight);
    ctx.fillStyle = '#16203b';
    ctx.fillText(label, rect.x + 6, labelY + Math.max(15, canvas.width / 47));
    ctx.restore();
  }

  function drawWb() {
    if (!wb.image) { canvas.width = 0; canvas.height = 0; return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(wb.image, 0, 0, canvas.width, canvas.height);
    wb.rois.forEach(roi => drawRoi(roi, roi.type, roi.name));
    const selected = wb.rois.find(roi => roi.id === wb.selectedId);
    if (selected) {
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(2, canvas.width / 500);
      ctx.setLineDash([]);
      ctx.strokeRect(selected.x - 2, selected.y - 2, selected.width + 4, selected.height + 4);
      ctx.restore();
    }
    if (wb.tempROI) drawRoi(wb.tempROI, wb.tempROI.type, wb.tempROI.name, true);
  }

  function regionMeasurement(source, imageCtx, roi, invert) {
    const sourceWidth = source?.raw?.width || imageCtx.canvas.width;
    const sourceHeight = source?.raw?.height || imageCtx.canvas.height;
    const x0 = clamp(Math.round(roi.x), 0, Math.max(0, sourceWidth - 1));
    const y0 = clamp(Math.round(roi.y), 0, Math.max(0, sourceHeight - 1));
    const x1 = clamp(Math.round(roi.x + roi.width), x0 + 1, sourceWidth);
    const y1 = clamp(Math.round(roi.y + roi.height), y0 + 1, sourceHeight);
    let sum = 0;
    let sumSquares = 0;
    let darkClipped = 0;
    let lightClipped = 0;
    let pixelCount = 0;
    const maximum = source?.raw?.maxValue || 255;
    if (source?.raw?.values) {
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const gray = source.raw.values[y * sourceWidth + x];
          const intensity = invert ? maximum - gray : gray;
          sum += intensity;
          sumSquares += intensity * intensity;
          if (gray <= maximum * 0.0157) darkClipped += 1;
          if (gray >= maximum * 0.9843) lightClipped += 1;
          pixelCount += 1;
        }
      }
    } else {
      const data = imageCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      for (let index = 0; index < data.length; index += 4) {
        const gray = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
        const intensity = invert ? 255 - gray : gray;
        sum += intensity;
        sumSquares += intensity * intensity;
        if (gray <= 4) darkClipped += 1;
        if (gray >= 251) lightClipped += 1;
        pixelCount += 1;
      }
    }
    pixelCount = Math.max(1, pixelCount);
    const intensity = sum / pixelCount;
    const intensitySd = Math.sqrt(Math.max(0, sumSquares / pixelCount - intensity ** 2));
    const grayscale = invert ? maximum - intensity : intensity;
    return {
      grayscale,
      grayscaleSd: intensitySd,
      intensity,
      intensitySd,
      integrated: sum,
      saturatedFraction: (invert ? darkClipped : lightClipped) / pixelCount,
      pixelCount,
      bitDepth: source?.bitDepth || 8,
      maximum,
    };
  }

  function roiMeasurement(roi) {
    return regionMeasurement(wb.source, wb.imageCtx, roi, $('#invertIntensity').checked);
  }

  function horizontalSignalProfile(source, imageCtx, roi, invert = true) {
    const sourceWidth = source?.raw?.width || imageCtx.canvas.width;
    const sourceHeight = source?.raw?.height || imageCtx.canvas.height;
    const x0 = clamp(Math.round(roi.x), 0, Math.max(0, sourceWidth - 1));
    const y0 = clamp(Math.round(roi.y), 0, Math.max(0, sourceHeight - 1));
    const x1 = clamp(Math.round(roi.x + roi.width), x0 + 1, sourceWidth);
    const y1 = clamp(Math.round(roi.y + roi.height), y0 + 1, sourceHeight);
    const maximum = source?.raw?.maxValue || 255;
    const values = [];
    const rgba = source?.raw?.values ? null : imageCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    for (let x = x0; x < x1; x += 1) {
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        let grayscale;
        if (source?.raw?.values) grayscale = source.raw.values[y * sourceWidth + x];
        else {
          const offset = ((y - y0) * (x1 - x0) + (x - x0)) * 4;
          grayscale = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
        }
        total += invert ? maximum - grayscale : grayscale;
      }
      values.push(total / Math.max(1, y1 - y0));
    }
    return values;
  }

  function bandQuality({ saturatedFraction = 0, corrected = NaN, snr = NaN, backgroundAvailable = true, touchesEdge = false, confidence = null, boundary = null, edgeConfidence = null, edgeClipped = false } = {}) {
    const issues = [];
    let severity = 'good';
    if (saturatedFraction >= 0.01) {
      issues.push(`饱和 ${(saturatedFraction * 100).toFixed(1)}%`);
      severity = 'bad';
    }
    if (Number.isFinite(corrected) && corrected <= 0) {
      issues.push('无有效信号');
      severity = 'bad';
    }
    if (!backgroundAvailable) {
      issues.push('未扣背景');
      if (severity === 'good') severity = 'warn';
    } else if (Number.isFinite(snr) && snr < 3) {
      issues.push(`低 SNR ${snr.toFixed(1)}`);
      if (severity === 'good') severity = 'warn';
    }
    if (touchesEdge) {
      issues.push('ROI 靠边');
      if (severity === 'good') severity = 'warn';
    }
    if (Number.isFinite(confidence) && confidence < 25) {
      issues.push('低置信候选');
      if (severity === 'good') severity = 'warn';
    }
    if (Number.isFinite(edgeConfidence) && edgeConfidence < 0.25) {
      issues.push('横向边界不确定');
      if (severity === 'good') severity = 'warn';
    }
    if (edgeClipped) {
      issues.push('边界接近相邻泳道');
      if (severity === 'good') severity = 'warn';
    }
    if (boundary?.severity === 'warn') {
      issues.push(boundary.text);
      if (severity === 'good') severity = 'warn';
    }
    return { severity, text: issues.length ? issues.join('；') : '通过' };
  }

  function qcBadge(quality) {
    const result = quality || { severity: 'good', text: '通过' };
    return `<span class="qc-badge ${result.severity}">${escapeHtml(result.text)}</span>`;
  }

  function movingAverage(values, radius) {
    const prefix = new Float64Array(values.length + 1);
    values.forEach((value, index) => { prefix[index + 1] = prefix[index] + value; });
    return values.map((_, index) => {
      const start = Math.max(0, index - radius);
      const end = Math.min(values.length - 1, index + radius);
      return (prefix[end + 1] - prefix[start]) / (end - start + 1);
    });
  }

  function profileStats(values) {
    return { average: mean(values), spread: sd(values), maximum: Math.max(...values) };
  }

  function wbSignalMap(maxSide = 900) {
    const scale = Math.max(1, Math.ceil(Math.max(canvas.width, canvas.height) / maxSide));
    const width = Math.ceil(canvas.width / scale);
    const height = Math.ceil(canvas.height / scale);
    const sourcePixels = wb.source?.raw?.values ? null : wb.imageCtx.getImageData(0, 0, canvas.width, canvas.height).data;
    const signal = new Float32Array(width * height);
    const invert = $('#invertIntensity').checked;
    const maximum = wb.source?.raw?.maxValue || 255;
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(canvas.height - 1, y * scale);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(canvas.width - 1, x * scale);
        let grayscale;
        if (wb.source?.raw?.values) grayscale = wb.source.raw.values[sourceY * canvas.width + sourceX];
        else {
          const offset = (sourceY * canvas.width + sourceX) * 4;
          grayscale = 0.299 * sourcePixels[offset] + 0.587 * sourcePixels[offset + 1] + 0.114 * sourcePixels[offset + 2];
        }
        signal[y * width + x] = invert ? maximum - grayscale : grayscale;
      }
    }
    return { signal, width, height, scale };
  }

  function profileAcrossRows(signal, width, x0, x1, y0, y1) {
    return Array.from({ length: y1 - y0 + 1 }, (_, offset) => {
      let total = 0;
      for (let x = x0; x <= x1; x += 1) total += signal[(y0 + offset) * width + x];
      return total / Math.max(1, x1 - x0 + 1);
    });
  }

  function profileAcrossColumns(signal, width, x0, x1, y0, y1) {
    return Array.from({ length: x1 - x0 + 1 }, (_, offset) => {
      let total = 0;
      for (let y = y0; y <= y1; y += 1) total += signal[y * width + x0 + offset];
      return total / Math.max(1, y1 - y0 + 1);
    });
  }

  function strongestActiveRun(values, minimumLength, thresholdFactor = 0.12) {
    const stats = profileStats(values);
    const cutoff = stats.average + stats.spread * thresholdFactor;
    const runs = [];
    let start = -1;
    values.forEach((value, index) => {
      if (value >= cutoff && start < 0) start = index;
      if ((value < cutoff || index === values.length - 1) && start >= 0) {
        const end = value >= cutoff && index === values.length - 1 ? index : index - 1;
        if (end - start + 1 >= minimumLength) {
          const average = mean(values.slice(start, end + 1));
          runs.push({ start, end, score: (end - start + 1) * Math.max(0, average - stats.average + 1) });
        }
        start = -1;
      }
    });
    return runs.sort((a, b) => b.score - a.score)[0] || null;
  }

  function findBlotBounds(map) {
    const { signal, width, height } = map;
    const rows = movingAverage(profileAcrossRows(signal, width, 0, width - 1, 0, height - 1), Math.max(2, Math.round(height * 0.025)));
    const rowRun = strongestActiveRun(rows, Math.max(12, Math.round(height * 0.1)));
    const y0 = rowRun ? clamp(rowRun.start - Math.round(height * 0.012), 0, height - 1) : Math.round(height * 0.04);
    const y1 = rowRun ? clamp(rowRun.end + Math.round(height * 0.012), y0 + 1, height - 1) : Math.round(height * 0.96);
    const columns = movingAverage(profileAcrossColumns(signal, width, 0, width - 1, y0, y1), Math.max(2, Math.round(width * 0.012)));
    const columnStats = profileStats(columns);
    const cutoff = columnStats.average + columnStats.spread * 0.04;
    const active = columns.map(value => value >= cutoff);
    const first = active.findIndex(Boolean);
    const last = active.length - 1 - [...active].reverse().findIndex(Boolean);
    const coversEnoughWidth = first >= 0 && last - first + 1 >= width * 0.28;
    return {
      x0: coversEnoughWidth ? clamp(first - Math.round(width * 0.01), 0, width - 1) : Math.round(width * 0.04),
      x1: coversEnoughWidth ? clamp(last + Math.round(width * 0.01), 1, width - 1) : Math.round(width * 0.96),
      y0,
      y1
    };
  }

  function percentile(values, proportion) {
    if (!values.length) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const exact = clamp(proportion, 0, 1) * (sorted.length - 1);
    const lower = Math.floor(exact);
    const upper = Math.ceil(exact);
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (exact - lower);
  }

  function topSignalColumnProfile(map, bounds) {
    const profile = [];
    const rowCount = bounds.y1 - bounds.y0 + 1;
    const keep = Math.max(3, Math.round(rowCount * 0.08));
    for (let x = bounds.x0; x <= bounds.x1; x += 1) {
      const values = [];
      for (let y = bounds.y0; y <= bounds.y1; y += 1) values.push(map.signal[y * map.width + x]);
      values.sort((a, b) => b - a);
      profile.push(mean(values.slice(0, keep)));
    }
    return movingAverage(profile, Math.max(1, Math.round(profile.length * 0.004)));
  }

  function contiguousSignalRuns(profile, threshold, minimumWidth, mergeGap) {
    const runs = [];
    let start = -1;
    let lastActive = -1;
    let gap = 0;
    const finish = () => {
      if (start < 0 || lastActive - start + 1 < minimumWidth) return;
      const values = profile.slice(start, lastActive + 1);
      const excess = values.map(value => Math.max(0, value - threshold));
      const total = excess.reduce((sum, value) => sum + value, 0);
      const center = total ? start + excess.reduce((sum, value, index) => sum + value * index, 0) / total : (start + lastActive) / 2;
      runs.push({ start, end: lastActive, center, peak: Math.max(...values), score: total });
    };
    profile.forEach((value, index) => {
      if (value >= threshold) {
        if (start < 0) start = index;
        lastActive = index;
        gap = 0;
      } else if (start >= 0) {
        gap += 1;
        if (gap > mergeGap) { finish(); start = -1; lastActive = -1; gap = 0; }
      }
    });
    finish();
    return runs;
  }

  function findLanes(map, bounds, expectedCount, sensitivity) {
    const profile = topSignalColumnProfile(map, bounds);
    const low = percentile(profile, 0.22);
    const high = percentile(profile, 0.95);
    const strictness = clamp(0.43 - sensitivity * 0.0032, 0.12, 0.34);
    const threshold = low + Math.max(2, high - low) * strictness;
    const expectedPitch = expectedCount ? profile.length / expectedCount : 0;
    const minimumWidth = Math.max(5, Math.round(profile.length * 0.012));
    const minimumDistance = Math.max(8, Math.round(expectedPitch ? expectedPitch * 0.52 : profile.length * 0.045));
    let candidates = contiguousSignalRuns(profile, threshold, minimumWidth, Math.max(1, Math.round(profile.length * 0.003)));

    // A weak, diffuse band can contain a small dip and be returned as two
    // adjacent signal runs.  They are one physical lane, so merge them before
    // considering any weak-peak supplementation.
    const mergeDistance = Math.max(minimumDistance, Math.round(expectedPitch ? expectedPitch * 0.5 : profile.length * 0.07));
    candidates = candidates.sort((a, b) => a.center - b.center).reduce((merged, candidate) => {
      const previous = merged[merged.length - 1];
      if (!previous || candidate.center - previous.center >= mergeDistance) {
        merged.push({ ...candidate });
        return merged;
      }
      const totalScore = Math.max(0.0001, previous.score) + Math.max(0.0001, candidate.score);
      previous.center = (previous.center * Math.max(0.0001, previous.score) + candidate.center * Math.max(0.0001, candidate.score)) / totalScore;
      previous.start = Math.min(previous.start, candidate.start);
      previous.end = Math.max(previous.end, candidate.end);
      previous.peak = Math.max(previous.peak, candidate.peak);
      previous.score += candidate.score;
      return merged;
    }, []);

    const looseThreshold = low + Math.max(2, high - low) * Math.max(0.06, strictness * 0.58);
    const loosePeaks = [];
    for (let index = 1; index < profile.length - 1; index += 1) {
      if (profile[index] >= looseThreshold && profile[index] >= profile[index - 1] && profile[index] > profile[index + 1]) {
        loosePeaks.push({ center: index, start: index, end: index, peak: profile[index], score: profile[index] - low });
      }
    }
    // Automatic lane counts may still miss a genuinely weak band between two
    // otherwise regular lanes. Only inspect conspicuous internal gaps (roughly
    // a missing pitch), and require a real low-threshold local maximum inside
    // the gap. This recovers weak lanes without subdividing a broad strong band.
    if (!expectedCount && candidates.length >= 3) {
      let additions = 0;
      while (additions < 4) {
        const ordered = [...candidates].sort((a, b) => a.center - b.center);
        const gaps = ordered.slice(1).map((candidate, index) => ({
          left: ordered[index],
          right: candidate,
          size: candidate.center - ordered[index].center,
        }));
        const medianGap = percentile(gaps.map(item => item.size), 0.5);
        const gap = gaps.sort((a, b) => b.size - a.size)[0];
        if (!gap || !Number.isFinite(medianGap) || gap.size < medianGap * 1.62) break;
        const margin = Math.max(minimumWidth, medianGap * 0.38);
        const eligible = loosePeaks.filter(peak => peak.center > gap.left.center + margin
          && peak.center < gap.right.center - margin
          && !candidates.some(candidate => Math.abs(candidate.center - peak.center) < minimumDistance * 0.72));
        if (!eligible.length) break;
        const peak = eligible.sort((a, b) => b.score - a.score)[0];
        candidates.push({ ...peak, weakGapFill: true });
        additions += 1;
      }
    }
    // Weak-peak supplementation is deliberately only enabled when the user
    // supplies an expected lane count.  Without that constraint, small
    // fluctuations inside a broad band can be mistaken for extra lanes.
    if (expectedCount) {
      const supplementDistance = Math.max(minimumDistance, Math.round(expectedPitch * 0.62));
      loosePeaks.sort((a, b) => b.score - a.score);
      loosePeaks.forEach(peak => {
        if (candidates.length < expectedCount && !candidates.some(candidate => Math.abs(candidate.center - peak.center) < supplementDistance)) candidates.push(peak);
      });
      // If a very weak lane falls below the loose threshold, use the geometry
      // only to locate conspicuously empty internal gaps, then choose the true
      // local signal maximum inside that gap. This does not create equal-width
      // lanes and avoids duplicating a broad neighbouring band.
      while (candidates.length < expectedCount && candidates.length >= 2) {
        const ordered = [...candidates].sort((a, b) => a.center - b.center);
        const gaps = ordered.slice(1).map((candidate, index) => ({ left: ordered[index], right: candidate, size: candidate.center - ordered[index].center }));
        const medianGap = percentile(gaps.map(gap => gap.size), 0.5);
        const gap = gaps.sort((a, b) => b.size - a.size)[0];
        if (!gap || gap.size < Math.max(expectedPitch * 1.35, medianGap * 1.5)) break;
        const searchStart = Math.ceil(gap.left.center + minimumDistance * 0.72);
        const searchEnd = Math.floor(gap.right.center - minimumDistance * 0.72);
        if (searchEnd <= searchStart) break;
        let bestIndex = searchStart;
        for (let index = searchStart + 1; index <= searchEnd; index += 1) if (profile[index] > profile[bestIndex]) bestIndex = index;
        if (candidates.some(candidate => Math.abs(candidate.center - bestIndex) < minimumDistance)) break;
        candidates.push({ center: bestIndex, start: bestIndex, end: bestIndex, peak: profile[bestIndex], score: Math.max(0.001, profile[bestIndex] - low), weakGapFill: true });
      }
    }

    if (expectedCount && candidates.length > expectedCount) candidates = candidates.sort((a, b) => b.score - a.score).slice(0, expectedCount);
    if (!candidates.length) return [{ ...bounds }];

    const detectedWidths = candidates.map(candidate => candidate.end - candidate.start + 1).filter(width => width > 2);
    const defaultWidth = clamp(Math.round(percentile(detectedWidths, 0.5) || profile.length * 0.12), Math.max(7, Math.round(profile.length * 0.03)), Math.max(8, Math.round(expectedPitch ? expectedPitch * 0.82 : profile.length * 0.18)));
    return candidates.sort((a, b) => a.center - b.center).map(candidate => {
      const sourceWidth = candidate.end - candidate.start + 1;
      const measuredWidth = sourceWidth > 2 ? sourceWidth * 1.18 : defaultWidth;
      const expectedWidth = expectedPitch ? expectedPitch * 0.9 : 0;
      const laneWidth = clamp(Math.round(Math.max(defaultWidth, measuredWidth, expectedWidth)), Math.max(7, Math.round(profile.length * 0.025)), Math.max(8, Math.round(expectedPitch ? expectedPitch * 0.92 : profile.length * 0.22)));
      return {
        x0: clamp(Math.round(bounds.x0 + candidate.center - laneWidth / 2), bounds.x0, bounds.x1 - 1),
        x1: clamp(Math.round(bounds.x0 + candidate.center + laneWidth / 2), bounds.x0 + 1, bounds.x1),
        y0: bounds.y0,
        y1: bounds.y1,
        weakGapFill: Boolean(candidate.weakGapFill),
      };
    });
  }

  function findBandCandidatesFromMap(map, sourceWidth, sourceHeight, sensitivity, expectedLaneCount = 0, bandsPerLane = 5, minimumBandGap = 0, ignoredLeftPercent = 0) {
    const { signal, width, height, scale } = map;
    const detectedBounds = findBlotBounds(map);
    const normalizedIgnoredLeft = clamp(number(ignoredLeftPercent, 0), 0, 40);
    const ignoredLeftEdge = clamp(Math.round(width * normalizedIgnoredLeft / 100), 0, Math.max(0, width - 3));
    const rawBounds = {
      ...detectedBounds,
      x0: clamp(Math.max(detectedBounds.x0, ignoredLeftEdge), 0, Math.max(0, detectedBounds.x1 - 2)),
    };
    const verticalInset = clamp(Math.round((rawBounds.y1 - rawBounds.y0 + 1) * 0.07), 3, Math.max(3, Math.round((rawBounds.y1 - rawBounds.y0 + 1) * 0.18)));
    const bounds = {
      ...rawBounds,
      y0: Math.min(rawBounds.y1 - 2, rawBounds.y0 + verticalInset),
      y1: Math.max(rawBounds.y0 + 2, rawBounds.y1 - verticalInset)
    };
    const lanes = findLanes(map, bounds, expectedLaneCount, sensitivity);
    const laneCenters = lanes.map(lane => (lane.x0 + lane.x1) / 2);
    const lanePitches = laneCenters.slice(1).map((center, index) => center - laneCenters[index]).filter(value => value > 0);
    const typicalPitch = percentile(lanePitches, 0.5) || Math.max(8, (bounds.x1 - bounds.x0 + 1) / Math.max(1, lanes.length));
    const candidates = [];
    lanes.forEach((lane, laneIndex) => {
      const rawRows = profileAcrossRows(signal, width, lane.x0, lane.x1, lane.y0, lane.y1);
      const rows = movingAverage(rawRows, Math.max(1, Math.round(rawRows.length * 0.006)));
      const baseline = movingAverage(rows, Math.max(5, Math.round(rows.length * 0.055)));
      const residual = rows.map((value, index) => value - baseline[index]);
      const stats = profileStats(residual);
      const threshold = Math.max(1.15, stats.average + stats.spread * (1.55 - sensitivity / 72), stats.maximum * 0.055);
      const minSpacing = Math.max(4, Math.round(rows.length * 0.035), Math.round(minimumBandGap / Math.max(1, scale)));
      const roughPeaks = [];
      for (let index = 1; index < residual.length - 1; index += 1) {
        if (residual[index] >= threshold && residual[index] >= residual[index - 1] && residual[index] > residual[index + 1]) roughPeaks.push({ index, score: residual[index] });
      }
      if (!roughPeaks.length && (expectedLaneCount || lane.weakGapFill) && residual.length > 2) {
        let strongest = 1;
        for (let index = 2; index < residual.length - 1; index += 1) if (residual[index] > residual[strongest]) strongest = index;
        roughPeaks.push({ index: strongest, score: Math.max(0.01, residual[strongest]), forcedWeak: true });
      }
      roughPeaks.sort((a, b) => b.score - a.score);
      const peaks = [];
      roughPeaks.forEach(peak => {
        if (!peaks.some(existing => Math.abs(existing.index - peak.index) < minSpacing) && peaks.length < bandsPerLane) peaks.push(peak);
      });
      peaks.sort((a, b) => a.index - b.index).forEach((peak, bandIndex) => {
        const localFloor = peak.forcedWeak ? Math.max(0, peak.score * 0.22) : Math.max(threshold * 0.28, peak.score * 0.22);
        const maxBandHeight = Math.max(5, Math.round(rows.length * 0.13));
        let start = peak.index;
        let end = peak.index;
        while (start > 0 && residual[start - 1] >= localFloor && end - start < maxBandHeight) start -= 1;
        while (end < residual.length - 1 && residual[end + 1] >= localFloor && end - start < maxBandHeight) end += 1;
        const paddingY = Math.max(2, Math.round((end - start + 1) * 0.42));
        const laneCenter = laneCenters[laneIndex];
        const leftLimit = laneIndex ? Math.round((laneCenters[laneIndex - 1] + laneCenter) / 2) : Math.round(laneCenter - typicalPitch * 0.5);
        const rightLimit = laneIndex < laneCenters.length - 1 ? Math.round((laneCenter + laneCenters[laneIndex + 1]) / 2) : Math.round(laneCenter + typicalPitch * 0.5);
        const leftPitch = laneIndex ? laneCenter - laneCenters[laneIndex - 1] : typicalPitch;
        const rightPitch = laneIndex < laneCenters.length - 1 ? laneCenters[laneIndex + 1] - laneCenter : typicalPitch;
        // When two detected centres are unusually close, the neighbouring
        // strong band can leak into this lane's edge profile. Increase only
        // that side's exclusion margin; normal and wide gaps keep their full
        // useful band extent.
        const leftMarginFactor = leftPitch < typicalPitch * 0.82 ? 0.11 : 0.045;
        const rightMarginFactor = rightPitch < typicalPitch * 0.82 ? 0.11 : 0.045;
        const leftMargin = Math.max(2, Math.round(typicalPitch * leftMarginFactor));
        const rightMargin = Math.max(2, Math.round(typicalPitch * rightMarginFactor));
        const searchX0 = clamp(leftLimit + leftMargin, bounds.x0, bounds.x1 - 1);
        const searchX1 = clamp(rightLimit - rightMargin, searchX0 + 1, bounds.x1);
        const bandY0 = clamp(lane.y0 + start - paddingY, 0, height - 1);
        const bandY1 = clamp(lane.y0 + end + paddingY, bandY0, height - 1);
        const horizontal = [];
        for (let xx = searchX0; xx <= searchX1; xx += 1) {
          // A band may be slightly tilted or vertically diffuse. Averaging the
          // whole column weakens its leading/trailing edge and shifts the ROI
          // toward the darkest core. Use the strongest third of the pixels in
          // each column so the horizontal extent follows the visible band.
          const columnSignal = [];
          for (let yy = bandY0; yy <= bandY1; yy += 1) columnSignal.push(signal[yy * width + xx]);
          columnSignal.sort((a, b) => b - a);
          const keep = Math.max(2, Math.round(columnSignal.length * 0.34));
          horizontal.push(columnSignal.slice(0, keep).reduce((sum, value) => sum + value, 0) / keep);
        }
        const maximumEdgeGap = Math.max(1, Math.round(typicalPitch * 0.09));
        const laneWidth = lane.x1 - lane.x0 + 1;
        const adaptiveBounds = core.refineSignalBounds(horizontal, {
          maximumGap: maximumEdgeGap,
          minimumPadding: Math.max(2, Math.round(typicalPitch * 0.035)),
          paddingFraction: 0.09,
          thresholdFraction: 0.045,
          noiseMultiplier: 0.9,
        });
        const candidateScore = clamp((peak.score - stats.average) / Math.max(stats.spread * 4, 1), 0.01, 0.99);
        const refinedCenter = adaptiveBounds.usable ? searchX0 + adaptiveBounds.center : laneCenter;
        let fittedLeft = adaptiveBounds.usable ? searchX0 + adaptiveBounds.left : Math.round(refinedCenter - laneWidth * 0.36);
        let fittedRight = adaptiveBounds.usable ? searchX0 + adaptiveBounds.right : Math.round(refinedCenter + laneWidth * 0.36);
        const minimumWidthFraction = peak.forcedWeak || lane.weakGapFill ? 0.54 : 0.38;
        const weakBand = Boolean(peak.forcedWeak || lane.weakGapFill);
        const minimumWidthBase = weakBand ? Math.min(laneWidth, typicalPitch * 0.95) : laneWidth;
        const minimumRoiWidth = Math.min(searchX1 - searchX0 + 1, Math.max(5, Math.round(minimumWidthBase * minimumWidthFraction)));
        if (fittedRight - fittedLeft + 1 < minimumRoiWidth) {
          fittedLeft = Math.round(refinedCenter - minimumRoiWidth / 2);
          fittedRight = fittedLeft + minimumRoiWidth - 1;
        }
        // Broad saturated bands often have low-contrast shoulders even though
        // their core signal is strong. If edge confidence is low but the peak
        // itself is reliable, preserve a small symmetric guard band so the
        // visible shoulders are not cut in half (common for L1/L5-like bands).
        const guardExpanded = adaptiveBounds.confidence < 0.25 && candidateScore >= 0.25;
        if (guardExpanded) {
          // Keep a little real background around broad/saturated shoulders.
          // A wider protected margin is especially important for the first
          // sample lane: unlike an interior lane it has no sample neighbour on
          // the marker side to reveal that an edge was clipped.
          const guard = Math.max(5, Math.round(typicalPitch * 0.14));
          fittedLeft -= guard;
          fittedRight += guard;
        }
        // Very weak bands can make a noise-level edge trace span almost the
        // entire lane. Keep the peak centre, but focus the ROI to the minimum
        // validated weak-band width instead of retaining mostly blank pixels.
        const weakFocused = candidateScore < 0.14;
        if (weakFocused) {
          const focusedWidth = Math.max(minimumRoiWidth, Math.round(typicalPitch * 0.52));
          fittedLeft = Math.round(refinedCenter - focusedWidth / 2);
          fittedRight = fittedLeft + focusedWidth - 1;
        }
        // Let only the protective guard cross the lane midpoint by a small
        // amount. The final neighbour-separation pass still guarantees that
        // two ROIs never overlap.
        const guardOverflow = guardExpanded ? Math.max(4, Math.round(typicalPitch * 0.14)) : 0;
        const fitX0 = clamp(searchX0 - guardOverflow, bounds.x0, searchX0);
        const fitX1 = clamp(searchX1 + guardOverflow, searchX1, bounds.x1);
        fittedLeft = clamp(fittedLeft, fitX0, Math.max(fitX0, fitX1 - minimumRoiWidth + 1));
        fittedRight = clamp(fittedRight, fittedLeft + 1, fitX1);
        const x = clamp(fittedLeft * scale, 0, sourceWidth - 1);
        const y = clamp((lane.y0 + start - paddingY) * scale, 0, sourceHeight - 1);
        const right = clamp((fittedRight + 1) * scale, x + 1, sourceWidth);
        const bottom = clamp((lane.y0 + end + paddingY + 1) * scale, y + 1, sourceHeight);
        candidates.push({
          x: Math.round(x), y: Math.round(y), width: Math.round(right - x), height: Math.round(bottom - y),
          score: candidateScore,
          laneIndex,
          bandIndex,
          edgeConfidence: adaptiveBounds.confidence,
          edgeClipped: Boolean(adaptiveBounds.clippedLeft || adaptiveBounds.clippedRight),
          guardExpanded,
          weakFocused,
          weakGapFill: Boolean(lane.weakGapFill || peak.forcedWeak),
        });
      });
    });
    return { candidates, bounds, lanes, ignoredLeftPercent: normalizedIgnoredLeft };
  }

  function findWbBandCandidates(map, expectedLaneCount = 0) {
    const bandsPerLane = clamp(Math.round(number($('#autoBandsPerLane').value, 1)), 1, 8);
    const minimumBandGap = clamp(Math.round(number($('#autoBandGap').value, 12)), 2, 160);
    return findBandCandidatesFromMap(map, canvas.width, canvas.height, number($('#autoSensitivity').value, 65), expectedLaneCount, bandsPerLane, minimumBandGap, number($('#autoMarkerPercent').value, 0));
  }

  function findWbBackgroundCandidate(map, bounds, exclusions = []) {
    const { signal, width, height, scale } = map;
    const blotHeight = Math.max(8, bounds.y1 - bounds.y0 + 1);
    const searchBounds = {
      x0: bounds.x0,
      x1: bounds.x1,
      y0: Math.max(0, Math.round(bounds.y0 - blotHeight * 0.55)),
      y1: Math.min(height - 1, Math.round(bounds.y1 + blotHeight * 1.25)),
    };
    const boxWidth = clamp(Math.round((bounds.x1 - bounds.x0 + 1) * 0.13), 12, 120);
    const boxHeight = clamp(Math.round(blotHeight * 0.09), 8, 70);
    const xStep = Math.max(2, Math.round(boxWidth / 2));
    const yStep = Math.max(2, Math.round(boxHeight / 2));
    const marginX = Math.max(2, Math.round((bounds.x1 - bounds.x0 + 1) * 0.025));
    const marginY = Math.max(2, Math.round(blotHeight * 0.025));
    let best = null;
    for (let y = searchBounds.y0 + marginY; y + boxHeight < searchBounds.y1 - marginY; y += yStep) {
      for (let x = searchBounds.x0 + marginX; x + boxWidth < searchBounds.x1 - marginX; x += xStep) {
        const outputRect = { x: x * scale, y: y * scale, width: boxWidth * scale, height: boxHeight * scale };
        const touchesBand = exclusions.some(band => {
          const margin = Math.max(4, Math.round(band.height * 0.9));
          const expanded = { x: band.x - margin, y: band.y - margin, width: band.width + margin * 2, height: band.height + margin * 2 };
          return Math.max(outputRect.x, expanded.x) < Math.min(outputRect.x + outputRect.width, expanded.x + expanded.width)
            && Math.max(outputRect.y, expanded.y) < Math.min(outputRect.y + outputRect.height, expanded.y + expanded.height);
        });
        if (touchesBand) continue;
        let total = 0;
        let squares = 0;
        let count = 0;
        for (let yy = y; yy < y + boxHeight; yy += 2) {
          for (let xx = x; xx < x + boxWidth; xx += 2) {
            const value = signal[yy * width + xx];
            total += value;
            squares += value * value;
            count += 1;
          }
        }
        const average = total / count;
        const variance = Math.max(0, squares / count - average ** 2);
        const score = average + Math.sqrt(variance) * 0.35;
        if (!best || score < best.score) best = { x, y, width: boxWidth, height: boxHeight, score };
      }
    }
    if (!best) return null;
    return { x: Math.round(best.x * scale), y: Math.round(best.y * scale), width: Math.max(1, Math.round(best.width * scale)), height: Math.max(1, Math.round(best.height * scale)) };
  }

  function rectOverlap(a, b) {
    const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
    const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
    const overlap = overlapWidth * overlapHeight;
    return overlap / Math.max(1, a.width * a.height + b.width * b.height - overlap);
  }

  function supplementExpectedLaneCandidates(candidates, expectedCount, sourceWidth, sourceHeight) {
    const selected = candidates.map(candidate => ({ ...candidate }));
    if (!expectedCount || selected.length < 2 || selected.length >= expectedCount) {
      return selected.sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
    }
    while (selected.length < expectedCount) {
      const ordered = [...selected].sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
      const gaps = ordered.slice(1).map((candidate, index) => ({
        left: ordered[index], right: candidate,
        size: candidate.x + candidate.width / 2 - (ordered[index].x + ordered[index].width / 2),
      }));
      const typicalGap = percentile(gaps.map(gap => gap.size), 0.5);
      const gap = gaps.sort((a, b) => b.size - a.size)[0];
      if (!gap || gap.size < typicalGap * 1.48) break;
      const centerX = ((gap.left.x + gap.left.width / 2) + (gap.right.x + gap.right.width / 2)) / 2;
      const centerY = ((gap.left.y + gap.left.height / 2) + (gap.right.y + gap.right.height / 2)) / 2;
      const width = Math.max(4, Math.round(percentile(ordered.map(candidate => candidate.width), 0.5)));
      const height = Math.max(3, Math.round(percentile(ordered.map(candidate => candidate.height), 0.5)));
      selected.push({
        x: clamp(Math.round(centerX - width / 2), 0, Math.max(0, sourceWidth - width)),
        y: clamp(Math.round(centerY - height / 2), 0, Math.max(0, sourceHeight - height)),
        width, height, score: 0.08, weakGapFill: true,
      });
    }
    const ordered = selected.sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
    ordered.forEach((candidate, index) => { candidate.laneIndex = index; candidate.bandIndex = 0; });
    return ordered;
  }

  function autoDetectWb() {
    if (!wb.image) return toastMessage('请先载入 WB 图片，再运行自动识别。');
    pushHistory('WB 自动识别');
    const maxBands = clamp(Math.round(number($('#autoMaxBands').value, 24)), 1, 96);
    const expectedLaneCount = clamp(Math.round(number($('#autoLaneCount').value, 0)), 0, 96);
    const bandsPerLane = clamp(Math.round(number($('#autoBandsPerLane').value, 1)), 1, 8);
    const manualRois = wb.rois.filter(roi => !roi.auto);
    const detection = findWbBandCandidates(wbSignalMap(), expectedLaneCount);
    const rawCandidates = detection.candidates.sort((a, b) => b.score - a.score);
    const candidatesByLane = new Map();
    rawCandidates.forEach(candidate => {
      if (candidate.width < 4 || candidate.height < 3) return;
      if (manualRois.some(roi => roi.type === 'band' && rectOverlap(roi, candidate) > 0.3)) return;
      if (!candidatesByLane.has(candidate.laneIndex)) candidatesByLane.set(candidate.laneIndex, []);
      if (candidatesByLane.get(candidate.laneIndex).length < bandsPerLane) candidatesByLane.get(candidate.laneIndex).push(candidate);
    });
    let selected = [...candidatesByLane.values()].flat().sort((a, b) => b.score - a.score).slice(0, maxBands);
    if (bandsPerLane === 1) selected = supplementExpectedLaneCandidates(selected, expectedLaneCount, canvas.width, canvas.height);
    selected.sort((a, b) => a.laneIndex - b.laneIndex || a.y - b.y);
    // Keep neighbouring automatic boxes physically separate.  This prevents a
    // diffuse lane and a very weak adjacent lane from being shown as two
    // overlapping ROIs even when their initial peak windows touch.
    selected = core.separateNeighborRois(selected, 4);
    const laneOrder = [...new Set(selected.map(candidate => candidate.laneIndex))];
    const bandsSeen = new Map();
    let previousLabelRight = -Infinity;
    const generated = selected.map(candidate => {
      const displayedLane = laneOrder.indexOf(candidate.laneIndex) + 1;
      const bandNumber = (bandsSeen.get(candidate.laneIndex) || 0) + 1;
      bandsSeen.set(candidate.laneIndex, bandNumber);
      const labelWidthEstimate = 58;
      const labelLevel = candidate.x < previousLabelRight ? 1 : 0;
      previousLabelRight = Math.max(previousLabelRight, candidate.x + labelWidthEstimate);
      return {
        id: `roi-${wb.nextId++}`,
        type: 'band',
        name: `L${displayedLane}-B${bandNumber}`,
        group: `泳道 ${displayedLane}`,
        auto: true,
        labelLevel,
        confidence: Math.round(clamp(candidate.score * 100, 1, 99)),
        weakGapFill: Boolean(candidate.weakGapFill),
        ...candidate
      };
    });
    const hasManualBackground = manualRois.some(roi => roi.type === 'background');
    if ($('#autoBackground').checked && !hasManualBackground) {
      const background = findWbBackgroundCandidate(wbSignalMap(), detection.bounds, selected);
      if (background) generated.unshift({ id: `roi-${wb.nextId++}`, type: 'background', name: '自动背景', group: '自动识别', auto: true, confidence: null, ...background });
    }
    wb.rois = [...manualRois, ...generated];
    wb.selectedId = generated.find(roi => roi.type === 'band')?.id || '';
    const backgroundCount = generated.filter(roi => roi.type === 'background').length;
    const laneSource = expectedLaneCount ? `按填写的 ${expectedLaneCount} 个泳道` : `自动估计的 ${detection.lanes.length} 个泳道`;
    const markerNote = detection.ignoredLeftPercent ? `，已忽略左侧 ${fmt(detection.ignoredLeftPercent, 0)}% Marker 区域` : '';
    $('#autoDetectionNote').textContent = generated.length ? `已定位膜区域${markerNote}，并${laneSource}推荐 ${selected.length} 个条带和 ${backgroundCount} 个背景 ROI。候选框已按真实信号边缘精修，请在导出前人工确认。` : '未找到足够清晰的候选条带；请提高灵敏度，或填写预期泳道数后重试。';
    updateWb();
    recordAudit('wb-auto-detect', { expectedLaneCount, ignoredLeftPercent: detection.ignoredLeftPercent, bandsPerLane, selectedBands: selected.length, backgroundCount });
    if (generated.length) toastMessage(`自动识别完成：${selected.length} 个候选条带。`);
  }

  function regionIntensityValues(source, imageCtx, rect, invert, stride = 1, exclude = null) {
    const width = source?.raw?.width || imageCtx.canvas.width;
    const height = source?.raw?.height || imageCtx.canvas.height;
    const maximum = source?.raw?.maxValue || 255;
    const x0 = clamp(Math.floor(rect.x), 0, Math.max(0, width - 1));
    const y0 = clamp(Math.floor(rect.y), 0, Math.max(0, height - 1));
    const x1 = clamp(Math.ceil(rect.x + rect.width), x0 + 1, width);
    const y1 = clamp(Math.ceil(rect.y + rect.height), y0 + 1, height);
    const rgba = source?.raw?.values ? null : imageCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const values = [];
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        if (exclude && x >= exclude.x && x < exclude.x + exclude.width && y >= exclude.y && y < exclude.y + exclude.height) continue;
        let gray;
        if (source?.raw?.values) gray = source.raw.values[y * width + x];
        else {
          const offset = ((y - y0) * (x1 - x0) + x - x0) * 4;
          gray = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
        }
        values.push(invert ? maximum - gray : gray);
      }
    }
    return values;
  }

  function robustStats(values) {
    if (!values.length) return { intensity: 0, sd: NaN, available: false };
    const sorted = [...values].sort((a, b) => a - b);
    const trim = Math.floor(sorted.length * 0.1);
    const kept = sorted.slice(trim, Math.max(trim + 1, sorted.length - trim));
    return { intensity: mean(kept), sd: sd(kept), available: true };
  }

  function sideBackgroundForBand(row) {
    const gap = Math.max(2, Math.round(row.width * 0.1));
    const stripWidth = Math.max(4, Math.round(row.width * 0.65));
    const regions = [];
    if (row.x - gap - stripWidth >= 0) regions.push({ x: row.x - gap - stripWidth, y: row.y, width: stripWidth, height: row.height });
    if (row.x + row.width + gap + stripWidth <= canvas.width) regions.push({ x: row.x + row.width + gap, y: row.y, width: stripWidth, height: row.height });
    const values = regions.flatMap(region => regionIntensityValues(wb.source, wb.imageCtx, region, $('#invertIntensity').checked));
    return { ...robustStats(values), label: regions.length === 2 ? '左右局部背景' : regions.length ? '单侧局部背景' : '局部背景不可用' };
  }

  function solve3x3(matrix, vector) {
    const rows = matrix.map((row, index) => [...row, vector[index]]);
    for (let column = 0; column < 3; column += 1) {
      let pivot = column;
      for (let row = column + 1; row < 3; row += 1) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
      [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
      if (Math.abs(rows[column][column]) < 1e-10) return null;
      const divisor = rows[column][column];
      for (let index = column; index < 4; index += 1) rows[column][index] /= divisor;
      for (let row = 0; row < 3; row += 1) {
        if (row === column) continue;
        const factor = rows[row][column];
        for (let index = column; index < 4; index += 1) rows[row][index] -= factor * rows[column][index];
      }
    }
    return rows.map(row => row[3]);
  }

  function planeBackgroundForBand(row) {
    const padX = Math.max(8, Math.round(row.width * 0.9));
    const padY = Math.max(6, Math.round(row.height * 1.3));
    const region = { x: row.x - padX, y: row.y - padY, width: row.width + padX * 2, height: row.height + padY * 2 };
    const stride = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, region.width * region.height) / 7000)));
    const width = wb.source?.raw?.width || canvas.width;
    const height = wb.source?.raw?.height || canvas.height;
    const maximum = wb.source?.raw?.maxValue || 255;
    const invert = $('#invertIntensity').checked;
    const samples = [];
    const x0 = clamp(Math.floor(region.x), 0, width - 1);
    const y0 = clamp(Math.floor(region.y), 0, height - 1);
    const x1 = clamp(Math.ceil(region.x + region.width), x0 + 1, width);
    const y1 = clamp(Math.ceil(region.y + region.height), y0 + 1, height);
    const rgba = wb.source?.raw?.values ? null : wb.imageCtx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const centerX = row.x + row.width / 2;
    const centerY = row.y + row.height / 2;
    for (let y = y0; y < y1; y += stride) {
      for (let x = x0; x < x1; x += stride) {
        if (x >= row.x && x < row.x + row.width && y >= row.y && y < row.y + row.height) continue;
        let gray;
        if (wb.source?.raw?.values) gray = wb.source.raw.values[y * width + x];
        else {
          const offset = ((y - y0) * (x1 - x0) + x - x0) * 4;
          gray = 0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2];
        }
        samples.push({ x: (x - centerX) / Math.max(1, row.width), y: (y - centerY) / Math.max(1, row.height), z: invert ? maximum - gray : gray });
      }
    }
    if (samples.length < 12) return { intensity: 0, sd: NaN, available: false, label: '背景平面不可用' };
    const fit = points => {
      const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      const v = [0, 0, 0];
      points.forEach(point => {
        const p = [1, point.x, point.y];
        for (let i = 0; i < 3; i += 1) { v[i] += p[i] * point.z; for (let j = 0; j < 3; j += 1) m[i][j] += p[i] * p[j]; }
      });
      return solve3x3(m, v);
    };
    let coefficients = fit(samples);
    if (!coefficients) return { intensity: 0, sd: NaN, available: false, label: '背景平面不可用' };
    let residuals = samples.map(point => point.z - (coefficients[0] + coefficients[1] * point.x + coefficients[2] * point.y));
    const residualSd = sd(residuals);
    const kept = residualSd > 0 ? samples.filter((point, index) => Math.abs(residuals[index]) <= residualSd * 2.5) : samples;
    coefficients = fit(kept) || coefficients;
    residuals = kept.map(point => point.z - (coefficients[0] + coefficients[1] * point.x + coefficients[2] * point.y));
    return { intensity: coefficients[0], sd: sd(residuals), available: true, label: `二维背景平面（${kept.length} 点）` };
  }

  function wbRowsWithMetrics() {
    if (!wb.image) return [];
    const rows = wb.rois.map(roi => ({ ...roi, ...roiMeasurement(roi) }));
    const backgrounds = rows.filter(row => row.type === 'background');
    const globalBackground = backgrounds.length ? mean(backgrounds.map(row => row.intensity)) : 0;
    const globalBackgroundSd = backgrounds.length ? Math.sqrt(mean(backgrounds.map(row => row.intensitySd ** 2 + (row.intensity - globalBackground) ** 2))) : NaN;
    const selectedBackground = row => {
      if (wb.backgroundMode === 'side') return sideBackgroundForBand(row);
      if (wb.backgroundMode === 'plane') return planeBackgroundForBand(row);
      if (!backgrounds.length) return { intensity: 0, sd: NaN, label: '无背景 ROI', available: false };
      if (wb.backgroundMode === 'global') return { intensity: globalBackground, sd: globalBackgroundSd, label: '全部背景平均', available: true };
      const rowX = row.x + row.width / 2;
      const rowY = row.y + row.height / 2;
      const closest = [...backgrounds].sort((a, b) => ((a.x + a.width / 2 - rowX) ** 2 + (a.y + a.height / 2 - rowY) ** 2) - ((b.x + b.width / 2 - rowX) ** 2 + (b.y + b.height / 2 - rowY) ** 2))[0];
      return { intensity: closest.intensity, sd: closest.intensitySd, label: `最近：${closest.name}`, available: true };
    };
    const preliminary = rows.map(row => {
      if (row.type !== 'band') {
        const quality = bandQuality({ saturatedFraction: row.saturatedFraction });
        return { ...row, corrected: NaN, globalBackground, quality };
      }
      const background = selectedBackground(row);
      const correctedMean = row.intensity - background.intensity;
      const corrected = correctedMean * row.width * row.height;
      const snr = background.available ? correctedMean / Math.max(background.sd || 0, 1) : NaN;
      const touchesEdge = row.x <= 1 || row.y <= 1 || row.x + row.width >= canvas.width - 1 || row.y + row.height >= canvas.height - 1;
      const boundary = core.signalBoundaryQuality(horizontalSignalProfile(wb.source, wb.imageCtx, row, $('#invertIntensity').checked));
      const quality = bandQuality({ saturatedFraction: row.saturatedFraction, corrected, snr, backgroundAvailable: background.available, touchesEdge, confidence: row.confidence, boundary, edgeConfidence: row.edgeConfidence, edgeClipped: row.edgeClipped });
      const analysisExcluded = Boolean(row.excluded || ($('#wbAutoExcludeBad').checked && quality.severity === 'bad' && !row.forceInclude));
      return { ...row, backgroundIntensity: background.intensity, backgroundSd: background.sd, backgroundLabel: background.label, correctedMean, corrected, snr, globalBackground, boundary, quality, analysisExcluded };
    });
    const reference = preliminary.find(row => row.id === wb.referenceId && row.type === 'band' && !row.analysisExcluded);
    const refCorrected = reference?.corrected;
    return preliminary.map(row => ({ ...row, normalized: row.type === 'band' && !row.analysisExcluded && Number.isFinite(refCorrected) && refCorrected !== 0 ? row.corrected / refCorrected : NaN }));
  }

  function wbLaneProfile(roi) {
    if (!wb.imageCtx || !roi) return [];
    const x = clamp(Math.round(roi.x), 0, Math.max(0, canvas.width - 1));
    const width = clamp(Math.round(roi.width), 1, Math.max(1, canvas.width - x));
    const data = wb.source?.raw?.values ? null : wb.imageCtx.getImageData(x, 0, width, canvas.height).data;
    const invert = $('#invertIntensity').checked;
    const maximum = wb.source?.raw?.maxValue || 255;
    const values = Array.from({ length: canvas.height }, (_, y) => {
      let total = 0;
      for (let offsetX = 0; offsetX < width; offsetX += 1) {
        let gray;
        if (wb.source?.raw?.values) gray = wb.source.raw.values[y * canvas.width + x + offsetX];
        else {
          const offset = (y * width + offsetX) * 4;
          gray = 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
        }
        total += invert ? maximum - gray : gray;
      }
      return total / width;
    });
    return movingAverage(values, Math.max(1, Math.round(canvas.height / 300)));
  }

  function drawWbProfile(rows = wbRowsWithMetrics()) {
    const bands = rows.filter(row => row.type === 'band').sort((a, b) => (a.x + a.width / 2) - (b.x + b.width / 2));
    if (!bands.some(row => row.id === wb.profileRoiId)) wb.profileRoiId = bands[0]?.id || '';
    const select = $('#wbProfileSelect');
    select.innerHTML = bands.length ? bands.map((row, index) => `<option value="${row.id}" ${row.id === wb.profileRoiId ? 'selected' : ''}>${index + 1}. ${escapeHtml(row.name)}${row.group ? ` · ${escapeHtml(row.group)}` : ''}</option>`).join('') : '<option value="">等待条带 ROI</option>';
    wbProfileCtx.clearRect(0, 0, wbProfileCanvas.width, wbProfileCanvas.height);
    wbProfileCtx.fillStyle = '#0b1429';
    wbProfileCtx.fillRect(0, 0, wbProfileCanvas.width, wbProfileCanvas.height);
    const row = bands.find(item => item.id === wb.profileRoiId);
    if (!row || !wb.image) {
      wbProfileCtx.fillStyle = '#8fa4cb';
      wbProfileCtx.font = '15px sans-serif';
      wbProfileCtx.fillText('载入图片并选择条带后显示泳道曲线', 42, wbProfileCanvas.height / 2);
      $('#wbProfileSummary').textContent = '载入图片并选择条带后显示曲线。';
      return;
    }
    const values = wbLaneProfile(row);
    const low = Math.min(0, percentile(values, 0.02) || 0);
    const high = Math.max(low + 1, percentile(values, 0.995) || Math.max(...values));
    const margin = { left: 58, right: 24, top: 22, bottom: 42 };
    const plotWidth = wbProfileCanvas.width - margin.left - margin.right;
    const plotHeight = wbProfileCanvas.height - margin.top - margin.bottom;
    const sourceToX = sourceY => margin.left + sourceY / Math.max(1, canvas.height - 1) * plotWidth;
    const valueToY = value => margin.top + (high - value) / Math.max(1, high - low) * plotHeight;
    wbProfileCtx.fillStyle = 'rgba(75, 139, 238, .18)';
    wbProfileCtx.fillRect(sourceToX(row.y), margin.top, Math.max(2, sourceToX(row.y + row.height) - sourceToX(row.y)), plotHeight);
    wbProfileCtx.strokeStyle = '#26375e';
    wbProfileCtx.lineWidth = 1;
    for (let index = 0; index <= 4; index += 1) {
      const y = margin.top + plotHeight * index / 4;
      wbProfileCtx.beginPath(); wbProfileCtx.moveTo(margin.left, y); wbProfileCtx.lineTo(margin.left + plotWidth, y); wbProfileCtx.stroke();
    }
    if (Number.isFinite(row.backgroundIntensity)) {
      wbProfileCtx.strokeStyle = '#e8b350';
      wbProfileCtx.setLineDash([7, 5]);
      const backgroundY = valueToY(row.backgroundIntensity);
      wbProfileCtx.beginPath(); wbProfileCtx.moveTo(margin.left, backgroundY); wbProfileCtx.lineTo(margin.left + plotWidth, backgroundY); wbProfileCtx.stroke();
      wbProfileCtx.setLineDash([]);
    }
    wbProfileCtx.strokeStyle = '#67c9ff';
    wbProfileCtx.lineWidth = 2.2;
    wbProfileCtx.beginPath();
    values.forEach((value, index) => {
      const x = sourceToX(index);
      const y = valueToY(value);
      if (index === 0) wbProfileCtx.moveTo(x, y); else wbProfileCtx.lineTo(x, y);
    });
    wbProfileCtx.stroke();
    const centerX = sourceToX(row.y + row.height / 2);
    wbProfileCtx.strokeStyle = '#ff8aa0';
    wbProfileCtx.lineWidth = 1.5;
    wbProfileCtx.beginPath(); wbProfileCtx.moveTo(centerX, margin.top); wbProfileCtx.lineTo(centerX, margin.top + plotHeight); wbProfileCtx.stroke();
    wbProfileCtx.fillStyle = '#b8c7e5';
    wbProfileCtx.font = '12px sans-serif';
    wbProfileCtx.fillText('图像纵向位置 (px)', margin.left + plotWidth / 2 - 50, wbProfileCanvas.height - 10);
    wbProfileCtx.save();
    wbProfileCtx.translate(15, margin.top + plotHeight / 2 + 36);
    wbProfileCtx.rotate(-Math.PI / 2);
    wbProfileCtx.fillText('平均信号强度', 0, 0);
    wbProfileCtx.restore();
    wbProfileCtx.fillText('0', margin.left - 4, wbProfileCanvas.height - 22);
    wbProfileCtx.fillText(String(canvas.height - 1), margin.left + plotWidth - 24, wbProfileCanvas.height - 22);
    $('#wbProfileSummary').innerHTML = `<b>${escapeHtml(row.name)}</b>：蓝色区域为当前 ROI，粉线为 ROI 中心，黄虚线为背景强度。点击曲线可吸附到附近峰值。当前 SNR：${fmt(row.snr, 2)}；${qcBadge(row.quality)}`;
  }

  function snapWbProfileToClick(event) {
    if (!wb.image || !wb.profileRoiId) return;
    const roi = wb.rois.find(item => item.id === wb.profileRoiId && item.type === 'band');
    if (!roi) return;
    const rect = wbProfileCanvas.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) * wbProfileCanvas.width / Math.max(1, rect.width);
    const marginLeft = 58;
    const plotWidth = wbProfileCanvas.width - marginLeft - 24;
    if (canvasX < marginLeft || canvasX > marginLeft + plotWidth) return;
    const approximateY = clamp(Math.round((canvasX - marginLeft) / plotWidth * Math.max(1, canvas.height - 1)), 0, canvas.height - 1);
    const values = wbLaneProfile(roi);
    const radius = Math.max(6, Math.round(Math.max(roi.height * 1.8, canvas.height * 0.035)));
    const start = Math.max(0, approximateY - radius);
    const end = Math.min(values.length - 1, approximateY + radius);
    let peakY = approximateY;
    for (let y = start; y <= end; y += 1) if (values[y] > values[peakY]) peakY = y;
    pushHistory('曲线峰值吸附');
    roi.y = clamp(Math.round(peakY - roi.height / 2), 0, Math.max(0, canvas.height - roi.height));
    roi.auto = false;
    roi.manualAdjusted = true;
    delete roi.confidence;
    updateWb();
    toastMessage(`${roi.name} 已吸附到纵向峰值 y=${peakY}px。`);
  }

  function updateWb() {
    drawWb();
    const rows = wbRowsWithMetrics();
    const reference = $('#wbReference');
    const previous = wb.referenceId;
    reference.innerHTML = '<option value="">未选择</option>' + rows.filter(row => row.type === 'band').map(row => `<option value="${row.id}" ${row.id === previous ? 'selected' : ''} ${row.analysisExcluded ? 'disabled' : ''}>${escapeHtml(row.name)}${row.auto ? '（自动）' : ''}${row.group ? ` · ${escapeHtml(row.group)}` : ''}${row.analysisExcluded ? ' · 已排除' : ''}</option>`).join('');
    if (previous && !rows.some(row => row.id === previous)) wb.referenceId = '';
    const body = $('#wbResultsBody');
    body.innerHTML = rows.length ? rows.map(row => `<tr data-wb-row="${row.id}" class="${row.id === wb.selectedId ? 'selected-row' : ''} ${row.analysisExcluded ? 'excluded-row' : ''}"><td>${row.type === 'band' ? `<input class="wb-use-check" data-wb-use="${row.id}" type="checkbox" ${row.analysisExcluded ? '' : 'checked'} title="是否纳入分析" />` : ''}<span class="roi-kind ${row.type}">${row.type === 'background' ? '背景' : '条带'}</span></td><td>${row.auto ? `<span class="auto-badge">自动${row.confidence ? ` · 信号 ${row.confidence}` : ''}</span>` : '手动'}</td><td><input class="wb-inline-input" data-wb-field="name" data-wb-id="${row.id}" value="${escapeHtml(row.name)}" /></td><td><input class="wb-inline-input" data-wb-field="group" data-wb-id="${row.id}" value="${escapeHtml(row.group || '')}" placeholder="手动填写" /></td><td><div class="wb-position-edit">${['x','y','width','height'].map(field => `<input data-wb-field="${field}" data-wb-id="${row.id}" type="number" min="${field === 'width' || field === 'height' ? 1 : 0}" value="${row[field]}" title="${field}" />`).join('')}</div></td><td>${row.width * row.height}</td><td>${fmt(row.intensity, 2)}</td><td>${fmt(row.integrated, 1)}</td><td>${row.type === 'band' ? `${fmt(row.backgroundIntensity, 2)}<span class="row-subtext">${escapeHtml(row.backgroundLabel)}</span>` : '—'}</td><td>${row.type === 'band' ? fmt(row.corrected, 1) : '—'}</td><td>${row.type === 'band' ? fmt(row.snr, 2) : '—'}</td><td>${row.type === 'band' ? fmt(row.normalized, 4) : '—'}</td><td>${qcBadge(row.quality)}${row.analysisExcluded ? '<span class="row-subtext">已排除</span>' : ''}</td><td>${row.type === 'band' ? `<button class="profile-roi" data-profile-roi="${row.id}">曲线</button>` : ''}<button class="delete-roi" data-delete-roi="${row.id}">删除</button></td></tr>`).join('') : '<tr class="empty-row"><td colspan="14">尚未载入图片或绘制 ROI。</td></tr>';
    const backgrounds = rows.filter(row => row.type === 'background');
    const bands = rows.filter(row => row.type === 'band');
    const issueCount = bands.filter(row => row.quality?.severity !== 'good').length;
    const geometry = core.roiConsistency(bands, 0.1);
    const backgroundNames = { global: '全局平均', nearest: '最近 ROI', side: '左右局部', plane: '二维平面' };
    $('#wbQuickStats').innerHTML = `<div class="quick-stat"><b>${backgrounds.length}</b><span>背景 ROI</span></div><div class="quick-stat"><b>${bands.length}</b><span>条带 ROI</span></div><div class="quick-stat"><b>${backgrounds.length ? fmt(mean(backgrounds.map(row => row.intensity)), 2) : '—'}</b><span>背景平均强度</span></div><div class="quick-stat"><b>${backgroundNames[wb.backgroundMode] || '全局平均'}</b><span>当前扣除方法</span></div><div class="quick-stat"><b>${issueCount}</b><span>需复核条带</span></div><div class="quick-stat"><b>${geometry.consistent ? '一致' : geometry.outlierIndexes.length}</b><span>${geometry.consistent ? 'ROI 尺寸检查' : '尺寸偏差 >10%'}</span></div>`;
    $$('[data-profile-roi]').forEach(button => button.addEventListener('click', () => { wb.profileRoiId = button.dataset.profileRoi; drawWbProfile(rows); $('#wbProfilePanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }));
    $$('[data-wb-row]').forEach(rowElement => rowElement.addEventListener('click', event => { if (event.target.matches('input,button')) return; wb.selectedId = rowElement.dataset.wbRow; updateWb(); }));
    $$('[data-wb-field]').forEach(input => input.addEventListener('change', event => {
      const roi = wb.rois.find(item => item.id === event.target.dataset.wbId);
      if (!roi) return;
      pushHistory('手动编辑 ROI');
      const field = event.target.dataset.wbField;
      if (field === 'name' || field === 'group') roi[field] = event.target.value.trim();
      else {
        const numeric = Math.round(number(event.target.value, roi[field]));
        const maximum = field === 'x' || field === 'width' ? canvas.width : canvas.height;
        roi[field] = clamp(numeric, field === 'width' || field === 'height' ? 1 : 0, maximum);
        roi.x = clamp(roi.x, 0, Math.max(0, canvas.width - roi.width));
        roi.y = clamp(roi.y, 0, Math.max(0, canvas.height - roi.height));
      }
      roi.auto = false; delete roi.confidence;
      wb.selectedId = roi.id;
      recordAudit('wb-roi-edited', { id: roi.id, field, value: roi[field] });
      updateWb();
    }));
    $$('[data-wb-use]').forEach(input => input.addEventListener('change', event => {
      const roi = wb.rois.find(item => item.id === event.target.dataset.wbUse);
      if (!roi) return;
      pushHistory('更改 ROI 纳入状态');
      roi.excluded = !event.target.checked;
      roi.forceInclude = event.target.checked;
      updateWb();
    }));
    $$('[data-delete-roi]').forEach(button => button.addEventListener('click', () => {
      pushHistory('删除 ROI');
      wb.rois = wb.rois.filter(roi => roi.id !== button.dataset.deleteRoi);
      if (wb.referenceId === button.dataset.deleteRoi) wb.referenceId = '';
      if (wb.profileRoiId === button.dataset.deleteRoi) wb.profileRoiId = '';
      if (wb.selectedId === button.dataset.deleteRoi) wb.selectedId = '';
      recordAudit('wb-roi-deleted', { id: button.dataset.deleteRoi });
      updateWb();
    }));
    drawWbProfile(rows);
  }

  async function loadWbImage(file) {
    if (!file) return;
    pushHistory('载入 WB 图像');
    try {
      const { image, source } = await decodeSourceFile(file);
      wb.image = image;
      wb.source = source;
      wb.fileName = file.name;
      wb.rois = [];
      wb.referenceId = '';
      wb.profileRoiId = '';
      wb.selectedId = '';
      wb.nextId = 1;
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      wb.imageCtx = analysisContextForImage(image);
      $('#wbEmptyState').classList.add('hide');
      $('#wbSourceMeta').textContent = sourceMetaText(source);
      $('#wbSourceMeta').className = `source-integrity ${source.warnings.length ? 'warn' : 'good'}`;
      updateWb();
      recordAudit('wb-image-loaded', { fileName: file.name, sha256: source.sha256, width: source.width, height: source.height, bitDepth: source.bitDepth, format: source.format });
      toastMessage(`已载入图片：${file.name}（${source.width} × ${source.height}px，${source.bitDepth}-bit）`);
    } catch (error) {
      console.error(error);
      toastMessage(`图片读取失败：${error.message || '请尝试转换为 PNG 或 TIFF。'}`);
    }
  }

  function addRoi(rect) {
    if (rect.width < 3 || rect.height < 3) return;
    pushHistory('手动添加 ROI');
    const type = $('#roiType').value;
    const nameInput = $('#roiName');
    const name = nameInput.value.trim() || (type === 'background' ? '背景' : `条带 ${wb.nextId}`);
    const roi = { id: `roi-${wb.nextId++}`, type, name, group: $('#roiGroup').value.trim(), ...rect };
    wb.rois.push(roi);
    wb.selectedId = roi.id;
    if (type === 'band') nameInput.value = `条带 ${wb.nextId}`;
    updateWb();
    recordAudit('wb-roi-added', { id: roi.id, type, name, rect });
  }

  function deleteSelectedWbRoi() {
    if (!wb.selectedId || !wb.rois.some(roi => roi.id === wb.selectedId)) return toastMessage('请先在图中或结果表选择一个 ROI。');
    pushHistory('删除选中 ROI');
    const id = wb.selectedId;
    wb.rois = wb.rois.filter(roi => roi.id !== id);
    if (wb.referenceId === id) wb.referenceId = '';
    if (wb.profileRoiId === id) wb.profileRoiId = '';
    wb.selectedId = '';
    updateWb();
    recordAudit('wb-roi-deleted', { id });
  }

  function duplicateSelectedWbRoi() {
    const selected = wb.rois.find(roi => roi.id === wb.selectedId);
    if (!selected) return toastMessage('请先选择一个 ROI。');
    pushHistory('复制 ROI');
    const offset = Math.max(4, Math.round(Math.min(selected.width, selected.height) * 0.2));
    const copy = {
      ...cloneData(selected), id: `roi-${wb.nextId++}`, name: `${selected.name} 副本`, auto: false,
      x: clamp(selected.x + offset, 0, Math.max(0, canvas.width - selected.width)),
      y: clamp(selected.y + offset, 0, Math.max(0, canvas.height - selected.height)),
    };
    delete copy.confidence;
    wb.rois.push(copy);
    wb.selectedId = copy.id;
    updateWb();
    recordAudit('wb-roi-duplicated', { from: selected.id, to: copy.id });
  }

  function equalizeBandRois() {
    const bands = wb.rois.filter(roi => roi.type === 'band');
    if (bands.length < 2) return toastMessage('至少需要 2 个条带 ROI 才能统一尺寸。');
    pushHistory('统一条带 ROI 尺寸');
    const selected = bands.find(roi => roi.id === wb.selectedId);
    const width = selected?.width || Math.round(percentile(bands.map(roi => roi.width), 0.5));
    const height = selected?.height || Math.round(percentile(bands.map(roi => roi.height), 0.5));
    bands.forEach(roi => {
      const centerX = roi.x + roi.width / 2;
      const centerY = roi.y + roi.height / 2;
      roi.width = clamp(width, 1, canvas.width);
      roi.height = clamp(height, 1, canvas.height);
      roi.x = clamp(Math.round(centerX - roi.width / 2), 0, Math.max(0, canvas.width - roi.width));
      roi.y = clamp(Math.round(centerY - roi.height / 2), 0, Math.max(0, canvas.height - roi.height));
      roi.auto = false;
      delete roi.confidence;
    });
    updateWb();
    recordAudit('wb-rois-equalized', { count: bands.length, width, height });
    toastMessage(`已统一 ${bands.length} 个条带 ROI 为 ${width} × ${height}px。`);
  }

  function nudgeSelectedWbRoi(dx, dy, resize = false) {
    const roi = wb.rois.find(item => item.id === wb.selectedId);
    if (!roi) return;
    pushHistory(resize ? '键盘调整 ROI 尺寸' : '键盘移动 ROI');
    if (resize) {
      roi.width = clamp(roi.width + dx, 1, canvas.width - roi.x);
      roi.height = clamp(roi.height + dy, 1, canvas.height - roi.y);
    } else {
      roi.x = clamp(roi.x + dx, 0, Math.max(0, canvas.width - roi.width));
      roi.y = clamp(roi.y + dy, 0, Math.max(0, canvas.height - roi.height));
    }
    roi.auto = false; delete roi.confidence;
    updateWb();
  }

  function exportWb() {
    const header = ['Type', 'Source', 'Name', 'Group', 'X', 'Y', 'Width', 'Height', 'Area px2', 'Mean intensity', 'Intensity SD', 'Integrated intensity', 'Saturated fraction', 'Background method', 'Background intensity', 'Background SD', 'Background corrected', 'SNR', 'Normalized', 'QC'];
    const values = wbRowsWithMetrics().map(row => [row.type, row.auto ? `auto${row.confidence ? ` (signal score ${row.confidence})` : ''}` : 'manual', row.name, row.group, row.x, row.y, row.width, row.height, row.width * row.height, row.intensity, row.intensitySd, row.integrated, row.saturatedFraction, row.backgroundLabel, row.backgroundIntensity, row.backgroundSd, row.corrected, row.snr, row.normalized, row.quality?.text]);
    if (!values.length) return toastMessage('请先载入 WB 图片并至少框选一个 ROI。');
    downloadText('western-blot-densitometry.csv', [header, ...values].map(row => row.map(csvCell).join(',')).join('\n'));
    toastMessage('WB 灰度结果 CSV 已开始下载。');
  }

  function clearWb() {
    pushHistory('清空 WB 工作区');
    wb.image = null; wb.fileName = ''; wb.imageCtx = null; wb.source = null; wb.rois = []; wb.referenceId = ''; wb.profileRoiId = ''; wb.selectedId = ''; wb.drawing = null; wb.tempROI = null;
    canvas.width = 0; canvas.height = 0;
    $('#wbImageInput').value = '';
    $('#wbEmptyState').classList.remove('hide');
    $('#wbSourceMeta').textContent = '尚未载入原始图像';
    $('#wbSourceMeta').className = 'source-integrity';
    $('#autoDetectionNote').textContent = '建议先裁去图片边缘、文字或标尺，再运行自动识别；预期泳道数仅用于辅助弱带补全。';
    updateWb();
    recordAudit('wb-workspace-cleared');
  }

  function pairCanvasPoint(pane, event) {
    const rect = pane.canvas.getBoundingClientRect();
    return {
      x: clamp(Math.round((event.clientX - rect.left) * pane.canvas.width / rect.width), 0, pane.canvas.width),
      y: clamp(Math.round((event.clientY - rect.top) * pane.canvas.height / rect.height), 0, pane.canvas.height)
    };
  }

  function drawPairRoi(pane, roi, temporary = false) {
    const color = pane.key === 'reference' ? '#7957d5' : '#0d8e91';
    const context = pane.ctx;
    context.save();
    context.lineWidth = Math.max(2, pane.canvas.width / 650);
    context.strokeStyle = color;
    context.fillStyle = pane.key === 'reference' ? 'rgba(121, 87, 213, .15)' : 'rgba(13, 142, 145, .15)';
    if (temporary || roi.auto) context.setLineDash(roi.auto ? [6, 4] : [8, 6]);
    context.fillRect(roi.x, roi.y, roi.width, roi.height);
    context.strokeRect(roi.x, roi.y, roi.width, roi.height);
    context.setLineDash([]);
    const label = roi.name || `泳道 ${roi.lane || ''}`;
    context.font = `${Math.max(13, pane.canvas.width / 56)}px sans-serif`;
    const labelHeight = Math.max(20, pane.canvas.width / 35);
    const labelY = Math.max(0, roi.y - labelHeight);
    context.fillStyle = color;
    context.fillRect(roi.x, labelY, context.measureText(label).width + 12, labelHeight);
    context.fillStyle = '#fff';
    context.fillText(label, roi.x + 6, labelY + Math.max(15, pane.canvas.width / 47));
    context.restore();
  }

  function renderPairPane(pane) {
    if (!pane.image) { pane.canvas.width = 0; pane.canvas.height = 0; return; }
    pane.ctx.clearRect(0, 0, pane.canvas.width, pane.canvas.height);
    pane.ctx.drawImage(pane.image, 0, 0, pane.canvas.width, pane.canvas.height);
    pane.rois.forEach(roi => drawPairRoi(pane, roi));
    if (pane.tempROI) drawPairRoi(pane, pane.tempROI, true);
  }

  function pairSignalMap(pane, maxSide = 900) {
    const scale = Math.max(1, Math.ceil(Math.max(pane.canvas.width, pane.canvas.height) / maxSide));
    const width = Math.ceil(pane.canvas.width / scale);
    const height = Math.ceil(pane.canvas.height / scale);
    const sourcePixels = pane.source?.raw?.values ? null : pane.imageCtx.getImageData(0, 0, pane.canvas.width, pane.canvas.height).data;
    const signal = new Float32Array(width * height);
    const maximum = pane.source?.raw?.maxValue || 255;
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(pane.canvas.height - 1, y * scale);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(pane.canvas.width - 1, x * scale);
        let grayscale;
        if (pane.source?.raw?.values) grayscale = pane.source.raw.values[sourceY * pane.canvas.width + sourceX];
        else {
          const offset = (sourceY * pane.canvas.width + sourceX) * 4;
          grayscale = 0.299 * sourcePixels[offset] + 0.587 * sourcePixels[offset + 1] + 0.114 * sourcePixels[offset + 2];
        }
        signal[y * width + x] = maximum - grayscale;
      }
    }
    return { signal, width, height, scale };
  }

  function pairRoiMeasurement(pane, roi) {
    return regionMeasurement(pane.source, pane.imageCtx, roi, true);
  }

  function pairLocalBackground(pane, roi) {
    const gap = Math.max(2, Math.round(roi.height * 0.35));
    const stripHeight = Math.max(3, Math.round(roi.height * 0.8));
    const x0 = clamp(roi.x, 0, pane.canvas.width - 1);
    const x1 = clamp(roi.x + roi.width, x0 + 1, pane.canvas.width);
    const regions = [];
    if (roi.y - gap - stripHeight >= 0) regions.push({ y0: roi.y - gap - stripHeight, y1: roi.y - gap });
    if (roi.y + roi.height + gap + stripHeight <= pane.canvas.height) regions.push({ y0: roi.y + roi.height + gap, y1: roi.y + roi.height + gap + stripHeight });
    if (!regions.length) return { intensity: 0, sd: NaN, count: 0, available: false };
    const values = regions.flatMap(region => regionIntensityValues(pane.source, pane.imageCtx, { x: x0, y: region.y0, width: x1 - x0, height: region.y1 - region.y0 }, true));
    const stats = robustStats(values);
    return { ...stats, count: values.length };
  }

  function pairBandRows(pane) {
    return [...pane.rois].sort((a, b) => (a.lane || Number.MAX_SAFE_INTEGER) - (b.lane || Number.MAX_SAFE_INTEGER) || (a.x + a.width / 2) - (b.x + b.width / 2)).map((roi, index) => {
      const measurement = pairRoiMeasurement(pane, roi);
      const useBackground = $('#pairAutoBackground').checked;
      const background = useBackground ? pairLocalBackground(pane, roi) : { intensity: 0, sd: NaN, count: 0, available: false };
      const correctedMean = measurement.intensity - background.intensity;
      const corrected = Math.max(0, correctedMean * roi.width * roi.height);
      const snr = background.available ? correctedMean / Math.max(background.sd || 0, 1) : NaN;
      const touchesEdge = roi.x <= 1 || roi.y <= 1 || roi.x + roi.width >= pane.canvas.width - 1 || roi.y + roi.height >= pane.canvas.height - 1;
      const boundary = core.signalBoundaryQuality(horizontalSignalProfile(pane.source, pane.imageCtx, roi, true));
      const quality = bandQuality({ saturatedFraction: measurement.saturatedFraction, corrected, snr, backgroundAvailable: background.available, touchesEdge, confidence: roi.confidence, boundary, edgeConfidence: roi.edgeConfidence, edgeClipped: roi.edgeClipped });
      return { ...roi, lane: roi.lane || index + 1, ...measurement, background: background.intensity, backgroundSd: background.sd, correctedMean, corrected, snr, boundary, quality };
    });
  }

  function pairResultRows() {
    const references = pair.reference.image ? pairBandRows(pair.reference) : [];
    const targets = pair.target.image ? pairBandRows(pair.target) : [];
    const byLane = new Map();
    [...references, ...targets].forEach(row => { if (!byLane.has(row.lane)) byLane.set(row.lane, {}); });
    references.forEach(row => { byLane.get(row.lane).reference = row; });
    targets.forEach(row => { byLane.get(row.lane).target = row; });
    const rows = [...byLane.entries()].sort(([a], [b]) => Number(a) - Number(b)).map(([lane, values]) => ({ ...values, lane: Number(lane), ratio: values.target && values.reference && values.reference.corrected > 0 ? values.target.corrected / values.reference.corrected : NaN }));
    if (!rows.some(row => String(row.lane) === pair.baseline) && rows.length) pair.baseline = String(rows[0].lane);
    const baselineRow = rows.find(row => String(row.lane) === pair.baseline);
    const baselineRatio = baselineRow?.ratio;
    const baselineReference = baselineRow?.reference?.corrected;
    return rows.map(row => {
      const currentLoad = number(pair.loads[row.lane], pair.defaultLoadVolume);
      const targetQuality = row.target?.quality;
      const referenceQuality = row.reference?.quality;
      const baselineReferenceUsable = baselineRow?.reference?.quality?.severity !== 'bad';
      const referenceUsable = referenceQuality?.severity !== 'bad';
      const suggestedLoad = baselineReferenceUsable && referenceUsable
        ? core.suggestedLoadVolume(currentLoad, baselineReference, row.reference?.corrected)
        : NaN;
      const missing = !row.target || !row.reference;
      const severities = [targetQuality?.severity, referenceQuality?.severity];
      const quality = missing
        ? { severity: 'bad', text: '配对缺失' }
        : {
          severity: severities.includes('bad') ? 'bad' : severities.includes('warn') ? 'warn' : 'good',
          text: targetQuality?.severity === 'good' && referenceQuality?.severity === 'good' ? '通过' : `目的：${targetQuality?.text || '缺失'}；内参：${referenceQuality?.text || '缺失'}`,
        };
      return {
        ...row,
        relative: Number.isFinite(row.ratio) && Number.isFinite(baselineRatio) && baselineRatio !== 0 ? row.ratio / baselineRatio : NaN,
        currentLoad,
        suggestedLoad,
        quality,
      };
    });
  }

  function renderPairResults() {
    renderPairPane(pair.reference);
    renderPairPane(pair.target);
    const rows = pairResultRows();
    const baseline = $('#pairBaseline');
    baseline.innerHTML = rows.length ? rows.map(row => `<option value="${row.lane}" ${String(row.lane) === pair.baseline ? 'selected' : ''}>泳道 ${row.lane}</option>`).join('') : '<option value="">等待 ROI</option>';
    $('#pairResultsBody').innerHTML = rows.length ? rows.map(row => `<tr><td>${row.lane}${String(row.lane) === pair.baseline ? ' <span class="pair-baseline">基准</span>' : ''}</td><td>${row.target ? fmt(row.target.corrected, 1) : '—'}</td><td>${row.reference ? fmt(row.reference.corrected, 1) : '—'}</td><td>${fmt(row.ratio, 4)}</td><td><b>${fmt(row.relative, 4)}×</b></td><td><input class="pair-load-input" data-pair-load="${row.lane}" type="number" min="0.01" step="0.1" value="${Number.isFinite(row.currentLoad) ? row.currentLoad : ''}" aria-label="泳道 ${row.lane} 当前上样量" /></td><td><b>${fmt(row.suggestedLoad, 2)}</b></td><td>${qcBadge(row.quality)}</td></tr>`).join('') : '<tr><td colspan="8">请先载入两张图片并框选条带。</td></tr>';
    const issueCount = rows.filter(row => row.quality?.severity !== 'good').length;
    const referenceGeometry = core.roiConsistency(pair.reference.rois.filter(roi => roi.type === 'band'), 0.1);
    const targetGeometry = core.roiConsistency(pair.target.rois.filter(roi => roi.type === 'band'), 0.1);
    const geometryIssues = referenceGeometry.outlierIndexes.length + targetGeometry.outlierIndexes.length;
    $('#pairQuickStats').innerHTML = `<div><b>${pair.target.rois.length}</b><span>目的蛋白条带</span></div><div><b>${pair.reference.rois.length}</b><span>内参条带</span></div><div><b>${issueCount}</b><span>需复核泳道</span></div><div><b>${geometryIssues || '一致'}</b><span>ROI 尺寸检查</span></div>`;
    const baselineRow = rows.find(row => String(row.lane) === pair.baseline);
    $('#pairCalibrationNote').textContent = baselineRow?.reference?.quality?.severity === 'bad'
      ? `基准泳道 ${pair.baseline} 的内参存在“${baselineRow.reference.quality.text}”，已暂停生成建议上样量；请更换合格基准或重新曝光。`
      : '建议量仅适用于内参未饱和、灰度与上样量在线性范围内且样品浓度可比的情况。';
    $$('[data-pair-load]').forEach(input => input.addEventListener('change', event => {
      const value = number(event.target.value, NaN);
      const lane = event.target.dataset.pairLoad;
      if (Number.isFinite(value) && value > 0) pair.loads[lane] = value;
      else delete pair.loads[lane];
      renderPairResults();
    }));
  }

  async function loadPairImage(key, file) {
    if (!file) return;
    const pane = pair[key];
    pushHistory(`载入${pane.label}图像`);
    try {
        const { image, source } = await decodeSourceFile(file);
        pane.image = image;
        pane.source = source;
        pane.fileName = file.name;
        pane.rois = [];
        pane.nextId = 1;
        pane.drawing = null;
        pane.tempROI = null;
        pane.canvas.width = image.naturalWidth;
        pane.canvas.height = image.naturalHeight;
        pane.imageCtx = analysisContextForImage(image);
        pair.loads = {};
        $(`#pair${key === 'reference' ? 'Reference' : 'Target'}Empty`).classList.add('hide');
        $(`#pair${key === 'reference' ? 'Reference' : 'Target'}Meta`).textContent = sourceMetaText(source);
        renderPairResults();
        recordAudit('pair-image-loaded', { pane: key, fileName: file.name, sha256: source.sha256, bitDepth: source.bitDepth });
        toastMessage(`已载入${pane.label}图片：${file.name}`);
    } catch (error) {
      console.error(error);
      toastMessage(`图片读取失败：${error.message || '请尝试转换为 PNG 或 TIFF。'}`);
    }
  }

  function addPairRoi(pane, rect) {
    if (rect.width < 3 || rect.height < 3) return;
    pushHistory(`手动添加${pane.label} ROI`);
    const lane = pane.rois.length + 1;
    pane.rois.push({ id: `pair-${pane.key}-${pane.nextId++}`, name: `泳道 ${lane}`, lane, auto: false, ...rect });
    renderPairResults();
    recordAudit('pair-roi-added', { pane: pane.key, lane, rect });
  }

  function autoPairRois(key) {
    const pane = pair[key];
    if (!pane.image) return toastMessage(`请先载入${pane.label}图片。`);
    pushHistory(`${pane.label}自动识别 ROI`);
    const expectedLanes = clamp(Math.round(number($('#pairLaneCount').value, 0)), 0, 96);
    const detection = findBandCandidatesFromMap(pairSignalMap(pane), pane.canvas.width, pane.canvas.height, number($('#pairSensitivity').value, 75), expectedLanes, 5, 0, number($('#pairMarkerPercent').value, 0));
    const strongestByLane = new Map();
    detection.candidates.sort((a, b) => b.score - a.score).forEach(candidate => {
      if (!strongestByLane.has(candidate.laneIndex)) strongestByLane.set(candidate.laneIndex, candidate);
    });
    const strongest = [...strongestByLane.values()].sort((a, b) => a.laneIndex - b.laneIndex);
    const completed = supplementExpectedLaneCandidates(strongest, expectedLanes, pane.canvas.width, pane.canvas.height);
    pane.rois = completed.map(candidate => {
      const lane = candidate.laneIndex + 1;
      return { id: `pair-${pane.key}-${pane.nextId++}`, name: `泳道 ${lane}`, lane, auto: true, confidence: Math.round(candidate.score * 100), ...candidate };
    });
    renderPairResults();
    toastMessage(`${pane.label}已自动推荐 ${pane.rois.length} 个泳道 ROI，请逐项确认。`);
  }

  function copyPairRois(fromKey) {
    const source = pair[fromKey];
    const target = pair[fromKey === 'reference' ? 'target' : 'reference'];
    if (!source.image || !source.rois.length) return toastMessage(`请先在${source.label}图上框选至少一个条带。`);
    if (!target.image) return toastMessage(`请先载入${target.label}图片，再复制 ROI。`);
    pushHistory(`复制${source.label} ROI 到${target.label}`);
    const scaleX = target.canvas.width / source.canvas.width;
    const scaleY = target.canvas.height / source.canvas.height;
    target.rois = source.rois.map(roi => ({
      id: `pair-${target.key}-${target.nextId++}`,
      name: roi.name,
      lane: roi.lane,
      auto: roi.auto,
      confidence: roi.confidence,
      x: clamp(Math.round(roi.x * scaleX), 0, target.canvas.width - 1),
      y: clamp(Math.round(roi.y * scaleY), 0, target.canvas.height - 1),
      width: clamp(Math.round(roi.width * scaleX), 1, target.canvas.width),
      height: clamp(Math.round(roi.height * scaleY), 1, target.canvas.height)
    }));
    renderPairResults();
    toastMessage(`已将 ${source.label}的 ${target.rois.length} 个 ROI 同步复制到${target.label}。`);
  }

  function clearPairSide(key) {
    if (pair[key].rois.length) pushHistory(`清空${pair[key].label} ROI`);
    pair[key].rois = [];
    renderPairResults();
  }

  function clearPairWorkspace() {
    pushHistory('清空双图工作区');
    ['reference', 'target'].forEach(key => {
      const pane = pair[key];
      pane.image = null; pane.fileName = ''; pane.imageCtx = null; pane.source = null; pane.rois = []; pane.drawing = null; pane.tempROI = null; pane.nextId = 1;
      pane.canvas.width = 0; pane.canvas.height = 0;
      $(`#pair${key === 'reference' ? 'Reference' : 'Target'}Input`).value = '';
      $(`#pair${key === 'reference' ? 'Reference' : 'Target'}Empty`).classList.remove('hide');
      $(`#pair${key === 'reference' ? 'Reference' : 'Target'}Meta`).textContent = '尚未载入图片';
    });
    pair.baseline = '';
    pair.loads = {};
    renderPairResults();
    toastMessage('已清空双图分析工作区。');
  }

  function exportPairWb() {
    const rows = pairResultRows();
    if (!rows.length) return toastMessage('请先载入双图并框选条带。');
    const header = ['Lane', 'Target corrected integrated intensity', 'Target SNR', 'Target saturated fraction', 'Reference corrected integrated intensity', 'Reference SNR', 'Reference saturated fraction', 'Target / Reference', 'Relative expression', 'Current load volume uL', 'Suggested load volume uL', 'Baseline lane', 'QC'];
    const values = rows.map(row => [row.lane, row.target?.corrected, row.target?.snr, row.target?.saturatedFraction, row.reference?.corrected, row.reference?.snr, row.reference?.saturatedFraction, row.ratio, row.relative, row.currentLoad, row.suggestedLoad, pair.baseline, row.quality?.text]);
    downloadText('western-blot-dual-normalization.csv', [header, ...values].map(row => row.map(csvCell).join(',')).join('\n'));
    toastMessage('双图归一化 CSV 已开始下载。');
  }

  function bindPairCanvas(pane) {
    pane.canvas.addEventListener('pointerdown', event => {
      if (!pane.image) return;
      pane.canvas.setPointerCapture(event.pointerId);
      pane.drawing = pairCanvasPoint(pane, event);
      pane.tempROI = { ...pane.drawing, width: 1, height: 1, name: `泳道 ${pane.rois.length + 1}` };
      renderPairPane(pane);
    });
    pane.canvas.addEventListener('pointermove', event => {
      if (!pane.drawing) return;
      pane.tempROI = { ...normalizedRect(pane.drawing, pairCanvasPoint(pane, event)), name: `泳道 ${pane.rois.length + 1}` };
      renderPairPane(pane);
    });
    const finish = event => {
      if (!pane.drawing) return;
      const rect = normalizedRect(pane.drawing, pairCanvasPoint(pane, event));
      pane.drawing = null;
      pane.tempROI = null;
      addPairRoi(pane, rect);
    };
    pane.canvas.addEventListener('pointerup', finish);
    pane.canvas.addEventListener('pointercancel', () => { pane.drawing = null; pane.tempROI = null; renderPairPane(pane); });
  }

  function parseFigureList(value) {
    return String(value ?? '').split(/[\n,，;；\t]+/).map(item => item.trim()).filter(Boolean);
  }

  function parseFigureGroups(value) {
    return String(value ?? '').split(/[\n;；]+/).map(line => {
      const match = line.trim().match(/^(.+?)\s*[:：]\s*(\d+)\s*[-–—~至]\s*(\d+)$/);
      if (!match) return null;
      return { label: match[1].trim(), start: Math.max(1, Number(match[2])), end: Math.max(1, Number(match[3])) };
    }).filter(Boolean);
  }

  function figureSignalMap(image, maxSide = 900) {
    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    const scale = Math.max(1, Math.ceil(Math.max(sourceWidth, sourceHeight) / maxSide));
    const width = Math.ceil(sourceWidth / scale);
    const height = Math.ceil(sourceHeight / scale);
    const sourceCanvas = document.createElement('canvas');
    sourceCanvas.width = sourceWidth;
    sourceCanvas.height = sourceHeight;
    const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
    sourceCtx.drawImage(image, 0, 0, sourceWidth, sourceHeight);
    const source = sourceCtx.getImageData(0, 0, sourceWidth, sourceHeight).data;
    const signal = new Float32Array(width * height);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(sourceHeight - 1, y * scale);
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(sourceWidth - 1, x * scale);
        const offset = (sourceY * sourceWidth + sourceX) * 4;
        signal[y * width + x] = 255 - (0.299 * source[offset] + 0.587 * source[offset + 1] + 0.114 * source[offset + 2]);
      }
    }
    return { signal, width, height, scale };
  }

  function figureLaneCandidates(entry, expectedCount) {
    const sourceWidth = entry.image.naturalWidth || entry.image.width;
    const sourceHeight = entry.image.naturalHeight || entry.image.height;
    const detection = findBandCandidatesFromMap(figureSignalMap(entry.image), sourceWidth, sourceHeight, 65, expectedCount, 5, 0, number($('#figureMarkerPercent').value, 0));
    const strongestByLane = new Map();
    detection.candidates.sort((a, b) => b.score - a.score).forEach(candidate => {
      if (!strongestByLane.has(candidate.laneIndex)) strongestByLane.set(candidate.laneIndex, candidate);
    });
    const strongest = [...strongestByLane.values()].sort((a, b) => a.laneIndex - b.laneIndex);
    return supplementExpectedLaneCandidates(strongest, expectedCount, sourceWidth, sourceHeight);
  }

  function renderFigurePanelInputs() {
    const host = $('#figurePanelInputs');
    if (!figure.images.length) {
      host.innerHTML = '<p class="muted">尚未上传图片。</p>';
      return;
    }
    host.innerHTML = figure.images.map((entry, index) => {
      const manualText = entry.manualCenters?.map(center => (center * 100).toFixed(1)).join(', ') || '';
      return `<div class="figure-panel-card"><strong>图 ${index + 1} · ${escapeHtml(entry.name)}</strong><label>蛋白名称<input data-figure-field="protein" data-figure-index="${index}" value="${escapeHtml(entry.protein)}" placeholder="如：α-Tubulin" /></label><label>分子量（kDa）<input data-figure-field="mass" data-figure-index="${index}" value="${escapeHtml(entry.mass)}" placeholder="如：50" /></label><label>水平角度微调（°）<input data-figure-field="rotation" data-figure-index="${index}" type="number" min="-12" max="12" step="0.1" value="${escapeHtml(entry.rotation ?? 0)}" /></label><label>手动中心位置（%）<input class="figure-center-input" data-figure-centers data-figure-index="${index}" value="${manualText}" placeholder="开启手动校正后生成；可删改重填" /></label><small>按左到右填写百分比；右键橙色点也可删除。角度微调用于修正自动水平结果。</small><small id="figureDetect-${index}">等待识别</small></div>`;
    }).join('');
  }

  function drawFigureEmptyState() {
    figureCanvas.width = 1200;
    figureCanvas.height = 420;
    figureCtx.clearRect(0, 0, figureCanvas.width, figureCanvas.height);
    figureCtx.fillStyle = '#ffffff';
    figureCtx.fillRect(0, 0, figureCanvas.width, figureCanvas.height);
    figureCtx.fillStyle = '#718096';
    figureCtx.font = '600 24px "Times New Roman", serif';
    figureCtx.textAlign = 'center';
    figureCtx.fillText('上传一张或多张 WB 图，生成统一黑框图注', figureCanvas.width / 2, figureCanvas.height / 2);
  }

  function annotationLevels(points, minimumSpacing) {
    const lastXByLevel = [];
    return points.map(point => {
      let level = lastXByLevel.findIndex(lastX => point - lastX >= minimumSpacing);
      if (level < 0) level = lastXByLevel.length;
      lastXByLevel[level] = point;
      return level;
    });
  }

  function figureExpectedLaneCount() {
    const configuredCount = clamp(Math.round(number($('#figureLaneCount').value, 0)), 0, 96);
    return configuredCount || parseFigureList($('#figureLaneNames').value).length || parseFigureList($('#figureValues').value).length;
  }

  function updateFigureEditControls() {
    $('#toggleFigureManual').textContent = figure.editing ? '完成手动校正' : '手动校正条带位置';
    $('#selectFigureGuide').disabled = !figure.editing;
    $('#addFigureGuide').disabled = !figure.editing;
    $('#deleteFigureGuide').disabled = !figure.editing || !figure.selectedGuide;
    $('#selectFigureGuide').classList.toggle('is-active', figure.editing && figure.editTool === 'select');
    $('#addFigureGuide').classList.toggle('is-active', figure.editing && figure.editTool === 'add');
    $('#figureGuideSelection').textContent = figure.selectedGuide
      ? `已选择：图 ${figure.selectedGuide.index + 1} · 泳道 ${figure.selectedGuide.centerIndex + 1}`
      : '尚未选择黄线';
    $('#figureEditHint').textContent = figure.editing
      ? (figure.editTool === 'add'
        ? '增加模式：在黑框内需要的位置单击，新增黄线并同步增加名称项；完成后自动返回选择模式。'
        : '选择模式：单击黄线选中，拖动可移动；可用“删除选中黄线”删除，并同步删除对应名称和数值。')
      : '自动识别有误时，开启手动校正；可新增、拖动或删除黄线，泳道名称与归一化数值会同步增删。';
  }

  function ensureManualCenters(entry, expectedCount) {
    if (Array.isArray(entry.manualCenters)) return;
    const sourceWidth = entry.image.naturalWidth || entry.image.width;
    entry.manualCenters = figureLaneCandidates(entry, expectedCount)
      .map(candidate => clamp((candidate.x + candidate.width / 2) / sourceWidth, 0, 1))
      .sort((a, b) => a - b);
  }

  function figureCanvasPoint(event) {
    const rect = figureCanvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * figureCanvas.width / rect.width,
      y: (event.clientY - rect.top) * figureCanvas.height / rect.height,
    };
  }

  function figureLayoutAt(point) {
    return figure.layouts.find(layout => point.x >= layout.frame.x && point.x <= layout.frame.x + layout.frame.width && point.y >= layout.frameY && point.y <= layout.frameY + layout.frame.height);
  }

  function startFigureManualEdit() {
    if (!figure.images.length) return toastMessage('请先上传 WB 图。');
    figure.editing = !figure.editing;
    if (figure.editing) figure.images.forEach(entry => ensureManualCenters(entry, figureExpectedLaneCount()));
    figure.editTool = 'select';
    figure.selectedGuide = null;
    figure.dragging = null;
    renderFigurePanelInputs();
    renderWbFigure();
    updateFigureEditControls();
  }

  function clearFigureManualEdit() {
    figure.images.forEach(entry => { delete entry.manualCenters; });
    figure.editing = false;
    figure.editTool = 'select';
    figure.selectedGuide = null;
    figure.dragging = null;
    renderFigurePanelInputs();
    renderWbFigure();
    updateFigureEditControls();
    toastMessage('已清除手动位置，恢复自动主条带定位。');
  }

  function setFigureEditTool(tool) {
    if (!figure.editing) return;
    figure.editTool = tool === 'add' ? 'add' : 'select';
    figure.dragging = null;
    updateFigureEditControls();
  }

  function syncFigureAnnotations(action, index, previousCount) {
    const names = parseFigureList($('#figureLaneNames').value);
    while (names.length < previousCount) names.push(`泳道 ${names.length + 1}`);
    const values = parseFigureList($('#figureValues').value);
    if (values.length) while (values.length < previousCount) values.push('—');
    const edited = core.editLaneAnnotations(names, values, action, index);
    $('#figureLaneNames').value = edited.names.join('\n');
    $('#figureValues').value = edited.values.join('\n');
    $('#figureLaneCount').value = edited.names.length || '';
  }

  function deleteSelectedFigureGuide() {
    const selected = figure.selectedGuide;
    const entry = selected && figure.images[selected.index];
    if (!figure.editing || !entry || !Array.isArray(entry.manualCenters) || selected.centerIndex < 0 || selected.centerIndex >= entry.manualCenters.length) {
      return toastMessage('请先单击一条黄线，再删除。');
    }
    pushHistory('删除手动泳道线');
    const previousCount = entry.manualCenters.length;
    entry.manualCenters.splice(selected.centerIndex, 1);
    syncFigureAnnotations('delete', selected.centerIndex, previousCount);
    figure.selectedGuide = null;
    renderFigurePanelInputs();
    renderWbFigure();
    toastMessage('已删除黄线及对应的泳道名称/归一化数值项。');
  }

  function bindFigureCanvas() {
    figureCanvas.addEventListener('pointerdown', event => {
      if (!figure.editing) return;
      const point = figureCanvasPoint(event);
      const layout = figureLayoutAt(point);
      if (!layout) return;
      const entry = figure.images[layout.index];
      ensureManualCenters(entry, figureExpectedLaneCount());
      const sourceX = layout.cropX + (point.x - layout.imageX) / layout.imageWidth * layout.cropWidth;
      const normalized = clamp(sourceX / layout.sourceWidth, 0, 1);
      if (figure.editTool === 'add') {
        pushHistory('增加手动泳道线');
        const previousCount = entry.manualCenters.length;
        entry.manualCenters.push(normalized);
        entry.manualCenters.sort((a, b) => a - b);
        const centerIndex = entry.manualCenters.findIndex(center => center === normalized);
        syncFigureAnnotations('insert', centerIndex, previousCount);
        figure.selectedGuide = { index: layout.index, centerIndex };
        figure.editTool = 'select';
        renderFigurePanelInputs();
        renderWbFigure();
        toastMessage(`已增加第 ${centerIndex + 1} 条黄线，并同步增加名称项。`);
        return;
      }
      let centerIndex = entry.manualCenters.reduce((bestIndex, center, index) => Math.abs(center - normalized) < Math.abs(entry.manualCenters[bestIndex] - normalized) ? index : bestIndex, 0);
      const closestDistance = entry.manualCenters.length ? Math.abs(entry.manualCenters[centerIndex] - normalized) : Infinity;
      if (closestDistance > 0.05) {
        figure.selectedGuide = null;
        renderWbFigure();
        return;
      }
      pushHistory('移动手动泳道线');
      figure.selectedGuide = { index: layout.index, centerIndex };
      figure.dragging = { index: layout.index, centerIndex };
      figureCanvas.setPointerCapture(event.pointerId);
      renderWbFigure();
    });
    figureCanvas.addEventListener('pointermove', event => {
      if (!figure.dragging) return;
      const layout = figure.layouts.find(item => item.index === figure.dragging.index);
      const entry = figure.images[figure.dragging.index];
      if (!layout || !entry?.manualCenters?.length) return;
      const point = figureCanvasPoint(event);
      const sourceX = layout.cropX + (point.x - layout.imageX) / layout.imageWidth * layout.cropWidth;
      entry.manualCenters[figure.dragging.centerIndex] = clamp(sourceX / layout.sourceWidth, 0, 1);
      renderWbFigure();
    });
    const finish = () => {
      if (!figure.dragging) return;
      const entry = figure.images[figure.dragging.index];
      if (entry?.manualCenters) {
        const selectedValue = entry.manualCenters[figure.dragging.centerIndex];
        entry.manualCenters.sort((a, b) => a - b);
        figure.selectedGuide = { index: figure.dragging.index, centerIndex: entry.manualCenters.indexOf(selectedValue) };
      }
      figure.dragging = null;
      renderFigurePanelInputs();
      renderWbFigure();
    };
    figureCanvas.addEventListener('pointerup', finish);
    figureCanvas.addEventListener('pointercancel', finish);
    figureCanvas.addEventListener('contextmenu', event => {
      if (!figure.editing) return;
      event.preventDefault();
      const point = figureCanvasPoint(event);
      const layout = figureLayoutAt(point);
      if (!layout) return;
      const entry = figure.images[layout.index];
      if (!entry?.manualCenters?.length) return;
      const sourceX = layout.cropX + (point.x - layout.imageX) / layout.imageWidth * layout.cropWidth;
      const normalized = clamp(sourceX / layout.sourceWidth, 0, 1);
      const nearestIndex = entry.manualCenters.reduce((bestIndex, center, index) => Math.abs(center - normalized) < Math.abs(entry.manualCenters[bestIndex] - normalized) ? index : bestIndex, 0);
      if (Math.abs(entry.manualCenters[nearestIndex] - normalized) > 0.05) return;
      figure.selectedGuide = { index: layout.index, centerIndex: nearestIndex };
      deleteSelectedFigureGuide();
    });
  }

  function figureBandLine(candidates) {
    const points = candidates
      .filter(candidate => Number.isFinite(candidate.x) && Number.isFinite(candidate.y))
      .map(candidate => ({ x: candidate.x + Math.max(candidate.width || 0, 1) / 2, y: candidate.y + Math.max(candidate.height || 0, 1) / 2 }));
    if (points.length < 2) return { slope: 0, intercept: points[0]?.y || 0, angle: 0 };
    const slopes = [];
    for (let left = 0; left < points.length; left += 1) {
      for (let right = left + 1; right < points.length; right += 1) {
        const dx = points[right].x - points[left].x;
        if (Math.abs(dx) > 2) slopes.push((points[right].y - points[left].y) / dx);
      }
    }
    const slope = clamp(percentile(slopes, 0.5) || 0, -0.14, 0.14);
    const intercept = percentile(points.map(point => point.y - slope * point.x), 0.5) || 0;
    return { slope, intercept, angle: clamp(-Math.atan(slope) * 180 / Math.PI, -8, 8) };
  }

  function smoothSeries(values, radius) {
    return values.map((_, index) => {
      const slice = values.slice(Math.max(0, index - radius), Math.min(values.length, index + radius + 1));
      return percentile(slice, 0.5);
    });
  }

  function whitenFigureBackground(ctx, width, height, strength = 62, preserveColor = true, bandRegions = []) {
    const imageData = ctx.getImageData(0, 0, width, height);
    const original = new Uint8ClampedArray(imageData.data);
    const gray = new Float32Array(width * height);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = pixel * 4;
      gray[pixel] = 0.299 * imageData.data[offset] + 0.587 * imageData.data[offset + 1] + 0.114 * imageData.data[offset + 2];
    }
    const edgeRows = clamp(Math.round(height * 0.24), 2, Math.max(2, Math.floor(height / 2)));
    const top = [];
    const bottom = [];
    for (let x = 0; x < width; x += 1) {
      const topSamples = [];
      const bottomSamples = [];
      for (let y = 0; y < edgeRows; y += 1) {
        topSamples.push(gray[y * width + x]);
        bottomSamples.push(gray[(height - 1 - y) * width + x]);
      }
      top.push(percentile(topSamples, 0.62));
      bottom.push(percentile(bottomSamples, 0.62));
    }
    const smoothRadius = clamp(Math.round(width / 90), 3, 18);
    const topBackground = smoothSeries(top, smoothRadius);
    const bottomBackground = smoothSeries(bottom, smoothRadius);
    const residuals = [];
    const edgeNoise = [];
    for (let y = 0; y < height; y += 1) {
      const ratio = height > 1 ? y / (height - 1) : 0;
      for (let x = 0; x < width; x += 1) {
        const background = topBackground[x] * (1 - ratio) + bottomBackground[x] * ratio;
        const residual = Math.max(0, background - gray[y * width + x]);
        residuals.push(residual);
        if (y < edgeRows || y >= height - edgeRows) edgeNoise.push(Math.abs(residual));
      }
    }
    const strengthRatio = clamp(number(strength, 62) / 100, 0, 1);
    const noiseFloor = Math.max(1.1 + strengthRatio * 1.5, (percentile(edgeNoise, 0.78) || 0) * (1.35 + strengthRatio));
    const signalHigh = Math.max(noiseFloor + 8, percentile(residuals, 0.992) || 24);
    const regionWeightAt = (x, y) => {
      if (!bandRegions.length) return 1;
      let best = 0;
      bandRegions.forEach(region => {
        const padX = clamp(region.width * 0.22, 4, 28);
        const padY = clamp(region.height * 0.7, 3, 14);
        const left = region.x;
        const right = region.x + region.width;
        const top = region.y;
        const bottom = region.y + region.height;
        const distanceX = x < left ? (left - x) / padX : x > right ? (x - right) / padX : 0;
        const distanceY = y < top ? (top - y) / padY : y > bottom ? (y - bottom) / padY : 0;
        if (distanceX >= 1 || distanceY >= 1) return;
        const horizontal = 1 - distanceX;
        const vertical = 1 - distanceY;
        const smoothX = horizontal * horizontal * (3 - 2 * horizontal);
        const smoothY = vertical * vertical * (3 - 2 * vertical);
        best = Math.max(best, smoothX * smoothY);
      });
      return best;
    };
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const normalized = clamp((residuals[pixel] - noiseFloor) / (signalHigh - noiseFloor), 0, 1);
      const mask = Math.pow(normalized, 0.94 + strengthRatio * 0.42);
      const offset = pixel * 4;
      if (preserveColor) {
        // Keep the original RGB values in the band body. Only feather the very
        // faint edge into white; multiplying every foreground pixel by `mask`
        // washed out weak bands and destroyed pseudo-colour images.
        const featherStart = 0.018 + strengthRatio * 0.012;
        const preserveStart = 0.11 + strengthRatio * 0.035;
        const featherPosition = clamp((normalized - featherStart) / Math.max(0.01, preserveStart - featherStart), 0, 1);
        const signalAlpha = featherPosition * featherPosition * (3 - 2 * featherPosition);
        const x = pixel % width;
        const y = Math.floor(pixel / width);
        const foregroundAlpha = signalAlpha * regionWeightAt(x, y);
        imageData.data[offset] = 255 + (original[offset] - 255) * foregroundAlpha;
        imageData.data[offset + 1] = 255 + (original[offset + 1] - 255) * foregroundAlpha;
        imageData.data[offset + 2] = 255 + (original[offset + 2] - 255) * foregroundAlpha;
      } else {
        const corrected = 255 - 245 * mask;
        imageData.data[offset] = corrected;
        imageData.data[offset + 1] = corrected;
        imageData.data[offset + 2] = corrected;
      }
      imageData.data[offset + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function buildFigureStrip(entry, xCandidates, bandCandidates, padding, whiteBackground, rotationDegrees = 0, backgroundStrength = 62, preserveColor = true) {
    const sourceWidth = entry.image.naturalWidth || entry.image.width;
    const sourceHeight = entry.image.naturalHeight || entry.image.height;
    const xSource = xCandidates.length ? xCandidates : bandCandidates;
    const bandWidths = bandCandidates.map(candidate => candidate.width).filter(width => width > 0);
    const horizontalPadding = Math.max(10, Math.round((percentile(bandWidths, 0.5) || sourceWidth * 0.04) * 0.45));
    const x0 = xSource.length ? clamp(Math.floor(Math.min(...xSource.map(candidate => candidate.x)) - horizontalPadding), 0, sourceWidth - 2) : 0;
    const x1 = xSource.length ? clamp(Math.ceil(Math.max(...xSource.map(candidate => candidate.x + Math.max(candidate.width || 0, 1))) + horizontalPadding), x0 + 2, sourceWidth) : sourceWidth;
    const validBands = bandCandidates.filter(candidate => Number.isFinite(candidate.y) && Number.isFinite(candidate.height));
    const y0 = validBands.length ? clamp(Math.floor(Math.min(...validBands.map(candidate => candidate.y)) - padding), 0, sourceHeight - 2) : 0;
    const y1 = validBands.length ? clamp(Math.ceil(Math.max(...validBands.map(candidate => candidate.y + candidate.height)) + padding), y0 + 2, sourceHeight) : sourceHeight;
    const cropWidth = Math.max(2, x1 - x0);
    const cropHeight = Math.max(2, y1 - y0);
    const rotatedCanvas = document.createElement('canvas');
    rotatedCanvas.width = cropWidth;
    rotatedCanvas.height = cropHeight;
    const rotatedCtx = rotatedCanvas.getContext('2d', { willReadFrequently: true });
    const backgroundSampleCanvas = document.createElement('canvas');
    backgroundSampleCanvas.width = cropWidth;
    backgroundSampleCanvas.height = cropHeight;
    const backgroundSampleCtx = backgroundSampleCanvas.getContext('2d', { willReadFrequently: true });
    backgroundSampleCtx.drawImage(entry.image, x0, y0, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    const backgroundPixels = backgroundSampleCtx.getImageData(0, 0, cropWidth, cropHeight).data;
    const edgeDepth = clamp(Math.round(cropHeight * 0.18), 1, Math.max(1, Math.floor(cropHeight / 2)));
    const red = [];
    const green = [];
    const blue = [];
    const sampleStep = Math.max(1, Math.floor(cropWidth / 240));
    for (let y = 0; y < cropHeight; y += 1) {
      if (y >= edgeDepth && y < cropHeight - edgeDepth) continue;
      for (let x = 0; x < cropWidth; x += sampleStep) {
        const offset = (y * cropWidth + x) * 4;
        red.push(backgroundPixels[offset]);
        green.push(backgroundPixels[offset + 1]);
        blue.push(backgroundPixels[offset + 2]);
      }
    }
    const originalBackground = `rgb(${Math.round(percentile(red, 0.5) || 208)}, ${Math.round(percentile(green, 0.5) || 208)}, ${Math.round(percentile(blue, 0.5) || 208)})`;
    rotatedCtx.fillStyle = whiteBackground ? '#ffffff' : originalBackground;
    rotatedCtx.fillRect(0, 0, cropWidth, cropHeight);
    const angle = clamp(number(rotationDegrees, 0), -12, 12) * Math.PI / 180;
    rotatedCtx.save();
    rotatedCtx.translate(cropWidth / 2, cropHeight / 2);
    rotatedCtx.rotate(angle);
    rotatedCtx.drawImage(entry.image, x0, y0, cropWidth, cropHeight, -cropWidth / 2, -cropHeight / 2, cropWidth, cropHeight);
    rotatedCtx.restore();

    const transformPoint = (sourceX, sourceY) => {
      const localX = sourceX - x0 - cropWidth / 2;
      const localY = sourceY - y0 - cropHeight / 2;
      return {
        x: Math.cos(angle) * localX - Math.sin(angle) * localY + cropWidth / 2,
        y: Math.sin(angle) * localX + Math.cos(angle) * localY + cropHeight / 2,
      };
    };
    const templateWidth = percentile(bandWidths, 0.5) || Math.max(8, sourceWidth * 0.045);
    const templateHeight = percentile(validBands.map(candidate => candidate.height), 0.5) || Math.max(4, sourceHeight * 0.04);
    const templateCenterY = percentile(validBands.map(candidate => candidate.y + candidate.height / 2), 0.5) || sourceHeight / 2;
    const preservationBands = xSource.map(candidate => {
      if (Number.isFinite(candidate.y) && Number.isFinite(candidate.height) && candidate.height > 0) return candidate;
      const centerX = candidate.x + Math.max(candidate.width || 0, 0) / 2;
      const nearest = validBands.reduce((best, band) => {
        if (!best) return band;
        const bandDistance = Math.abs(band.x + band.width / 2 - centerX);
        const bestDistance = Math.abs(best.x + best.width / 2 - centerX);
        return bandDistance < bestDistance ? band : best;
      }, null);
      const useNearest = nearest && Math.abs(nearest.x + nearest.width / 2 - centerX) <= Math.max(templateWidth * 1.7, sourceWidth * 0.065);
      const width = useNearest ? nearest.width : templateWidth;
      const height = useNearest ? nearest.height : templateHeight;
      const centerY = useNearest ? nearest.y + nearest.height / 2 : templateCenterY;
      return { x: centerX - width / 2, y: centerY - height / 2, width, height };
    });
    const transformedBands = validBands.flatMap(candidate => {
      const left = candidate.x;
      const right = candidate.x + candidate.width;
      const top = candidate.y;
      const bottom = candidate.y + candidate.height;
      return [transformPoint(left, top), transformPoint(right, top), transformPoint(left, bottom), transformPoint(right, bottom)];
    });
    const trimY0 = transformedBands.length ? clamp(Math.floor(Math.min(...transformedBands.map(point => point.y)) - padding), 0, cropHeight - 2) : 0;
    const trimY1 = transformedBands.length ? clamp(Math.ceil(Math.max(...transformedBands.map(point => point.y)) + padding), trimY0 + 2, cropHeight) : cropHeight;
    const finalHeight = Math.max(2, trimY1 - trimY0);
    const stripCanvas = document.createElement('canvas');
    stripCanvas.width = cropWidth;
    stripCanvas.height = finalHeight;
    const stripCtx = stripCanvas.getContext('2d', { willReadFrequently: true });
    stripCtx.drawImage(rotatedCanvas, 0, trimY0, cropWidth, finalHeight, 0, 0, cropWidth, finalHeight);
    const bandRegions = preservationBands.map(candidate => {
      const corners = [
        transformPoint(candidate.x, candidate.y),
        transformPoint(candidate.x + candidate.width, candidate.y),
        transformPoint(candidate.x, candidate.y + candidate.height),
        transformPoint(candidate.x + candidate.width, candidate.y + candidate.height),
      ];
      const left = Math.min(...corners.map(point => point.x));
      const right = Math.max(...corners.map(point => point.x));
      const top = Math.min(...corners.map(point => point.y)) - trimY0;
      const bottom = Math.max(...corners.map(point => point.y)) - trimY0;
      return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
    });
    if (whiteBackground) whitenFigureBackground(stripCtx, cropWidth, finalHeight, backgroundStrength, preserveColor, bandRegions);
    return {
      canvas: stripCanvas,
      x0,
      y0,
      cropWidth,
      cropHeight: finalHeight,
      rotationDegrees: angle * 180 / Math.PI,
      mapSourcePoint: (sourceX, sourceY) => {
        const point = transformPoint(sourceX, sourceY);
        return { x: point.x, y: point.y - trimY0 };
      },
    };
  }

  function renderWbFigure(showGuides = figure.editing) {
    if (!figure.images.length) {
      drawFigureEmptyState();
      updateFigureExportInfo();
      return;
    }
    const laneNames = parseFigureList($('#figureLaneNames').value);
    const values = parseFigureList($('#figureValues').value);
    const groupLabels = parseFigureGroups($('#figureGroupLabels').value);
    const panelLetters = parseFigureList($('#figurePanelLetters').value);
    const expectedCount = figureExpectedLaneCount();
    const showValues = $('#figureShowValues').checked;
    const whiteBackground = $('#figureWhiteBackground').checked;
    const preserveColor = $('#figurePreserveColor').checked;
    const autoDeskew = $('#figureAutoDeskew').checked;
    const cropPadding = clamp(Math.round(number($('#figureCropPadding').value, 12)), 2, 80);
    const backgroundStrength = clamp(Math.round(number($('#figureBackgroundStrength').value, 62)), 0, 100);
    const sideFontSize = clamp(Math.round(number($('#figureSideFontSize').value, 30)), 12, 52);
    const valueFontSize = clamp(Math.round(number($('#figureValueFontSize').value, 20)), 10, 42);
    const laneFontSize = clamp(Math.round(number($('#figureLaneFontSize').value, 17)), 10, 42);
    const panelHeight = 250;
    const frame = { x: 180, width: 840, height: 78 };
    figureCanvas.width = 1200;
    figureCanvas.height = Math.max(340, figure.images.length * panelHeight + 100);
    figureCtx.clearRect(0, 0, figureCanvas.width, figureCanvas.height);
    figureCtx.fillStyle = '#fff';
    figureCtx.fillRect(0, 0, figureCanvas.width, figureCanvas.height);
    figureCtx.textBaseline = 'middle';
    const statuses = [];
    figure.layouts = [];
    figureCanvas.classList.toggle('figure-editing', Boolean(showGuides));

    figure.images.forEach((entry, index) => {
      const frameY = 92 + index * panelHeight;
      const sourceWidth = entry.image.naturalWidth || entry.image.width;
      const automaticCandidates = figureLaneCandidates(entry, expectedCount);
      const bandLine = figureBandLine(automaticCandidates);
      const candidates = Array.isArray(entry.manualCenters)
        ? [...entry.manualCenters].sort((a, b) => a - b).map(center => ({ x: center * sourceWidth, width: 0, manual: true }))
        : automaticCandidates;
      const autoAngle = autoDeskew ? bandLine.angle : 0;
      const totalAngle = autoAngle + clamp(number(entry.rotation, 0), -12, 12);
      const strip = buildFigureStrip(entry, candidates, automaticCandidates, cropPadding, whiteBackground, totalAngle, backgroundStrength, preserveColor);
      statuses.push(`图 ${index + 1}：${Array.isArray(entry.manualCenters) ? '手动校正' : '识别'} ${candidates.length}${expectedCount ? ` / ${expectedCount}` : ''} 条主带，水平校正 ${fmt(totalAngle, 2)}°`);

      figureCtx.drawImage(strip.canvas, frame.x, frameY, frame.width, frame.height);
      figureCtx.strokeStyle = '#101010';
      figureCtx.lineWidth = 3;
      figureCtx.strokeRect(frame.x, frameY, frame.width, frame.height);

      figureCtx.fillStyle = '#111827';
      figureCtx.font = `600 ${sideFontSize}px "Times New Roman", serif`;
      figureCtx.textAlign = 'right';
      figureCtx.fillText(entry.protein || `Protein ${index + 1}`, frame.x - 18, frameY + frame.height / 2);
      figureCtx.textAlign = 'left';
      figureCtx.font = `600 ${Math.max(12, sideFontSize - 5)}px "Times New Roman", serif`;
      const massText = entry.mass ? `${entry.mass} kDa` : 'kDa';
      figureCtx.fillText(massText, frame.x + frame.width + 18, frameY + frame.height / 2);
      const panelLetter = panelLetters[index] || String.fromCharCode(65 + index);
      figureCtx.textAlign = 'left';
      figureCtx.font = `700 ${Math.max(18, sideFontSize - 2)}px "Times New Roman", serif`;
      figureCtx.fillText(panelLetter, 24, frameY - 28);

      const laneXs = candidates.map(candidate => {
        const sourceX = candidate.x + candidate.width / 2;
        const sourceY = Number.isFinite(candidate.y) ? candidate.y + Math.max(candidate.height || 0, 1) / 2 : bandLine.slope * sourceX + bandLine.intercept;
        return frame.x + strip.mapSourcePoint(sourceX, sourceY).x / strip.cropWidth * frame.width;
      });
      const valueLevels = annotationLevels(laneXs, Math.max(40, valueFontSize * 2.8));
      const nameLevels = annotationLevels(laneXs, Math.max(55, laneFontSize * 4.4));
      candidates.forEach((candidate, laneIndex) => {
        const x = laneXs[laneIndex];
        if (showValues && values[laneIndex] !== undefined) {
          figureCtx.fillStyle = '#111827';
          figureCtx.font = `600 ${valueFontSize}px "Times New Roman", serif`;
          figureCtx.textAlign = 'center';
          figureCtx.fillText(values[laneIndex], x, frameY - 18 - valueLevels[laneIndex] * 22);
        }
        if (laneNames[laneIndex] !== undefined) {
          figureCtx.save();
          figureCtx.translate(x, frameY + frame.height + 38 + nameLevels[laneIndex] * 25);
          figureCtx.rotate(-0.48);
          figureCtx.fillStyle = '#111827';
          figureCtx.font = `600 ${laneFontSize}px "Times New Roman", serif`;
          figureCtx.textAlign = 'right';
          figureCtx.fillText(laneNames[laneIndex], 0, 0);
          figureCtx.restore();
        }
      });
      groupLabels.forEach((group, groupIndex) => {
        const leftIndex = clamp(group.start - 1, 0, Math.max(0, laneXs.length - 1));
        const rightIndex = clamp(group.end - 1, leftIndex, Math.max(0, laneXs.length - 1));
        if (!laneXs.length) return;
        const y = frameY + frame.height + 76 + groupIndex * 24;
        const left = laneXs[leftIndex] - 18;
        const right = laneXs[rightIndex] + 18;
        figureCtx.strokeStyle = '#111827';
        figureCtx.lineWidth = 1.5;
        figureCtx.beginPath(); figureCtx.moveTo(left, y); figureCtx.lineTo(right, y); figureCtx.stroke();
        figureCtx.beginPath(); figureCtx.moveTo(left, y - 5); figureCtx.lineTo(left, y + 5); figureCtx.moveTo(right, y - 5); figureCtx.lineTo(right, y + 5); figureCtx.stroke();
        figureCtx.fillStyle = '#111827';
        figureCtx.font = `600 ${Math.max(11, laneFontSize - 2)}px "Times New Roman", serif`;
        figureCtx.textAlign = 'center';
        figureCtx.fillText(group.label, (left + right) / 2, y + 15);
      });
      if (showGuides) {
        figureCtx.save();
        figureCtx.lineWidth = 2;
        laneXs.forEach((x, laneIndex) => {
          const selected = figure.selectedGuide?.index === index && figure.selectedGuide?.centerIndex === laneIndex;
          figureCtx.strokeStyle = selected ? '#dc2626' : '#e8a128';
          figureCtx.fillStyle = selected ? '#dc2626' : '#e8a128';
          figureCtx.setLineDash(selected ? [] : [5, 4]);
          figureCtx.beginPath();
          figureCtx.moveTo(x, frameY + 4);
          figureCtx.lineTo(x, frameY + frame.height - 4);
          figureCtx.stroke();
          figureCtx.setLineDash([]);
          figureCtx.beginPath();
          figureCtx.arc(x, frameY + frame.height / 2, 6, 0, Math.PI * 2);
          figureCtx.fill();
          figureCtx.fillStyle = '#5f3b00';
          figureCtx.font = '600 13px "Times New Roman", serif';
          figureCtx.textAlign = 'center';
          figureCtx.fillText(String(laneIndex + 1), x, frameY + frame.height / 2);
        });
        figureCtx.restore();
      }
      figure.layouts.push({ index, frameY, frame: { ...frame }, imageX: frame.x, imageWidth: frame.width, sourceWidth, cropX: strip.x0, cropWidth: strip.cropWidth, candidates, stripCanvas: strip.canvas, laneXs, valueLevels, nameLevels, panelLetter, massText, entry });
      const status = $(`#figureDetect-${index}`);
      if (status) status.textContent = statuses[statuses.length - 1];
    });
    $('#figureStatus').textContent = `${statuses.join('；')}。已按条带区域裁剪并使用紧凑黑框${whiteBackground ? `，膜背景已做局部校正并转白（强度 ${backgroundStrength}）` : ''}${whiteBackground && preserveColor ? '，条带原始颜色已保留' : ''}${autoDeskew ? '，条带已自动旋至水平' : ''}。`;
    updateFigureExportInfo();
    updateFigureEditControls();
  }

  function loadFigureImages(files) {
    const validFiles = [...files].filter(Boolean);
    if (!validFiles.length) return toastMessage('请选择至少一张 WB 图片。');
    pushHistory('载入 WB 排版图片');
    Promise.all(validFiles.map(async file => {
      const { image, source } = await decodeSourceFile(file);
      return { name: file.name, image, source, protein: '', mass: '', rotation: 0 };
    })).then(entries => {
      figure.images = entries;
      renderFigurePanelInputs();
      renderWbFigure();
      toastMessage(`已载入 ${entries.length} 张 WB 图，可填写图注并导出。`);
      recordAudit('figure-images-loaded', { count: entries.length, sources: entries.map(entry => sourceMetadata(entry.source)) });
    }).catch(error => { console.error(error); toastMessage('部分图片读取失败，请改用 PNG、TIFF 或 JPG 后重试。'); });
  }

  function usePairValuesForFigure() {
    const rows = pairResultRows().filter(row => Number.isFinite(row.relative));
    if (!rows.length) return toastMessage('双图结果中暂无可用的相对表达量；请先完成双图 ROI 与基准泳道设置。');
    $('#figureValues').value = rows.map(row => fmt(row.relative, 2)).join(', ');
    if (!$('#figureLaneNames').value.trim()) $('#figureLaneNames').value = rows.map(row => `泳道 ${row.lane}`).join(', ');
    if (!$('#figureLaneCount').value) $('#figureLaneCount').value = rows.length;
    renderWbFigure();
    toastMessage('已带入双图相对表达量；仍可在图注工作区内手动修改。');
  }

  function figureExportSettings() {
    const template = $('#figureTemplate').value;
    const dpi = clamp(Math.round(number($('#figureDpi').value, 600)), 72, 1200);
    const customWidth = clamp(number($('#figureCustomWidthMm').value, 180), 20, 500);
    const millimeters = template === 'single' ? 85 : template === 'double' ? 180 : customWidth;
    const width = core.pixelsForPhysicalWidth(millimeters, dpi);
    const height = Math.max(1, Math.round(width * figureCanvas.height / Math.max(1, figureCanvas.width)));
    return { template, dpi, millimeters, width, height };
  }

  function updateFigureExportInfo() {
    const settings = figureExportSettings();
    const customWidth = $('#figureCustomWidthMm');
    customWidth.disabled = settings.template !== 'custom';
    $('#figureExportInfo').textContent = `${settings.dpi} DPI · ${fmt(settings.millimeters, 1)} mm · ${settings.width} × ${settings.height} px；PNG 文件会写入 ${settings.dpi} DPI 物理分辨率元数据。`;
    $('#exportWbFigure').textContent = `导出 ${settings.dpi} DPI PNG`;
  }

  function exportWbFigure() {
    if (!figure.images.length) return toastMessage('请先上传 WB 图并生成排版预览。');
    renderWbFigure(false);
    const { template, dpi, millimeters, width: targetWidth, height: targetHeight } = figureExportSettings();
    const output = document.createElement('canvas');
    output.width = targetWidth;
    output.height = targetHeight;
    const outputCtx = output.getContext('2d');
    outputCtx.imageSmoothingEnabled = true;
    outputCtx.imageSmoothingQuality = 'high';
    outputCtx.drawImage(figureCanvas, 0, 0, output.width, output.height);
    output.toBlob(async blob => {
      if (!blob) {
        renderWbFigure();
        return toastMessage('PNG 编码失败，请减小版面宽度后重试。');
      }
      try {
        const stampedBytes = core.setPngDpi(await blob.arrayBuffer(), dpi);
        downloadBlob(`western-blot-annotated-${dpi}dpi.png`, new Blob([stampedBytes], { type: 'image/png' }));
        recordAudit('figure-png-exported', { template, dpi, millimeters, width: output.width, height: output.height, pngPhysicalMetadata: true });
        toastMessage(`WB 图注 PNG 已导出：${output.width} × ${output.height}px，已写入 ${dpi} DPI。`);
      } catch (error) {
        console.error(error);
        toastMessage('PNG 物理分辨率写入失败，未导出不完整文件。');
      } finally {
        renderWbFigure();
      }
    }, 'image/png');
  }

  function exportWbFigureSvg() {
    if (!figure.images.length) return toastMessage('请先上传 WB 图并生成排版预览。');
    renderWbFigure(false);
    const laneNames = parseFigureList($('#figureLaneNames').value);
    const values = parseFigureList($('#figureValues').value);
    const groups = parseFigureGroups($('#figureGroupLabels').value);
    const showValues = $('#figureShowValues').checked;
    const sideFontSize = clamp(Math.round(number($('#figureSideFontSize').value, 30)), 12, 52);
    const valueFontSize = clamp(Math.round(number($('#figureValueFontSize').value, 20)), 10, 42);
    const laneFontSize = clamp(Math.round(number($('#figureLaneFontSize').value, 17)), 10, 42);
    const { template, millimeters } = figureExportSettings();
    const physicalWidth = `${millimeters}mm`;
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${physicalWidth}" viewBox="0 0 ${figureCanvas.width} ${figureCanvas.height}">`, '<rect width="100%" height="100%" fill="white"/>'];
    figure.layouts.forEach(layout => {
      const { frame, frameY, laneXs, valueLevels, nameLevels, entry } = layout;
      parts.push(`<image href="${layout.stripCanvas.toDataURL('image/png')}" x="${frame.x}" y="${frameY}" width="${frame.width}" height="${frame.height}" preserveAspectRatio="none"/>`);
      parts.push(`<rect x="${frame.x}" y="${frameY}" width="${frame.width}" height="${frame.height}" fill="none" stroke="#101010" stroke-width="3"/>`);
      parts.push(`<text x="${frame.x - 18}" y="${frameY + frame.height / 2}" text-anchor="end" dominant-baseline="middle" font-family="Times New Roman" font-size="${sideFontSize}" font-weight="600">${escapeHtml(entry.protein || `Protein ${layout.index + 1}`)}</text>`);
      parts.push(`<text x="${frame.x + frame.width + 18}" y="${frameY + frame.height / 2}" dominant-baseline="middle" font-family="Times New Roman" font-size="${Math.max(12, sideFontSize - 5)}" font-weight="600">${escapeHtml(layout.massText)}</text>`);
      parts.push(`<text x="24" y="${frameY - 28}" dominant-baseline="middle" font-family="Times New Roman" font-size="${Math.max(18, sideFontSize - 2)}" font-weight="700">${escapeHtml(layout.panelLetter)}</text>`);
      laneXs.forEach((x, laneIndex) => {
        if (showValues && values[laneIndex] !== undefined) parts.push(`<text x="${x}" y="${frameY - 18 - valueLevels[laneIndex] * 22}" text-anchor="middle" dominant-baseline="middle" font-family="Times New Roman" font-size="${valueFontSize}" font-weight="600">${escapeHtml(values[laneIndex])}</text>`);
        if (laneNames[laneIndex] !== undefined) {
          const y = frameY + frame.height + 38 + nameLevels[laneIndex] * 25;
          parts.push(`<text x="${x}" y="${y}" text-anchor="end" dominant-baseline="middle" transform="rotate(-27.5 ${x} ${y})" font-family="Times New Roman" font-size="${laneFontSize}" font-weight="600">${escapeHtml(laneNames[laneIndex])}</text>`);
        }
      });
      groups.forEach((group, groupIndex) => {
        if (!laneXs.length) return;
        const leftIndex = clamp(group.start - 1, 0, laneXs.length - 1);
        const rightIndex = clamp(group.end - 1, leftIndex, laneXs.length - 1);
        const y = frameY + frame.height + 76 + groupIndex * 24;
        const left = laneXs[leftIndex] - 18;
        const right = laneXs[rightIndex] + 18;
        parts.push(`<path d="M ${left} ${y - 5} V ${y + 5} M ${left} ${y} H ${right} M ${right} ${y - 5} V ${y + 5}" fill="none" stroke="#111827" stroke-width="1.5"/>`);
        parts.push(`<text x="${(left + right) / 2}" y="${y + 15}" text-anchor="middle" dominant-baseline="middle" font-family="Times New Roman" font-size="${Math.max(11, laneFontSize - 2)}" font-weight="600">${escapeHtml(group.label)}</text>`);
      });
    });
    parts.push('</svg>');
    downloadText('western-blot-annotated-figure.svg', parts.join('\n'), 'image/svg+xml;charset=utf-8');
    renderWbFigure();
    recordAudit('figure-svg-exported', { template, layers: figure.layouts.length });
    toastMessage('可编辑 SVG 已导出；文字、黑框和分组线均为独立矢量对象。');
  }

  function printWbFigurePdf() {
    if (!figure.images.length) return toastMessage('请先上传 WB 图并生成排版预览。');
    renderWbFigure(false);
    const dataUrl = figureCanvas.toDataURL('image/png');
    const frame = document.createElement('iframe');
    frame.style.position = 'fixed'; frame.style.right = '0'; frame.style.bottom = '0'; frame.style.width = '1px'; frame.style.height = '1px'; frame.style.border = '0';
    document.body.appendChild(frame);
    frame.contentDocument.open();
    frame.contentDocument.write(`<html><head><title>Western blot figure</title><style>@page{size:auto;margin:10mm}body{margin:0}img{display:block;width:100%;height:auto}</style></head><body><img src="${dataUrl}" onload="setTimeout(()=>window.print(),100)"></body></html>`);
    frame.contentDocument.close();
    setTimeout(() => { frame.remove(); renderWbFigure(); }, 30000);
    recordAudit('figure-print-requested');
    toastMessage('已打开系统打印窗口，可选择“另存为 PDF”。');
  }

  const projectControlIds = [
    'invertIntensity', 'autoSensitivity', 'autoMaxBands', 'autoLaneCount', 'autoMarkerPercent', 'autoBandsPerLane', 'autoBandGap', 'autoBackground', 'wbAutoExcludeBad', 'backgroundMode',
    'roiType', 'roiName', 'roiGroup', 'pairAutoBackground', 'pairSensitivity', 'pairLaneCount', 'pairMarkerPercent', 'pairDefaultLoadVolume',
    'figureLaneNames', 'figureValues', 'figureLaneCount', 'figureMarkerPercent', 'figureSideFontSize', 'figureValueFontSize', 'figureLaneFontSize',
    'figureCropPadding', 'figureBackgroundStrength', 'figureWhiteBackground', 'figurePreserveColor', 'figureAutoDeskew', 'figureShowValues',
    'figureGroupLabels', 'figureTemplate', 'figureCustomWidthMm', 'figureDpi', 'figurePanelLetters',
  ];

  function captureProjectControls() {
    return Object.fromEntries(projectControlIds.map(id => {
      const element = $(`#${id}`);
      return [id, element?.type === 'checkbox' ? element.checked : element?.value];
    }));
  }

  function applyProjectControls(values = {}) {
    projectControlIds.forEach(id => {
      if (!(id in values)) return;
      const element = $(`#${id}`);
      if (!element) return;
      if (element.type === 'checkbox') element.checked = Boolean(values[id]);
      else element.value = values[id] ?? '';
    });
    $('#autoSensitivityValue').textContent = $('#autoSensitivity').value;
    $('#pairSensitivityValue').textContent = $('#pairSensitivity').value;
    const whiteBackground = $('#figureWhiteBackground').checked;
    $('#figureBackgroundStrength').disabled = !whiteBackground;
    $('#figurePreserveColor').disabled = !whiteBackground;
  }

  function imageFromSource(source) {
    return new Promise((resolve, reject) => {
      if (!source) return resolve(null);
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = source;
    });
  }

  function analysisContextForImage(image) {
    if (!image) return null;
    const analysisCanvas = document.createElement('canvas');
    analysisCanvas.width = image.naturalWidth || image.width;
    analysisCanvas.height = image.naturalHeight || image.height;
    const analysisCtx = analysisCanvas.getContext('2d', { willReadFrequently: true });
    analysisCtx.drawImage(image, 0, 0);
    return analysisCtx;
  }

  function saveProject() {
    const project = {
      schema: 'bioassay-studio-project',
      version: 2,
      appVersion: APP_VERSION,
      createdAt: new Date().toISOString(),
      activeModule: $('.module-tab.active')?.dataset.module || 'qpcr',
      activeWbMode: $('.wb-mode-tab.active')?.dataset.wbMode || 'single',
      controls: captureProjectControls(),
      qpcr: {
        step: qpcr.step,
        headers: qpcr.headers,
        rows: qpcr.rows,
        mapping: qpcr.mapping,
        qc: qpcr.qc,
        efficiencies: qpcr.efficiencies,
        references: qpcr.references,
        controls: qpcr.controls,
        results: qpcr.results,
        resultView: qpcr.resultView,
      },
      wb: {
        fileName: wb.fileName,
        imageSource: wb.image?.src || '',
        source: sourceMetadata(wb.source),
        rois: wb.rois,
        referenceId: wb.referenceId,
        backgroundMode: wb.backgroundMode,
        nextId: wb.nextId,
        profileRoiId: wb.profileRoiId,
      },
      pair: {
        baseline: pair.baseline,
        defaultLoadVolume: pair.defaultLoadVolume,
        loads: pair.loads,
        reference: { fileName: pair.reference.fileName, imageSource: pair.reference.image?.src || '', source: sourceMetadata(pair.reference.source), rois: pair.reference.rois, nextId: pair.reference.nextId },
        target: { fileName: pair.target.fileName, imageSource: pair.target.image?.src || '', source: sourceMetadata(pair.target.source), rois: pair.target.rois, nextId: pair.target.nextId },
      },
      auditLog,
      figure: {
        editing: figure.editing,
        images: figure.images.map(entry => ({
          name: entry.name,
          imageSource: entry.image?.src || '',
          source: sourceMetadata(entry.source),
          protein: entry.protein,
          mass: entry.mass,
          rotation: entry.rotation,
          manualCenters: entry.manualCenters,
        })),
      },
    };
    const timestamp = project.createdAt.slice(0, 19).replaceAll(':', '-');
    const blob = new Blob([JSON.stringify(project)], { type: 'application/json;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `bioassay-studio-project-${timestamp}.json`;
    anchor.click();
    URL.revokeObjectURL(href);
    toastMessage('项目文件已开始下载；其中包含当前图片、ROI、数据和设置。');
  }

  async function restoreProject(file) {
    if (!file) return;
    try {
      const raw = (await file.text()).replace(/^\uFEFF/, '');
      const project = JSON.parse(raw);
      if (project?.schema !== 'bioassay-studio-project' || ![1, 2].includes(project.version)) throw new Error('unsupported project');
      if (qpcr.chart) qpcr.chart.destroy();
      const savedQpcr = project.qpcr || {};
      Object.assign(qpcr, {
        step: clamp(Math.round(number(savedQpcr.step, 1)), 1, 4),
        headers: Array.isArray(savedQpcr.headers) ? savedQpcr.headers : [],
        rows: Array.isArray(savedQpcr.rows) ? savedQpcr.rows : [],
        mapping: { sample: '', gene: '', ct: '', replicate: '', ...(savedQpcr.mapping || {}) },
        qc: { min: 5, max: 40, sd: 2, deviation: 1, ...(savedQpcr.qc || {}) },
        efficiencies: savedQpcr.efficiencies && typeof savedQpcr.efficiencies === 'object' ? savedQpcr.efficiencies : {},
        references: Array.isArray(savedQpcr.references) ? savedQpcr.references : [],
        controls: Array.isArray(savedQpcr.controls) ? savedQpcr.controls : [],
        results: Array.isArray(savedQpcr.results) ? savedQpcr.results : [],
        resultView: savedQpcr.resultView === 'chart' ? 'chart' : 'table',
        chart: null,
        pendingWorkbook: null,
      });
      applyProjectControls(project.controls || {});

      const savedWb = project.wb || {};
      wb.image = await imageFromSource(savedWb.imageSource);
      wb.source = savedWb.source ? { ...savedWb.source, raw: null, warnings: [...(savedWb.source.warnings || []), '项目恢复后使用嵌入预览图计算；如需原始位深，请重新载入原始 TIFF。'] } : null;
      wb.fileName = savedWb.fileName || '';
      wb.rois = Array.isArray(savedWb.rois) ? savedWb.rois : [];
      wb.referenceId = savedWb.referenceId || '';
      wb.backgroundMode = ['global', 'nearest', 'side', 'plane'].includes(savedWb.backgroundMode) ? savedWb.backgroundMode : 'global';
      wb.nextId = Math.max(1, Math.round(number(savedWb.nextId, wb.rois.length + 1)));
      wb.profileRoiId = savedWb.profileRoiId || '';
      wb.drawing = null;
      wb.tempROI = null;
      if (wb.image) {
        canvas.width = wb.image.naturalWidth;
        canvas.height = wb.image.naturalHeight;
        wb.imageCtx = analysisContextForImage(wb.image);
        $('#wbEmptyState').classList.add('hide');
      } else {
        canvas.width = 0; canvas.height = 0; wb.imageCtx = null;
        $('#wbEmptyState').classList.remove('hide');
      }
      $('#backgroundMode').value = wb.backgroundMode;
      $('#wbSourceMeta').textContent = sourceMetaText(wb.source);
      $('#wbSourceMeta').className = `source-integrity ${wb.source?.warnings?.length ? 'warn' : wb.source ? 'good' : ''}`;

      const savedPair = project.pair || {};
      pair.baseline = savedPair.baseline || '';
      pair.defaultLoadVolume = Math.max(0.01, number(savedPair.defaultLoadVolume, 20));
      pair.loads = savedPair.loads && typeof savedPair.loads === 'object' ? savedPair.loads : {};
      for (const key of ['reference', 'target']) {
        const savedPane = savedPair[key] || {};
        const pane = pair[key];
        pane.image = await imageFromSource(savedPane.imageSource);
        pane.source = savedPane.source ? { ...savedPane.source, raw: null } : null;
        pane.fileName = savedPane.fileName || '';
        pane.rois = Array.isArray(savedPane.rois) ? savedPane.rois : [];
        pane.nextId = Math.max(1, Math.round(number(savedPane.nextId, pane.rois.length + 1)));
        pane.drawing = null;
        pane.tempROI = null;
        const prefix = key === 'reference' ? 'Reference' : 'Target';
        if (pane.image) {
          pane.canvas.width = pane.image.naturalWidth;
          pane.canvas.height = pane.image.naturalHeight;
          pane.imageCtx = analysisContextForImage(pane.image);
          $(`#pair${prefix}Empty`).classList.add('hide');
          $(`#pair${prefix}Meta`).textContent = `${pane.fileName || pane.label} · ${pane.image.naturalWidth} × ${pane.image.naturalHeight}px`;
        } else {
          pane.canvas.width = 0; pane.canvas.height = 0; pane.imageCtx = null;
          $(`#pair${prefix}Empty`).classList.remove('hide');
          $(`#pair${prefix}Meta`).textContent = '尚未载入图片';
        }
      }
      $('#pairDefaultLoadVolume').value = pair.defaultLoadVolume;

      const savedFigure = project.figure || {};
      figure.images = await Promise.all((Array.isArray(savedFigure.images) ? savedFigure.images : []).map(async entry => ({
        name: entry.name || 'WB image',
        image: await imageFromSource(entry.imageSource),
        source: entry.source ? { ...entry.source, raw: null } : null,
        protein: entry.protein || '',
        mass: entry.mass || '',
        rotation: number(entry.rotation, 0),
        ...(Array.isArray(entry.manualCenters) ? { manualCenters: entry.manualCenters } : {}),
      })));
      figure.images = figure.images.filter(entry => entry.image);
      figure.editing = Boolean(savedFigure.editing && figure.images.some(entry => entry.manualCenters?.length));
      figure.dragging = null;
      figure.layouts = [];
      auditLog.splice(0, auditLog.length, ...(Array.isArray(project.auditLog) ? project.auditLog : []));
      recordAudit('project-restored', { projectVersion: project.version });

      renderQpcr();
      updateWb();
      renderPairResults();
      renderFigurePanelInputs();
      if (figure.images.length) renderWbFigure(); else drawFigureEmptyState();
      const moduleButton = $(`.module-tab[data-module="${project.activeModule === 'wb' ? 'wb' : 'qpcr'}"]`);
      moduleButton?.click();
      const wbMode = ['single', 'pair', 'figure'].includes(project.activeWbMode) ? project.activeWbMode : 'single';
      $(`.wb-mode-tab[data-wb-mode="${wbMode}"]`)?.click();
      toastMessage('项目已完整恢复。请复核图片、ROI 与计算设置后继续。');
    } catch (error) {
      console.error(error);
      toastMessage('项目恢复失败：文件格式不正确或图片数据不完整。');
    } finally {
      $('#restoreProjectInput').value = '';
    }
  }

  function bindGlobalEvents() {
    $('#undoAction').addEventListener('click', undoAction);
    $('#redoAction').addEventListener('click', redoAction);
    $('#exportAudit').addEventListener('click', exportIntegrityReport);
    $('#saveProject').addEventListener('click', saveProject);
    $('#restoreProjectInput').addEventListener('change', event => restoreProject(event.target.files[0]));
    $$('.module-tab').forEach(button => button.addEventListener('click', () => {
      $$('.module-tab').forEach(item => item.classList.toggle('active', item === button));
      $('#qpcrModule').classList.toggle('active-module', button.dataset.module === 'qpcr');
      $('#wbModule').classList.toggle('active-module', button.dataset.module === 'wb');
    }));
    $$('.wb-mode-tab').forEach(button => button.addEventListener('click', () => {
      const mode = button.dataset.wbMode;
      $$('.wb-mode-tab').forEach(item => {
        const active = item === button;
        item.classList.toggle('active', active);
        item.setAttribute('aria-selected', String(active));
      });
      $('#wbSingleWorkspace').classList.toggle('hide', mode !== 'single');
      $('#wbPairWorkspace').classList.toggle('hide', mode !== 'pair');
      $('#wbFigureWorkspace').classList.toggle('hide', mode !== 'figure');
      if (mode === 'pair') renderPairResults();
      if (mode === 'figure') renderWbFigure();
    }));
    $('#loadDemoQpcr').addEventListener('click', resetQpcrWithDemo);
    sheetDialog.addEventListener('submit', event => {
      event.preventDefault();
      if (event.submitter?.id !== 'confirmSheet') { sheetDialog.close(); return; }
      const selected = $('input[name="sheet"]:checked', sheetDialog)?.value;
      if (selected && qpcr.pendingWorkbook) ingestSheet(qpcr.pendingWorkbook, selected);
      qpcr.pendingWorkbook = null;
      sheetDialog.close();
    });
    $('#wbImageInput').addEventListener('change', event => loadWbImage(event.target.files[0]));
    $('#roiType').addEventListener('change', event => { $('#roiName').value = event.target.value === 'background' ? '背景' : `条带 ${wb.nextId}`; });
    $('#invertIntensity').addEventListener('change', updateWb);
    $('#wbProfileSelect').addEventListener('change', event => { wb.profileRoiId = event.target.value; drawWbProfile(); });
    wbProfileCanvas.addEventListener('click', snapWbProfileToClick);
    $('#autoSensitivity').addEventListener('input', event => { $('#autoSensitivityValue').textContent = event.target.value; });
    $('#autoDetectWb').addEventListener('click', autoDetectWb);
    $('#wbAutoExcludeBad').addEventListener('change', updateWb);
    $('#clearAutoRois').addEventListener('click', () => {
      const before = wb.rois.length;
      if (before !== wb.rois.filter(roi => !roi.auto).length) pushHistory('清除自动 ROI');
      wb.rois = wb.rois.filter(roi => !roi.auto);
      if (wb.referenceId && !wb.rois.some(roi => roi.id === wb.referenceId)) wb.referenceId = '';
      $('#autoDetectionNote').textContent = before === wb.rois.length ? '当前没有自动生成的 ROI。' : '已清除自动识别结果，保留手动 ROI。';
      updateWb();
    });
    $('#backgroundMode').addEventListener('change', event => { pushHistory('更改背景扣除方法'); wb.backgroundMode = event.target.value; updateWb(); recordAudit('wb-background-mode', { mode: wb.backgroundMode }); });
    $('#wbReference').addEventListener('change', event => { pushHistory('更改归一化参照'); wb.referenceId = event.target.value; updateWb(); });
    $('#duplicateSelectedRoi').addEventListener('click', duplicateSelectedWbRoi);
    $('#equalizeBandRois').addEventListener('click', equalizeBandRois);
    $('#deleteSelectedRoi').addEventListener('click', deleteSelectedWbRoi);
    $('#exportWb').addEventListener('click', exportWb);
    $('#clearWb').addEventListener('click', clearWb);
    const dropzone = $('#wbDropzone');
    ['dragenter', 'dragover'].forEach(eventName => dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.style.background = '#14244a'; }));
    ['dragleave', 'drop'].forEach(eventName => dropzone.addEventListener(eventName, event => { event.preventDefault(); dropzone.style.background = ''; }));
    dropzone.addEventListener('drop', event => loadWbImage(event.dataTransfer.files[0]));
    canvas.addEventListener('pointerdown', event => {
      if (!wb.image) return;
      const point = canvasPoint(event);
      const hit = [...wb.rois].reverse().find(roi => point.x >= roi.x && point.x <= roi.x + roi.width && point.y >= roi.y && point.y <= roi.y + roi.height);
      canvas.setPointerCapture(event.pointerId);
      if (hit && !event.shiftKey) {
        pushHistory('拖动 ROI');
        wb.selectedId = hit.id;
        wb.dragging = { start: point, originalX: hit.x, originalY: hit.y };
        drawWb();
        return;
      }
      wb.selectedId = '';
      wb.drawing = point;
      wb.tempROI = { ...wb.drawing, width: 1, height: 1, type: $('#roiType').value, name: $('#roiName').value.trim() || 'ROI' };
      drawWb();
    });
    canvas.addEventListener('pointermove', event => {
      const point = canvasPoint(event);
      if (wb.dragging) {
        const roi = wb.rois.find(item => item.id === wb.selectedId);
        if (!roi) return;
        roi.x = clamp(wb.dragging.originalX + point.x - wb.dragging.start.x, 0, Math.max(0, canvas.width - roi.width));
        roi.y = clamp(wb.dragging.originalY + point.y - wb.dragging.start.y, 0, Math.max(0, canvas.height - roi.height));
        roi.auto = false; delete roi.confidence;
        drawWb();
        return;
      }
      if (!wb.drawing) return;
      wb.tempROI = { ...normalizedRect(wb.drawing, point), type: $('#roiType').value, name: $('#roiName').value.trim() || 'ROI' };
      drawWb();
    });
    const finishDrawing = event => {
      if (wb.dragging) {
        const id = wb.selectedId;
        wb.dragging = null;
        updateWb();
        recordAudit('wb-roi-moved', { id });
        return;
      }
      if (!wb.drawing) return;
      const rect = normalizedRect(wb.drawing, canvasPoint(event));
      wb.drawing = null; wb.tempROI = null; addRoi(rect);
    };
    canvas.addEventListener('pointerup', finishDrawing);
    canvas.addEventListener('pointercancel', () => { wb.drawing = null; wb.dragging = null; wb.tempROI = null; drawWb(); });
    $('#wbDropzone').addEventListener('keydown', event => {
      if (!wb.selectedId) return;
      const step = event.shiftKey ? 10 : 1;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); deleteSelectedWbRoi(); return; }
      const deltas = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (!deltas[event.key]) return;
      event.preventDefault();
      nudgeSelectedWbRoi(...deltas[event.key], event.altKey);
    });
    $('#pairReferenceInput').addEventListener('change', event => loadPairImage('reference', event.target.files[0]));
    $('#pairTargetInput').addEventListener('change', event => loadPairImage('target', event.target.files[0]));
    $$('[data-pair-auto]').forEach(button => button.addEventListener('click', () => autoPairRois(button.dataset.pairAuto)));
    $$('[data-pair-clear]').forEach(button => button.addEventListener('click', () => clearPairSide(button.dataset.pairClear)));
    $$('[data-pair-copy]').forEach(button => button.addEventListener('click', () => copyPairRois(button.dataset.pairCopy)));
    $('#pairBaseline').addEventListener('change', event => { pair.baseline = event.target.value; renderPairResults(); });
    $('#pairSensitivity').addEventListener('input', event => { $('#pairSensitivityValue').textContent = event.target.value; });
    $('#pairAutoBackground').addEventListener('change', renderPairResults);
    $('#pairDefaultLoadVolume').addEventListener('change', event => {
      const value = number(event.target.value, pair.defaultLoadVolume);
      if (value > 0) pair.defaultLoadVolume = value;
      else event.target.value = pair.defaultLoadVolume;
      renderPairResults();
    });
    $('#applyPairDefaultLoad').addEventListener('click', () => {
      pairResultRows().forEach(row => { pair.loads[row.lane] = pair.defaultLoadVolume; });
      renderPairResults();
      toastMessage(`已将 ${pair.defaultLoadVolume} µL 应用到全部泳道。`);
    });
    $('#exportPairWb').addEventListener('click', exportPairWb);
    $('#clearPairWb').addEventListener('click', clearPairWorkspace);
    $('#figureImageInput').addEventListener('change', event => loadFigureImages(event.target.files));
    $('#usePairValues').addEventListener('click', usePairValuesForFigure);
    $('#exportWbFigure').addEventListener('click', exportWbFigure);
    $('#exportWbFigureSvg').addEventListener('click', exportWbFigureSvg);
    $('#printWbFigurePdf').addEventListener('click', printWbFigurePdf);
    $('#renderWbFigure').addEventListener('click', () => renderWbFigure());
    $('#toggleFigureManual').addEventListener('click', startFigureManualEdit);
    $('#selectFigureGuide').addEventListener('click', () => setFigureEditTool('select'));
    $('#addFigureGuide').addEventListener('click', () => setFigureEditTool('add'));
    $('#deleteFigureGuide').addEventListener('click', deleteSelectedFigureGuide);
    $('#clearFigureManual').addEventListener('click', clearFigureManualEdit);
    ['figureLaneNames', 'figureValues', 'figureLaneCount', 'figureSideFontSize', 'figureValueFontSize', 'figureLaneFontSize', 'figureCropPadding', 'figureBackgroundStrength', 'figureShowValues', 'figureWhiteBackground', 'figurePreserveColor', 'figureAutoDeskew', 'figureGroupLabels', 'figureTemplate', 'figureCustomWidthMm', 'figureDpi', 'figurePanelLetters'].forEach(id => {
      const changeOnly = ['figureShowValues', 'figureWhiteBackground', 'figurePreserveColor', 'figureAutoDeskew', 'figureTemplate'].includes(id);
      $(`#${id}`).addEventListener(changeOnly ? 'change' : 'input', () => {
        if (id === 'figureWhiteBackground') {
          const enabled = $('#figureWhiteBackground').checked;
          $('#figureBackgroundStrength').disabled = !enabled;
          $('#figurePreserveColor').disabled = !enabled;
        }
        renderWbFigure();
      });
    });
    $('#figurePanelInputs').addEventListener('input', event => {
      const index = Number(event.target.dataset.figureIndex);
      const field = event.target.dataset.figureField;
      if (!Number.isInteger(index) || !field || !figure.images[index]) return;
      figure.images[index][field] = event.target.value;
      renderWbFigure();
    });
    $('#figurePanelInputs').addEventListener('change', event => {
      if (!event.target.hasAttribute('data-figure-centers')) return;
      const index = Number(event.target.dataset.figureIndex);
      const entry = figure.images[index];
      if (!entry) return;
      const centers = parseFigureList(event.target.value)
        .map(value => number(value, NaN) / 100)
        .filter(value => Number.isFinite(value) && value >= 0 && value <= 1)
        .sort((a, b) => a - b);
      if (centers.length) entry.manualCenters = centers;
      else delete entry.manualCenters;
      figure.editing = figure.images.some(item => item.manualCenters?.length);
      renderFigurePanelInputs();
      renderWbFigure();
    });
    bindPairCanvas(pair.reference);
    bindPairCanvas(pair.target);
    bindFigureCanvas();
    document.addEventListener('keydown', event => {
      const editable = event.target.matches('input, textarea, select, [contenteditable="true"]');
      if (editable || !(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === 'z') { event.preventDefault(); event.shiftKey ? redoAction() : undoAction(); }
      if (event.key.toLowerCase() === 'y') { event.preventDefault(); redoAction(); }
    });
  }

  bindGlobalEvents();
  renderQpcr();
  updateWb();
  renderPairResults();
  drawFigureEmptyState();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').then(registration => {
        registration.addEventListener('updatefound', () => {
          const worker = registration.installing;
          worker?.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toastMessage('检测到网站新版本，请刷新页面后使用。');
            }
          });
        });
      }).catch(error => console.warn('离线缓存注册失败：', error));
    });
  }
})();
