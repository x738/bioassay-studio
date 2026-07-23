(function initializeExperimentLibrary() {
  'use strict';

  const Core = window.ExperimentCore;
  const mount = document.getElementById('experimentLibraryMount');
  if (!Core || !mount) return;

  const DB_NAME = 'bioassay-experiment-library';
  const DB_VERSION = 1;
  const STORE_NAMES = ['recipes', 'protocols', 'stocks', 'chemicals', 'ocrRecords', 'calculations', 'attachments', 'tags'];
  const PAGE_LABELS = {
    home: '知识库首页',
    recipes: '实验配方',
    protocols: '实验方法',
    ocr: 'OCR 导入',
    calculator: '智能计算器',
    search: '搜索中心',
  };

  const state = {
    db: null,
    page: 'home',
    selection: null,
    records: Object.fromEntries(STORE_NAMES.map(name => [name, []])),
    autosaveTimers: new Map(),
    pendingSaves: new Map(),
    autosaveState: 'saved',
    calculatorTab: 'buffer',
    calculatorDraft: {
      buffer: {
        name: 'Extraction Buffer',
        finalVolume: 50,
        finalVolumeUnit: 'mL',
        targetPh: '7.5',
        storage: '4℃',
        components: [
          { id: uid('component'), name: 'HEPES', targetValue: 50, targetUnit: 'mM', sourceType: 'auto', stockId: '', molecularWeight: 238.30 },
          { id: uid('component'), name: 'NaCl', targetValue: 150, targetUnit: 'mM', sourceType: 'auto', stockId: '', molecularWeight: 58.44 },
        ],
      },
      molarity: { chemicalName: 'HEPES', concentration: 50, concentrationUnit: 'mM', volume: 50, volumeUnit: 'mL', molecularWeight: 238.30 },
      stock: { stockConcentration: 1, stockUnit: 'M', targetConcentration: 50, targetUnit: 'mM', finalVolume: 50, finalVolumeUnit: 'mL' },
      dilution: { c1: 1, v1: '', c2: 0.05, v2: 50 },
      percentage: { value: 10, kind: 'w/v', finalVolume: 50, finalVolumeUnit: 'mL', sourceUnit: 'mg/mL', targetUnit: 'µg/mL' },
    },
    calculatorResult: null,
    searchQuery: '',
    searchResults: [],
    objectUrls: new Set(),
    storage: { persisted: false, usage: 0, quota: 0 },
    print: {
      open: false,
      selectedKeys: [],
      paper: 'A4',
      orientation: 'portrait',
      fontSize: 10.5,
      includeMetadata: true,
      includeNotes: true,
      includeAttachments: true,
    },
  };

  function uid(prefix = 'item') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function now() {
    return new Date().toISOString();
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/\n/g, '&#10;');
  }

  function dateText(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
  }

  function fileSizeText(bytes) {
    if (!(bytes > 0)) return '0 MB';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  }

  async function inspectStorage() {
    if (!navigator.storage) return;
    try {
      let persisted = typeof navigator.storage.persisted === 'function' ? await navigator.storage.persisted() : false;
      if (!persisted && typeof navigator.storage.persist === 'function') persisted = await navigator.storage.persist();
      const estimate = typeof navigator.storage.estimate === 'function' ? await navigator.storage.estimate() : {};
      state.storage = {
        persisted: Boolean(persisted),
        usage: Number(estimate.usage) || 0,
        quota: Number(estimate.quota) || 0,
      };
    } catch (error) {
      console.warn('Storage inspection failed', error);
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        STORE_NAMES.forEach(name => {
          if (db.objectStoreNames.contains(name)) return;
          const store = db.createObjectStore(name, { keyPath: 'id' });
          if (name !== 'attachments' && name !== 'calculations') store.createIndex('updatedAt', 'updatedAt');
          if (['recipes', 'protocols', 'stocks', 'chemicals'].includes(name)) store.createIndex('name', 'name');
          if (name === 'attachments') {
            store.createIndex('ownerKey', 'ownerKey');
            store.createIndex('createdAt', 'createdAt');
          }
          if (name === 'calculations') store.createIndex('createdAt', 'createdAt');
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transaction(storeName, mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = state.db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error || request?.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  const dbGetAll = storeName => transaction(storeName, 'readonly', store => store.getAll());
  const dbGet = (storeName, id) => transaction(storeName, 'readonly', store => store.get(id));
  const dbPut = (storeName, value) => transaction(storeName, 'readwrite', store => store.put(value));
  const dbDelete = (storeName, id) => transaction(storeName, 'readwrite', store => store.delete(id));
  const dbClear = storeName => transaction(storeName, 'readwrite', store => store.clear());

  async function loadRecords() {
    const entries = await Promise.all(STORE_NAMES.map(async storeName => {
      const records = await dbGetAll(storeName);
      if (storeName !== 'attachments') return [storeName, records];
      return [storeName, records.map(({ blob, ...metadata }) => metadata)];
    }));
    state.records = Object.fromEntries(entries);
    Object.values(state.records).forEach(list => list.sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''))));
  }

  async function seedChemicals() {
    if (state.records.chemicals.length) return;
    const timestamp = now();
    for (const item of Core.CHEMICALS) {
      await dbPut('chemicals', {
        ...clone(item),
        id: uid('chemical'),
        category: '常用生化试剂',
        notes: '内置基础数据；不同水合物或盐型的分子量不同，正式配制前请核对试剂瓶标签。',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    state.records.chemicals = await dbGetAll('chemicals');
  }

  function selectedRecord() {
    if (!state.selection) return null;
    return state.records[state.selection.store]?.find(item => item.id === state.selection.id) || null;
  }

  function setTheme(mode) {
    const normalized = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
    localStorage.setItem('bioassay-experiment-theme', normalized);
    if (normalized === 'system') delete document.documentElement.dataset.elTheme;
    else document.documentElement.dataset.elTheme = normalized;
    const button = document.querySelector('[data-el-action="cycle-theme"]');
    if (button) button.textContent = normalized === 'system' ? '主题：跟随系统' : normalized === 'light' ? '主题：浅色' : '主题：深色';
  }

  function cycleTheme() {
    const current = localStorage.getItem('bioassay-experiment-theme') || 'system';
    setTheme(current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system');
  }

  function notice(message, tone = 'info') {
    const target = document.getElementById('elNotice');
    if (!target) return;
    target.textContent = message;
    target.className = `el-notice ${tone}`;
    window.clearTimeout(notice.timer);
    notice.timer = window.setTimeout(() => {
      target.textContent = '全部数据仅保存在当前浏览器';
      target.className = 'el-notice';
    }, 4200);
  }

  function setAutosaveState(value) {
    state.autosaveState = value;
    const target = document.getElementById('elAutosaveStatus');
    if (!target) return;
    const labels = { saving: '正在保存…', saved: '已自动保存', error: '保存失败' };
    target.textContent = labels[value] || value;
    target.dataset.state = value;
  }

  function pageStore(page) {
    return page === 'recipes' ? 'recipes' : page === 'protocols' ? 'protocols' : page === 'ocr' ? 'ocrRecords' : null;
  }

  function recordLabel(store) {
    return {
      recipes: '配方',
      protocols: '方法',
      stocks: '母液',
      chemicals: '试剂',
      ocrRecords: 'OCR 记录',
    }[store] || '记录';
  }

  function groupByCategory(list) {
    return list.reduce((map, item) => {
      const key = String(item.category || '未分类').trim() || '未分类';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
      return map;
    }, new Map());
  }

  function renderTree() {
    const recipeGroups = groupByCategory(state.records.recipes);
    const protocolGroups = groupByCategory(state.records.protocols);
    const section = (title, store, groups) => `
      <section class="el-tree-section">
        <div class="el-tree-title"><span>${title}</span><button type="button" data-el-new="${store}" title="新建${title}">＋</button></div>
        ${groups.size ? [...groups.entries()].map(([category, items]) => `
          <details open>
            <summary>${escapeHtml(category)} <small>${items.length}</small></summary>
            ${items.map(item => `<button type="button" class="el-tree-item ${state.selection?.id === item.id ? 'active' : ''}" data-el-open="${store}" data-el-id="${item.id}"><span>${item.favorite ? '★' : ''} ${escapeHtml(item.name || item.title || '未命名')}</span><small>v${item.version || 1}</small></button>`).join('')}
          </details>
        `).join('') : '<p class="el-empty-tree">暂无记录</p>'}
      </section>`;
    return [
      section('配方目录', 'recipes', recipeGroups),
      section('实验方法', 'protocols', protocolGroups),
      `<section class="el-tree-section"><div class="el-tree-title"><span>母液库</span><button type="button" data-el-new="stocks" title="新建母液">＋</button></div>
        ${state.records.stocks.length ? state.records.stocks.map(item => `<button type="button" class="el-tree-item ${state.selection?.id === item.id ? 'active' : ''}" data-el-open="stocks" data-el-id="${item.id}"><span>${escapeHtml(item.name || '未命名母液')}</span><small>${escapeHtml(String(item.concentration || ''))} ${escapeHtml(item.unit || '')}</small></button>`).join('') : '<p class="el-empty-tree">暂无母液</p>'}
      </section>`,
    ].join('');
  }

  function renderShell() {
    mount.innerHTML = `
      <div class="el-toolbar">
        <div>
          <span class="el-offline-badge">OFFLINE · IndexedDB · ${state.storage.persisted ? '持久存储' : '建议定期备份'}${state.storage.usage ? ` · ${fileSizeText(state.storage.usage)}` : ''}</span>
          <strong>个人实验知识库</strong>
          <span id="elAutosaveStatus" data-state="${state.autosaveState}">已自动保存</span>
        </div>
        <div class="el-toolbar-actions">
          <span id="elNotice" class="el-notice">全部数据仅保存在当前浏览器</span>
          <button type="button" data-el-action="open-print">打印 / 预览</button>
          <button type="button" data-el-action="export-library">导出备份</button>
          <label class="el-file-button">导入备份<input id="elBackupInput" type="file" accept=".json,application/json" /></label>
          <button type="button" data-el-action="cycle-theme">主题：跟随系统</button>
        </div>
      </div>
      <div class="el-shell">
        <aside class="el-sidebar">
          <nav class="el-subnav" aria-label="实验知识库">
            ${Object.entries(PAGE_LABELS).map(([key, label]) => `<button type="button" class="${state.page === key ? 'active' : ''}" data-el-page="${key}"><span class="el-nav-dot"></span>${label}</button>`).join('')}
          </nav>
          <div class="el-quick-create">
            <button type="button" data-el-new="recipes">＋ 新建配方</button>
            <button type="button" data-el-new="protocols">＋ 新建方法</button>
          </div>
          <div id="elTree" class="el-tree">${renderTree()}</div>
        </aside>
        <section id="elMain" class="el-main">${renderMain()}</section>
        <aside id="elProperties" class="el-properties">${renderProperties()}</aside>
      </div>
      ${renderPrintDialog()}`;
    setTheme(localStorage.getItem('bioassay-experiment-theme') || 'system');
  }

  function renderMain() {
    const record = selectedRecord();
    if (record && state.selection.store === 'recipes') return renderRecipeEditor(record);
    if (record && state.selection.store === 'protocols') return renderProtocolEditor(record);
    if (record && state.selection.store === 'stocks') return renderStockEditor(record);
    if (record && state.selection.store === 'ocrRecords') return renderOcrEditor(record);
    if (state.page === 'home') return renderHome();
    if (state.page === 'recipes') return renderRecipeLibrary();
    if (state.page === 'protocols') return renderProtocolLibrary();
    if (state.page === 'ocr') return renderOcrLanding();
    if (state.page === 'calculator') return renderCalculator();
    if (state.page === 'search') return renderSearch();
    return renderHome();
  }

  function renderProperties() {
    const record = selectedRecord();
    if (!record) {
      return `
        <div class="el-properties-empty">
          <span>属性面板</span>
          <h3>选择一条记录</h3>
          <p>这里会显示分类、标签、收藏、版本、附件和修改时间。</p>
        </div>
        <div class="el-safety-card"><b>本地优先</b><p>知识库数据不会发送到服务器。建议定期使用“导出备份”。</p></div>`;
    }
    const ownerKey = `${state.selection.store}:${record.id}`;
    const attachments = state.records.attachments.filter(item => item.ownerKey === ownerKey);
    return `
      <div class="el-properties-head">
        <span>${recordLabel(state.selection.store)}属性</span>
        <button type="button" data-el-action="toggle-favorite" class="${record.favorite ? 'active' : ''}">${record.favorite ? '★ 已收藏' : '☆ 收藏'}</button>
      </div>
      <label>分类<input data-el-field="category" value="${escapeAttr(record.category || '')}" placeholder="如：Buffer / 蛋白提取" /></label>
      <label>标签（逗号分隔）<input data-el-field="tags" value="${escapeAttr((record.tags || []).join(', '))}" placeholder="如：WB, 蛋白, 4℃" /></label>
      <label>备注<textarea data-el-field="notes" rows="5" placeholder="记录适用范围、替代条件或经验">${escapeHtml(record.notes || '')}</textarea></label>
      <div class="el-property-grid">
        <div><span>版本</span><b>v${record.version || 1}</b></div>
        <div><span>修改</span><b>${escapeHtml(dateText(record.updatedAt))}</b></div>
      </div>
      <button type="button" class="el-secondary-action" data-el-action="new-version">生成新版本</button>
      <section class="el-attachment-panel">
        <div class="el-property-section-title"><span>附件与图片</span><small>${attachments.length}</small></div>
        <label class="el-attachment-upload">＋ 添加附件<input id="elAttachmentInput" type="file" multiple /></label>
        <div class="el-attachment-list">
          ${attachments.length ? attachments.map(item => `<div><button type="button" data-el-action="download-attachment" data-el-id="${item.id}">${escapeHtml(item.name)}</button><button type="button" data-el-action="delete-attachment" data-el-id="${item.id}" title="删除">×</button></div>`).join('') : '<p>暂无附件</p>'}
        </div>
      </section>
      <button type="button" class="el-danger-action" data-el-action="delete-record">删除此${recordLabel(state.selection.store)}</button>`;
  }

  function renderHome() {
    const recent = [
      ...state.records.recipes.map(item => ({ ...item, store: 'recipes' })),
      ...state.records.protocols.map(item => ({ ...item, store: 'protocols' })),
      ...state.records.stocks.map(item => ({ ...item, store: 'stocks' })),
    ].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 8);
    const favorites = recent.filter(item => item.favorite).slice(0, 5);
    return `
      <div class="el-page-heading">
        <div><p>EXPERIMENT LIBRARY</p><h3>把实验经验变成可复用的数据</h3><span>配方、母液、计算、方法和 OCR 记录在浏览器中互相关联。</span></div>
        <button type="button" class="el-primary-action" data-el-page="calculator">开始计算配方</button>
      </div>
      <div class="el-dashboard-metrics">
        <button type="button" data-el-page="recipes"><b>${state.records.recipes.length}</b><span>实验配方</span><small>${state.records.stocks.length} 个母液可调用</small></button>
        <button type="button" data-el-page="protocols"><b>${state.records.protocols.length}</b><span>实验方法</span><small>支持 Markdown 与附件</small></button>
        <button type="button" data-el-page="calculator"><b>${state.records.calculations.length}</b><span>计算历史</span><small>可重新打开和生成配方</small></button>
        <button type="button" data-el-page="ocr"><b>${state.records.ocrRecords.length}</b><span>OCR 记录</span><small>识别后人工确认再入库</small></button>
      </div>
      <div class="el-dashboard-grid">
        <section class="el-card">
          <div class="el-card-title"><div><h4>最近修改</h4><p>继续上次未完成的实验准备</p></div></div>
          <div class="el-record-list">
            ${recent.length ? recent.map(item => recordListButton(item, item.store)).join('') : '<div class="el-empty-state"><b>知识库还是空的</b><span>先新建一个配方，或用智能计算器生成。</span></div>'}
          </div>
        </section>
        <section class="el-card">
          <div class="el-card-title"><div><h4>收藏与建议</h4><p>固定常用配方，减少重复录入</p></div></div>
          ${favorites.length ? favorites.map(item => recordListButton(item, item.store)).join('') : `
            <div class="el-guide-list">
              <div><span>1</span><p><b>先建立母液</b>计算器会优先调用同名母液。</p></div>
              <div><span>2</span><p><b>计算后生成配方</b>实际加入量、依据和时间会永久保存。</p></div>
              <div><span>3</span><p><b>修改后新建版本</b>保留历史，不覆盖原始记录。</p></div>
            </div>`}
        </section>
      </div>`;
  }

  function recordListButton(item, store) {
    return `<button type="button" class="el-record-row" data-el-open="${store}" data-el-id="${item.id}">
      <span class="el-record-icon">${store === 'recipes' ? 'R' : store === 'protocols' ? 'P' : 'S'}</span>
      <span><b>${escapeHtml(item.name || item.title || '未命名')}</b><small>${escapeHtml(item.category || '未分类')} · ${escapeHtml(dateText(item.updatedAt))}</small></span>
      <i>›</i>
    </button>`;
  }

  function renderRecipeLibrary() {
    return `
      <div class="el-page-heading compact"><div><p>RECIPE LIBRARY</p><h3>实验配方与母液</h3><span>选择左侧目录中的配方，或从计算器生成一个新配方。</span></div><button type="button" class="el-primary-action" data-el-new="recipes">＋ 新建配方</button></div>
      <div class="el-library-split">
        <section class="el-card"><div class="el-card-title"><div><h4>全部配方</h4><p>${state.records.recipes.length} 条记录</p></div></div>
          <div class="el-record-list">${state.records.recipes.length ? state.records.recipes.map(item => recordListButton(item, 'recipes')).join('') : '<div class="el-empty-state"><b>暂无配方</b><span>可以直接新建，也可以从智能计算器保存。</span></div>'}</div>
        </section>
        <section class="el-card"><div class="el-card-title"><div><h4>Stock Solution</h4><p>计算器自动匹配同名母液</p></div><button type="button" data-el-new="stocks">＋</button></div>
          <div class="el-record-list">${state.records.stocks.length ? state.records.stocks.map(item => recordListButton(item, 'stocks')).join('') : '<div class="el-empty-state"><b>暂无母液</b><span>建立 1 M HEPES、1 M MgCl₂ 等常用母液。</span></div>'}</div>
        </section>
      </div>`;
  }

  function renderProtocolLibrary() {
    return `
      <div class="el-page-heading compact"><div><p>PROTOCOL LIBRARY</p><h3>实验方法</h3><span>以 Markdown 记录材料、步骤、注意事项、问题与文献。</span></div><button type="button" class="el-primary-action" data-el-new="protocols">＋ 新建方法</button></div>
      <section class="el-card"><div class="el-record-grid">${state.records.protocols.length ? state.records.protocols.map(item => `
        <button type="button" class="el-protocol-tile" data-el-open="protocols" data-el-id="${item.id}">
          <span>${item.favorite ? '★ 收藏' : escapeHtml(item.category || '实验方法')}</span><h4>${escapeHtml(item.name || '未命名')}</h4>
          <p>${escapeHtml(item.purpose || '尚未填写实验目的')}</p><small>v${item.version || 1} · ${escapeHtml(dateText(item.updatedAt))}</small>
      </button>`).join('') : '<div class="el-empty-state"><b>暂无实验方法</b><span>创建 BN-PAGE、Co-IP、免疫印迹等 Protocol。</span></div>'}</div></section>`;
  }

  function componentOptions(selected) {
    const units = ['mM', 'M', 'µM', '% (w/v)', '% (v/v)'];
    return units.map(unit => `<option ${selected === unit ? 'selected' : ''}>${unit}</option>`).join('');
  }

  function sourceOptions(selected) {
    return [
      ['auto', '自动选择'],
      ['solid', '固体称量'],
      ['stock', '调用母液'],
    ].map(([value, label]) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`).join('');
  }

  function stockOptions(selected, name = '') {
    const matching = state.records.stocks.filter(stock => !name || String(stock.name || '').toLowerCase().includes(String(name).toLowerCase()) || String(name).toLowerCase().includes(String(stock.name || '').toLowerCase()));
    const list = matching.length ? matching : state.records.stocks;
    return `<option value="">自动匹配 / 未选择</option>${list.map(stock => `<option value="${stock.id}" ${selected === stock.id ? 'selected' : ''}>${escapeHtml(stock.name)} · ${escapeHtml(String(stock.concentration || ''))} ${escapeHtml(stock.unit || '')}</option>`).join('')}`;
  }

  function renderRecipeEditor(recipe) {
    return `
      <div class="el-editor-head">
        <div><span>实验配方 · v${recipe.version || 1}</span><input class="el-title-input" data-el-field="name" value="${escapeAttr(recipe.name || '')}" placeholder="配方名称" /></div>
        <div><button type="button" data-el-action="print-current">打印预览</button><button type="button" data-el-action="copy-recipe">复制表格</button><button type="button" class="primary" data-el-action="recalculate-recipe">重新计算</button></div>
      </div>
      <div class="el-recipe-meta-grid">
        <label>目标体积<div class="el-inline-field"><input data-el-field="targetVolume" type="number" min="0.000001" step="any" value="${escapeAttr(recipe.targetVolume || '')}" /><select data-el-field="targetVolumeUnit">${['mL', 'L', 'µL'].map(unit => `<option ${recipe.targetVolumeUnit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></div></label>
        <label>目标 pH<input data-el-field="targetPh" value="${escapeAttr(recipe.targetPh || '')}" placeholder="如：7.5" /></label>
        <label>保存条件<input data-el-field="storage" value="${escapeAttr(recipe.storage || '')}" placeholder="如：4℃，1 个月" /></label>
        <label>用途<input data-el-field="purpose" value="${escapeAttr(recipe.purpose || '')}" placeholder="此配方用于什么实验" /></label>
      </div>
      <section class="el-editor-section">
        <div class="el-section-title"><div><h4>配方组成</h4><p>“自动选择”会优先调用同名母液；没有母液时按分子量称量。</p></div><button type="button" data-el-action="add-component">＋ 添加成分</button></div>
        <div class="el-table-wrap">
          <table class="el-recipe-table">
            <thead><tr><th>成分</th><th>最终浓度</th><th>来源</th><th>母液</th><th>分子量</th><th>实际加入量</th><th>计算依据</th><th></th></tr></thead>
            <tbody>${(recipe.components || []).map((component, index) => `
              <tr>
                <td><input data-el-component="${index}" data-el-component-field="name" value="${escapeAttr(component.name || '')}" placeholder="HEPES" /></td>
                <td><div class="el-concentration-field"><input data-el-component="${index}" data-el-component-field="targetValue" type="number" min="0" step="any" value="${escapeAttr(component.targetValue || '')}" /><select data-el-component="${index}" data-el-component-field="targetUnit">${componentOptions(component.targetUnit)}</select></div></td>
                <td><select data-el-component="${index}" data-el-component-field="sourceType">${sourceOptions(component.sourceType || 'auto')}</select></td>
                <td><select data-el-component="${index}" data-el-component-field="stockId">${stockOptions(component.stockId, component.name)}</select></td>
                <td><input data-el-component="${index}" data-el-component-field="molecularWeight" type="number" min="0" step="any" value="${escapeAttr(component.molecularWeight || '')}" placeholder="MW" /></td>
                <td class="el-amount">${escapeHtml(Core.formatQuantity(component.actualAmount))}</td>
                <td class="el-basis">${escapeHtml(component.basis || '点击“重新计算”')}</td>
                <td><button type="button" class="el-row-delete" data-el-action="delete-component" data-el-index="${index}">×</button></td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>
      <section class="el-editor-section">
        <div class="el-section-title"><div><h4>配制步骤</h4><p>计算后自动生成；可继续手动修改。</p></div><button type="button" data-el-action="reset-protocol">按配方重新生成</button></div>
        <ol class="el-step-list">${(recipe.steps || []).map((step, index) => `<li><span>Step ${index + 1}</span><textarea data-el-step="${index}" rows="2">${escapeHtml(step)}</textarea><button type="button" data-el-action="delete-step" data-el-index="${index}">×</button></li>`).join('')}</ol>
        <button type="button" class="el-add-step" data-el-action="add-step">＋ 添加步骤</button>
      </section>
      <section class="el-calculation-provenance">
        <div><span>计算时间</span><b>${escapeHtml(dateText(recipe.calculatedAt))}</b></div>
        <div><span>计算依据</span><b>m = C × V × MW / C1V1 = C2V2</b></div>
        <div><span>目标体积</span><b>${escapeHtml(String(recipe.targetVolume || '—'))} ${escapeHtml(recipe.targetVolumeUnit || '')}</b></div>
      </section>`;
  }

  function renderProtocolEditor(protocol) {
    return `
      <div class="el-editor-head">
        <div><span>实验方法 · Markdown · v${protocol.version || 1}</span><input class="el-title-input" data-el-field="name" value="${escapeAttr(protocol.name || '')}" placeholder="实验名称" /></div>
        <div><button type="button" data-el-action="print-current">打印预览</button><button type="button" data-el-action="toggle-protocol-preview">${protocol.preview ? '编辑 Markdown' : '预览'}</button></div>
      </div>
      <div class="el-protocol-meta">
        <label>实验目的<textarea data-el-field="purpose" rows="3" placeholder="说明实验要回答的问题">${escapeHtml(protocol.purpose || '')}</textarea></label>
        <label>实验材料<textarea data-el-field="materials" rows="3" placeholder="试剂、样本、耗材和仪器">${escapeHtml(protocol.materials || '')}</textarea></label>
      </div>
      ${protocol.preview ? `<article class="el-markdown-preview">${renderMarkdown(protocol.markdown || '')}</article>` : `<label class="el-markdown-editor">实验步骤（Markdown）<textarea data-el-field="markdown" rows="18" placeholder="# 实验步骤&#10;&#10;1. 准备样品&#10;2. ...">${escapeHtml(protocol.markdown || '')}</textarea></label>`}
      <div class="el-protocol-meta bottom">
        <label>注意事项<textarea data-el-field="cautions" rows="5">${escapeHtml(protocol.cautions || '')}</textarea></label>
        <label>常见问题<textarea data-el-field="troubleshooting" rows="5">${escapeHtml(protocol.troubleshooting || '')}</textarea></label>
        <label class="wide">参考文献<textarea data-el-field="references" rows="4" placeholder="DOI、网页、论文或实验室来源">${escapeHtml(protocol.references || '')}</textarea></label>
      </div>`;
  }

  function renderMarkdown(source) {
    const safe = escapeHtml(source || '');
    if (!safe.trim()) return '<p class="el-muted">尚未填写 Markdown 内容。</p>';
    return safe
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`(.+?)`/g, '<code>$1</code>')
      .replace(/^\s*[-*] (.+)$/gm, '<li>$1</li>')
      .replace(/^\s*\d+\. (.+)$/gm, '<li>$1</li>')
      .replace(/(?:<li>.*<\/li>\n?)+/g, match => `<ul>${match}</ul>`)
      .split(/\n{2,}/)
      .map(block => /^<(h\d|ul)/.test(block) ? block : `<p>${block.replace(/\n/g, '<br>')}</p>`)
      .join('');
  }

  function printableEntries() {
    return [
      ...state.records.recipes.map(record => ({ store: 'recipes', record, key: `recipes:${record.id}`, kind: '实验配方' })),
      ...state.records.protocols.map(record => ({ store: 'protocols', record, key: `protocols:${record.id}`, kind: '实验方法' })),
      ...state.records.stocks.map(record => ({ store: 'stocks', record, key: `stocks:${record.id}`, kind: '母液配置' })),
    ].sort((a, b) => String(b.record.updatedAt || '').localeCompare(String(a.record.updatedAt || '')));
  }

  function openPrintDialog(currentOnly = false) {
    const entries = printableEntries();
    const currentKey = state.selection && ['recipes', 'protocols', 'stocks'].includes(state.selection.store)
      ? `${state.selection.store}:${state.selection.id}`
      : '';
    const validKeys = new Set(entries.map(item => item.key));
    const retained = state.print.selectedKeys.filter(key => validKeys.has(key));
    state.print.selectedKeys = currentOnly && currentKey
      ? [currentKey]
      : retained.length
        ? retained
        : currentKey
          ? [currentKey]
          : entries[0]
            ? [entries[0].key]
            : [];
    state.print.open = true;
    renderShell();
  }

  function closePrintDialog() {
    state.print.open = false;
    renderShell();
  }

  function printValue(value, fallback = '—') {
    const text = String(value ?? '').trim();
    return escapeHtml(text || fallback);
  }

  function renderPrintMetadata(items) {
    const visible = items.filter(([, value]) => String(value ?? '').trim());
    if (!state.print.includeMetadata || !visible.length) return '';
    return `<dl class="el-print-meta">${visible.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${printValue(value)}</dd></div>`).join('')}</dl>`;
  }

  function renderPrintTextSection(title, value) {
    const text = String(value || '').trim();
    if (!text) return '';
    return `<section class="el-print-section"><h2>${escapeHtml(title)}</h2><div class="el-print-prose">${escapeHtml(text).replace(/\n/g, '<br>')}</div></section>`;
  }

  function renderPrintAttachments(store, record) {
    if (!state.print.includeAttachments) return '';
    const ownerKey = `${store}:${record.id}`;
    const attachments = state.records.attachments.filter(item => item.ownerKey === ownerKey);
    if (!attachments.length) return '';
    return `<section class="el-print-section el-print-attachments"><h2>附件清单</h2><ul>${attachments.map(item => `<li>${escapeHtml(item.name || '未命名附件')} <span>${escapeHtml(item.type || '')}${item.size ? ` · ${fileSizeText(item.size)}` : ''}</span></li>`).join('')}</ul></section>`;
  }

  function renderRecipePrint(recipe) {
    const rows = (recipe.components || []).map(component => {
      const stock = state.records.stocks.find(item => item.id === component.stockId);
      const source = stock
        ? `${stock.name || '母液'} (${stock.concentration || ''} ${stock.unit || ''})`
        : component.sourceType === 'solid'
          ? '固体称量'
          : component.sourceType === 'stock'
            ? '调用母液'
            : '自动选择';
      return `<tr>
        <td>${printValue(component.name)}</td>
        <td>${printValue(`${component.targetValue ?? ''} ${component.targetUnit || ''}`)}</td>
        <td>${printValue(source)}</td>
        <td>${printValue(component.molecularWeight)}</td>
        <td><strong>${printValue(Core.formatQuantity(component.actualAmount))}</strong></td>
        <td>${printValue(component.basis)}</td>
      </tr>`;
    }).join('');
    const steps = (recipe.steps || []).filter(step => String(step || '').trim());
    return `
      ${renderPrintMetadata([
        ['用途', recipe.purpose],
        ['目标体积', `${recipe.targetVolume || '—'} ${recipe.targetVolumeUnit || ''}`],
        ['目标 pH', recipe.targetPh],
        ['保存条件', recipe.storage],
        ['分类', recipe.category],
        ['标签', (recipe.tags || []).join('、')],
      ])}
      <section class="el-print-section">
        <h2>配方组成</h2>
        <table class="el-print-table">
          <thead><tr><th>成分</th><th>最终浓度</th><th>来源 / 母液</th><th>MW</th><th>实际加入量</th><th>计算依据</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="6">尚未填写配方成分</td></tr>'}</tbody>
        </table>
      </section>
      <section class="el-print-section">
        <h2>配制步骤</h2>
        ${steps.length ? `<ol class="el-print-steps">${steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol>` : '<p class="el-print-empty">尚未填写配制步骤。</p>'}
      </section>
      ${state.print.includeNotes ? renderPrintTextSection('备注', recipe.notes) : ''}
      ${renderPrintAttachments('recipes', recipe)}`;
  }

  function renderProtocolPrint(protocol) {
    return `
      ${renderPrintMetadata([
        ['分类', protocol.category],
        ['标签', (protocol.tags || []).join('、')],
        ['创建时间', dateText(protocol.createdAt)],
        ['修改时间', dateText(protocol.updatedAt)],
      ])}
      ${renderPrintTextSection('实验目的', protocol.purpose)}
      ${renderPrintTextSection('实验材料', protocol.materials)}
      <section class="el-print-section">
        <h2>实验步骤</h2>
        <article class="el-print-markdown">${renderMarkdown(protocol.markdown || '')}</article>
      </section>
      ${renderPrintTextSection('注意事项', protocol.cautions)}
      ${renderPrintTextSection('常见问题', protocol.troubleshooting)}
      ${renderPrintTextSection('参考文献', protocol.references)}
      ${state.print.includeNotes ? renderPrintTextSection('备注', protocol.notes) : ''}
      ${renderPrintAttachments('protocols', protocol)}`;
  }

  function renderStockPrint(stock) {
    const chemical = state.records.chemicals.find(item => item.id === stock.chemicalId);
    const records = (stock.records || []).map(row => `<tr><td>${printValue(row.date)}</td><td>${printValue(row.volume)}</td><td>${printValue(row.operator)}</td><td>${printValue(row.notes)}</td></tr>`).join('');
    return `
      ${renderPrintMetadata([
        ['对应试剂', chemical?.name],
        ['母液浓度', `${stock.concentration || '—'} ${stock.unit || ''}`],
        ['分子量', stock.molecularWeight || chemical?.molecularWeight],
        ['有效期', stock.expiryDays ? `${stock.expiryDays} 天` : ''],
        ['保存条件', stock.storage],
        ['分类', stock.category],
        ['标签', (stock.tags || []).join('、')],
      ])}
      ${renderPrintTextSection('配制方法', stock.preparation)}
      ${records ? `<section class="el-print-section"><h2>配置记录</h2><table class="el-print-table"><thead><tr><th>日期</th><th>体积</th><th>操作者</th><th>备注</th></tr></thead><tbody>${records}</tbody></table></section>` : ''}
      ${state.print.includeNotes ? renderPrintTextSection('备注', stock.notes) : ''}
      ${renderPrintAttachments('stocks', stock)}`;
  }

  function renderPrintRecord(entry, index, total) {
    const record = entry.record;
    const content = entry.store === 'recipes'
      ? renderRecipePrint(record)
      : entry.store === 'protocols'
        ? renderProtocolPrint(record)
        : renderStockPrint(record);
    return `<article class="el-print-record">
      <header class="el-print-record-head">
        <div><span>BIOASSAY STUDIO · ${escapeHtml(entry.kind.toUpperCase())}</span><h1>${escapeHtml(record.name || '未命名')}</h1></div>
        <div><b>v${record.version || 1}</b><small>${escapeHtml(dateText(record.updatedAt))}</small></div>
      </header>
      ${content}
      <footer class="el-print-footer"><span>BioAssay Studio v${escapeHtml(document.documentElement.dataset.appVersion || '2.8.1')}</span><span>${index + 1} / ${total} · 打印预览生成于 ${escapeHtml(dateText(now()))}</span></footer>
    </article>`;
  }

  function renderPrintDialog() {
    if (!state.print.open) return '';
    const entries = printableEntries();
    const selected = new Set(state.print.selectedKeys);
    const selectedEntries = entries.filter(item => selected.has(item.key));
    const list = entries.length
      ? entries.map(item => `<label class="el-print-choice">
          <input type="checkbox" data-el-print-key="${escapeAttr(item.key)}" ${selected.has(item.key) ? 'checked' : ''} />
          <span><b>${escapeHtml(item.record.name || '未命名')}</b><small>${escapeHtml(item.kind)} · ${escapeHtml(item.record.category || '未分类')}</small></span>
        </label>`).join('')
      : '<div class="el-print-no-records">暂无可打印的实验配方、方法或母液配置。</div>';
    const documents = selectedEntries.length
      ? selectedEntries.map((entry, index) => renderPrintRecord(entry, index, selectedEntries.length)).join('')
      : '<div class="el-print-empty-preview"><b>选择需要打印的内容</b><span>可以组合多个配方、实验方法或母液配置，每条记录自动从新页开始。</span></div>';
    return `<div class="el-print-overlay" role="dialog" aria-modal="true" aria-label="知识库打印预览">
      <div class="el-print-window">
        <header class="el-print-window-head">
          <div><span>PRINT CENTER</span><h2>知识库打印预览</h2><p>选择内容后由系统自动生成科研文档版式。</p></div>
          <div><button type="button" data-el-action="close-print">关闭</button><button type="button" class="primary" data-el-action="system-print" ${selectedEntries.length ? '' : 'disabled'}>打印 / 另存为 PDF</button></div>
        </header>
        <div class="el-print-layout">
          <aside class="el-print-controls">
            <section><div class="el-print-control-title"><b>打印内容</b><span>${selectedEntries.length} / ${entries.length}</span></div>
              <div class="el-print-bulk"><button type="button" data-el-action="print-select-all">全选</button><button type="button" data-el-action="print-clear-all">清空</button></div>
              <div class="el-print-choice-list">${list}</div>
            </section>
            <section class="el-print-options">
              <b>页面设置</b>
              <label>纸张<select data-el-print-option="paper"><option ${state.print.paper === 'A4' ? 'selected' : ''}>A4</option><option ${state.print.paper === 'A5' ? 'selected' : ''}>A5</option></select></label>
              <label>方向<select data-el-print-option="orientation"><option value="portrait" ${state.print.orientation === 'portrait' ? 'selected' : ''}>纵向</option><option value="landscape" ${state.print.orientation === 'landscape' ? 'selected' : ''}>横向</option></select></label>
              <label>正文字号<select data-el-print-option="fontSize">${[9, 10, 10.5, 11, 12].map(size => `<option value="${size}" ${Number(state.print.fontSize) === size ? 'selected' : ''}>${size} pt</option>`).join('')}</select></label>
              <label class="check"><input type="checkbox" data-el-print-option="includeMetadata" ${state.print.includeMetadata ? 'checked' : ''} /><span>显示分类、标签和版本信息</span></label>
              <label class="check"><input type="checkbox" data-el-print-option="includeNotes" ${state.print.includeNotes ? 'checked' : ''} /><span>显示备注</span></label>
              <label class="check"><input type="checkbox" data-el-print-option="includeAttachments" ${state.print.includeAttachments ? 'checked' : ''} /><span>显示附件清单</span></label>
            </section>
            <p class="el-print-tip">打印时会隐藏软件界面，只输出右侧白色文档。系统打印窗口中可以选择打印机或“另存为 PDF”。</p>
          </aside>
          <main class="el-print-preview">
            <div id="elPrintContent" class="el-print-sheet ${state.print.paper.toLowerCase()} ${state.print.orientation}" style="--el-print-font-size:${Number(state.print.fontSize) || 10.5}pt">${documents}</div>
          </main>
        </div>
      </div>
    </div>`;
  }

  async function printSelectedRecords() {
    if (!state.print.selectedKeys.length) {
      notice('请至少选择一条需要打印的记录。', 'bad');
      return;
    }
    await flushPendingSaves();
    let style = document.getElementById('elDynamicPrintPage');
    if (!style) {
      style = document.createElement('style');
      style.id = 'elDynamicPrintPage';
      document.head.append(style);
    }
    const paper = state.print.paper === 'A5' ? 'A5' : 'A4';
    const orientation = state.print.orientation === 'landscape' ? 'landscape' : 'portrait';
    style.textContent = `@page { size: ${paper} ${orientation}; margin: 12mm; }`;
    window.requestAnimationFrame(() => window.print());
  }

  function renderStockEditor(stock) {
    return `
      <div class="el-editor-head">
        <div><span>STOCK SOLUTION</span><input class="el-title-input" data-el-field="name" value="${escapeAttr(stock.name || '')}" placeholder="如：1 M HEPES" /></div>
        <div><button type="button" data-el-action="print-current">打印预览</button><button type="button" class="primary" data-el-action="create-stock-recipe">生成母液配制配方</button></div>
      </div>
      <div class="el-stock-grid">
        <label>对应试剂<select data-el-field="chemicalId"><option value="">未关联试剂</option>${state.records.chemicals.map(item => `<option value="${item.id}" ${stock.chemicalId === item.id ? 'selected' : ''}>${escapeHtml(item.name)} · MW ${escapeHtml(String(item.molecularWeight || '—'))}</option>`).join('')}</select></label>
        <label>母液浓度<div class="el-inline-field"><input data-el-field="concentration" type="number" min="0" step="any" value="${escapeAttr(stock.concentration || '')}" /><select data-el-field="unit">${['M', 'mM', 'µM', '% (w/v)', '% (v/v)', '×'].map(unit => `<option ${stock.unit === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></div></label>
        <label>分子量<input data-el-field="molecularWeight" type="number" min="0" step="any" value="${escapeAttr(stock.molecularWeight || '')}" /></label>
        <label>有效期（天）<input data-el-field="expiryDays" type="number" min="0" step="1" value="${escapeAttr(stock.expiryDays || '')}" /></label>
        <label class="wide">配制方法<textarea data-el-field="preparation" rows="7" placeholder="记录称量、溶解、调 pH、定容、过滤步骤">${escapeHtml(stock.preparation || '')}</textarea></label>
        <label class="wide">保存条件<textarea data-el-field="storage" rows="3" placeholder="如：-20℃ 分装，避光">${escapeHtml(stock.storage || '')}</textarea></label>
      </div>
      <section class="el-editor-section">
        <div class="el-section-title"><div><h4>配置记录</h4><p>记录每一批次的日期、体积、操作者与备注。</p></div><button type="button" data-el-action="add-stock-record">＋ 新记录</button></div>
        <div class="el-table-wrap"><table class="el-stock-record-table"><thead><tr><th>日期</th><th>体积</th><th>操作者</th><th>备注</th><th></th></tr></thead><tbody>
          ${(stock.records || []).map((row, index) => `<tr><td><input data-el-stock-record="${index}" data-el-stock-field="date" type="date" value="${escapeAttr(row.date || '')}" /></td><td><input data-el-stock-record="${index}" data-el-stock-field="volume" value="${escapeAttr(row.volume || '')}" placeholder="50 mL" /></td><td><input data-el-stock-record="${index}" data-el-stock-field="operator" value="${escapeAttr(row.operator || '')}" /></td><td><input data-el-stock-record="${index}" data-el-stock-field="notes" value="${escapeAttr(row.notes || '')}" /></td><td><button type="button" data-el-action="delete-stock-record" data-el-index="${index}">×</button></td></tr>`).join('')}
        </tbody></table></div>
      </section>`;
  }

  function renderOcrLanding() {
    return `
      <div class="el-page-heading compact"><div><p>OCR IMPORT</p><h3>导入图片、截图与扫描文件</h3><span>识别结果必须人工确认后再保存；原图和确认文字均保存在本地。</span></div></div>
      <section class="el-ocr-drop">
        <div><span>OCR</span><h4>选择图片、PDF 或文本文件</h4><p>支持图片、手机拍照、截图和 PDF。浏览器具备本地 TextDetector 时可直接识别；否则仍可导入原图并粘贴/校对文字。</p></div>
        <label class="el-primary-action">选择文件<input id="elOcrInput" type="file" accept="image/*,.pdf,application/pdf,.txt,text/plain" multiple /></label>
      </section>
      <div class="el-ocr-record-grid">${state.records.ocrRecords.length ? state.records.ocrRecords.map(item => `<button type="button" data-el-open="ocrRecords" data-el-id="${item.id}"><span>${escapeHtml(item.fileType || '文件')}</span><b>${escapeHtml(item.title || item.name || '未命名 OCR')}</b><small>${escapeHtml(dateText(item.updatedAt))}</small></button>`).join('') : '<div class="el-empty-state"><b>暂无 OCR 记录</b><span>导入文件后会创建一条可编辑记录。</span></div>'}</div>
      <div class="el-ocr-boundary"><b>当前离线识别边界</b><p>本版本不连接任何云端 OCR。若当前浏览器不提供 TextDetector，本模块会保留原文件、手动录入/粘贴、单位提示和一键入库功能；不会伪造识别结果。</p></div>`;
  }

  function objectUrl(blob) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    return url;
  }

  function renderOcrEditor(record) {
    const preview = record.blob && String(record.mime || '').startsWith('image/')
      ? `<img src="${objectUrl(record.blob)}" alt="${escapeAttr(record.name || 'OCR source')}" />`
      : record.blob && record.mime === 'application/pdf'
        ? `<object data="${objectUrl(record.blob)}" type="application/pdf"><p>浏览器无法内嵌预览此 PDF。</p></object>`
        : '<div class="el-file-placeholder">文件已保存在本地</div>';
    const tokens = detectScientificTokens(record.text || '');
    return `
      <div class="el-editor-head">
        <div><span>OCR RECORD</span><input class="el-title-input" data-el-field="title" value="${escapeAttr(record.title || '')}" placeholder="识别记录标题" /></div>
        <div><button type="button" data-el-action="run-local-ocr">开始离线 OCR</button><button type="button" class="primary" data-el-action="ocr-to-protocol">保存为实验方法</button></div>
      </div>
      <div class="el-ocr-editor">
        <section class="el-ocr-preview"><div class="el-card-title"><div><h4>原始文件</h4><p>${escapeHtml(record.name || '')}</p></div></div>${preview}</section>
        <section class="el-ocr-text">
          <label>可编辑识别文字<textarea data-el-field="text" rows="24" placeholder="OCR 结果、从 Word 复制的文字或手动录入内容">${escapeHtml(record.text || '')}</textarea></label>
          <div class="el-token-list"><b>检测到的实验信息</b>${tokens.length ? tokens.map(token => `<span>${escapeHtml(token)}</span>`).join('') : '<small>尚未识别到浓度或单位</small>'}</div>
          <div class="el-ocr-actions"><button type="button" data-el-action="ocr-to-recipe">保存为配方草稿</button><button type="button" data-el-action="ocr-to-protocol">保存为 Protocol</button></div>
        </section>
      </div>`;
  }

  function detectScientificTokens(text) {
    const matches = String(text || '').match(/\b\d+(?:\.\d+)?\s*(?:mM|µM|μM|M|mg\/mL|µg\/mL|ng\/µL|%|mL|µL|μL|g|mg|kDa|℃)\b/gi) || [];
    return [...new Set(matches)].slice(0, 24);
  }

  function renderCalculator() {
    const tabs = {
      buffer: '多组分 Buffer',
      molarity: '摩尔浓度',
      stock: 'Stock 稀释',
      dilution: 'C1V1=C2V2',
      percentage: '百分/质量浓度',
    };
    return `
      <div class="el-page-heading compact"><div><p>SMART CALCULATOR</p><h3>实验配方计算器</h3><span>每次计算自动写入历史，可一键保存为实验配方。</span></div></div>
      <div class="el-calculator-tabs">${Object.entries(tabs).map(([key, label]) => `<button type="button" class="${state.calculatorTab === key ? 'active' : ''}" data-el-calc-tab="${key}">${label}</button>`).join('')}</div>
      <div class="el-calculator-layout">
        <section class="el-card el-calculator-form">${renderCalculatorForm()}</section>
        <aside class="el-card el-calculator-result">${renderCalculatorResult()}</aside>
      </div>
      <section class="el-card el-history-card">
        <div class="el-card-title"><div><h4>最近计算</h4><p>点击可查看输入与结果；历史永久保存在当前浏览器。</p></div><small>${state.records.calculations.length} 条</small></div>
        <div class="el-history-list">${state.records.calculations.slice(0, 20).map(item => `<button type="button" data-el-action="open-calculation" data-el-id="${item.id}"><span>${escapeHtml(item.label || item.type)}</span><b>${escapeHtml(item.summary || '查看结果')}</b><small>${escapeHtml(dateText(item.createdAt))}</small></button>`).join('') || '<div class="el-empty-state"><b>暂无计算历史</b><span>完成第一次计算后会自动出现在这里。</span></div>'}</div>
      </section>`;
  }

  function calcInput(name, label, options = {}) {
    const draft = state.calculatorDraft[state.calculatorTab] || {};
    const value = draft[name] ?? '';
    if (options.select) {
      return `<label>${label}<select data-el-calc-field="${name}">${options.select.map(option => {
        const pair = Array.isArray(option) ? option : [option, option];
        return `<option value="${escapeAttr(pair[0])}" ${String(value) === String(pair[0]) ? 'selected' : ''}>${escapeHtml(pair[1])}</option>`;
      }).join('')}</select></label>`;
    }
    return `<label>${label}<input data-el-calc-field="${name}" ${options.type === 'text' ? '' : 'type="number" step="any"'} value="${escapeAttr(value)}" placeholder="${escapeAttr(options.placeholder || '')}" /></label>`;
  }

  function renderCalculatorForm() {
    const tab = state.calculatorTab;
    if (tab === 'molarity') {
      return `<div class="el-card-title"><div><h4>摩尔浓度配置</h4><p>m = C × V × MW</p></div></div>
        <div class="el-form-grid">
          ${calcInput('chemicalName', '试剂名称', { type: 'text', placeholder: '输入 HEPES 可自动读取 MW' })}
          ${calcInput('molecularWeight', '分子量（g/mol）')}
          ${calcInput('concentration', '目标浓度')}
          ${calcInput('concentrationUnit', '浓度单位', { select: ['M', 'mM', 'µM'] })}
          ${calcInput('volume', '目标体积')}
          ${calcInput('volumeUnit', '体积单位', { select: ['mL', 'L', 'µL'] })}
        </div><button type="button" class="el-primary-action wide" data-el-action="calculate">计算需要称量的质量</button>`;
    }
    if (tab === 'stock') {
      return `<div class="el-card-title"><div><h4>Stock 配置</h4><p>根据 C1V1=C2V2 计算母液与补液体积</p></div></div>
        <div class="el-form-grid">
          ${calcInput('stockConcentration', '母液浓度 C1')}
          ${calcInput('stockUnit', '母液单位', { select: ['M', 'mM', 'µM'] })}
          ${calcInput('targetConcentration', '目标浓度 C2')}
          ${calcInput('targetUnit', '目标单位', { select: ['M', 'mM', 'µM'] })}
          ${calcInput('finalVolume', '终体积 V2')}
          ${calcInput('finalVolumeUnit', '体积单位', { select: ['mL', 'L', 'µL'] })}
        </div><button type="button" class="el-primary-action wide" data-el-action="calculate">计算母液加入量</button>`;
    }
    if (tab === 'dilution') {
      return `<div class="el-card-title"><div><h4>C1V1 = C2V2</h4><p>四项中只留空一个，单位需自行保持一致</p></div></div>
        <div class="el-form-grid four">${calcInput('c1', 'C1')}${calcInput('v1', 'V1')}${calcInput('c2', 'C2')}${calcInput('v2', 'V2')}</div>
        <button type="button" class="el-primary-action wide" data-el-action="calculate">计算未知数</button>`;
    }
    if (tab === 'percentage') {
      const kind = state.calculatorDraft.percentage.kind;
      return `<div class="el-card-title"><div><h4>百分浓度与质量浓度</h4><p>w/v、v/v、mg/mL、µg/mL、ng/µL</p></div></div>
        <div class="el-form-grid">
          ${calcInput('kind', '计算类型', { select: [['w/v', '% (w/v) 配制'], ['v/v', '% (v/v) 配制'], ['mass', '质量浓度互换']] })}
          ${calcInput('value', kind === 'mass' ? '原浓度数值' : '百分浓度')}
          ${kind === 'mass' ? `${calcInput('sourceUnit', '原单位', { select: ['mg/mL', 'µg/mL', 'ng/µL', 'ng/mL'] })}${calcInput('targetUnit', '目标单位', { select: ['mg/mL', 'µg/mL', 'ng/µL', 'ng/mL'] })}` : `${calcInput('finalVolume', '终体积')}${calcInput('finalVolumeUnit', '体积单位', { select: ['mL', 'L', 'µL'] })}`}
        </div><button type="button" class="el-primary-action wide" data-el-action="calculate">换算</button>`;
    }
    return renderBufferCalculator();
  }

  function renderBufferCalculator() {
    const draft = state.calculatorDraft.buffer;
    return `<div class="el-card-title"><div><h4>多组分 Buffer</h4><p>自动匹配母液、计算加入量并生成 Protocol</p></div><button type="button" data-el-action="paste-components">粘贴表格</button></div>
      <div class="el-form-grid buffer-meta">
        ${calcInput('name', '配方名称', { type: 'text' })}
        ${calcInput('finalVolume', '目标体积')}
        ${calcInput('finalVolumeUnit', '体积单位', { select: ['mL', 'L', 'µL'] })}
        ${calcInput('targetPh', '目标 pH', { type: 'text' })}
        ${calcInput('storage', '保存条件', { type: 'text' })}
      </div>
      <div class="el-table-wrap"><table class="el-buffer-table"><thead><tr><th>成分</th><th>目标浓度</th><th>来源</th><th>母液</th><th>MW</th><th></th></tr></thead><tbody>
        ${draft.components.map((component, index) => `<tr>
          <td><input data-el-calc-component="${index}" data-el-calc-component-field="name" value="${escapeAttr(component.name || '')}" /></td>
          <td><div class="el-concentration-field"><input data-el-calc-component="${index}" data-el-calc-component-field="targetValue" type="number" step="any" value="${escapeAttr(component.targetValue || '')}" /><select data-el-calc-component="${index}" data-el-calc-component-field="targetUnit">${componentOptions(component.targetUnit)}</select></div></td>
          <td><select data-el-calc-component="${index}" data-el-calc-component-field="sourceType">${sourceOptions(component.sourceType || 'auto')}</select></td>
          <td><select data-el-calc-component="${index}" data-el-calc-component-field="stockId">${stockOptions(component.stockId, component.name)}</select></td>
          <td><input data-el-calc-component="${index}" data-el-calc-component-field="molecularWeight" type="number" min="0" step="any" value="${escapeAttr(component.molecularWeight || '')}" /></td>
          <td><button type="button" class="el-row-delete" data-el-action="delete-calc-component" data-el-index="${index}">×</button></td>
        </tr>`).join('')}
      </tbody></table></div>
      <button type="button" class="el-add-step" data-el-action="add-calc-component">＋ 添加成分</button>
      <button type="button" class="el-primary-action wide" data-el-action="calculate">计算完整配方并生成步骤</button>`;
  }

  function renderCalculatorResult() {
    const result = state.calculatorResult;
    if (!result) return `<div class="el-result-empty"><span>∑</span><h4>等待计算</h4><p>结果、计算依据和自动 Protocol 将显示在这里。</p></div>`;
    if (result.error) return `<div class="el-result-error"><b>无法计算</b><p>${escapeHtml(result.error)}</p></div>`;
    if (result.type === 'buffer') {
      return `<div class="el-card-title"><div><h4>${escapeHtml(result.name)}</h4><p>${escapeHtml(String(result.finalVolume))} ${escapeHtml(result.finalVolumeUnit)} · ${escapeHtml(dateText(result.calculatedAt))}</p></div></div>
        <div class="el-result-table">${result.components.map(component => `<div><span>${escapeHtml(component.name)}<small>${escapeHtml(String(component.targetValue))} ${escapeHtml(component.targetUnit)}</small></span><b>${escapeHtml(Core.formatQuantity(component.actualAmount))}</b></div>`).join('')}</div>
        <div class="el-mini-protocol"><h5>自动 Protocol</h5><ol>${result.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></div>
        <button type="button" class="el-primary-action wide" data-el-action="save-result-recipe">保存到实验配方</button>`;
    }
    const rows = [];
    if (result.mass) rows.push(['需要称量', Core.formatQuantity(result.mass)]);
    if (result.stockVolume) rows.push(['加入母液', Core.formatQuantity(result.stockVolume)]);
    if (result.solventVolume) rows.push(['补加溶剂', Core.formatQuantity(result.solventVolume)]);
    if (result.unknown) rows.push([result.unknown.toUpperCase(), Core.formatNumber(result.value)]);
    if (result.solute) rows.push(['加入溶质', Core.formatQuantity(result.solute)]);
    if (result.converted) rows.push(['换算结果', `${Core.formatNumber(result.converted.value)} ${result.converted.unit}`]);
    if (Number.isFinite(result.mgPerMl)) rows.push(['质量浓度', `${Core.formatNumber(result.mgPerMl)} mg/mL`]);
    return `<div class="el-card-title"><div><h4>计算结果</h4><p>${escapeHtml(result.formula || '单位换算')}</p></div></div>
      <div class="el-result-table">${rows.map(([label, value]) => `<div><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`).join('')}</div>
      ${result.basis ? `<div class="el-formula-box"><span>计算依据</span><code>${escapeHtml(result.basis)}</code></div>` : ''}
      ${result.note ? `<p class="el-result-note">${escapeHtml(result.note)}</p>` : ''}`;
  }

  function renderSearch() {
    const allCount = state.records.recipes.length + state.records.protocols.length + state.records.stocks.length + state.records.ocrRecords.length + state.records.chemicals.length;
    return `
      <div class="el-page-heading compact"><div><p>FULL-TEXT SEARCH</p><h3>搜索中心</h3><span>搜索配方、方法、步骤、试剂、标签、备注和 OCR 文字。</span></div></div>
      <div class="el-search-box"><input id="elSearchInput" value="${escapeAttr(state.searchQuery)}" placeholder="搜索 HEPES、Co-IP、蛋白提取、4℃……" autofocus /><button type="button" data-el-action="search">搜索 ${allCount} 条记录</button></div>
      <div class="el-search-summary">${state.searchQuery ? `“${escapeHtml(state.searchQuery)}” 找到 ${state.searchResults.length} 条结果` : '输入关键词开始搜索'}</div>
      <div class="el-search-results">${state.searchResults.map(item => `
        <button type="button" data-el-open="${item.store}" data-el-id="${item.id}">
          <span>${escapeHtml(item.kind)}</span><h4>${escapeHtml(item.name || item.title || '未命名')}</h4>
          <p>${escapeHtml(item.excerpt || '')}</p><small>${escapeHtml(item.category || '未分类')} · ${escapeHtml(dateText(item.updatedAt))}</small>
        </button>`).join('') || (state.searchQuery ? '<div class="el-empty-state"><b>没有匹配结果</b><span>尝试试剂名、标签或步骤中的词。</span></div>' : '')}</div>`;
  }

  function refreshMain() {
    const main = document.getElementById('elMain');
    const properties = document.getElementById('elProperties');
    const tree = document.getElementById('elTree');
    if (main) main.innerHTML = renderMain();
    if (properties) properties.innerHTML = renderProperties();
    if (tree) tree.innerHTML = renderTree();
    setAutosaveState(state.autosaveState);
  }

  function createBaseRecord(store) {
    const timestamp = now();
    const common = {
      id: uid(store.replace(/s$/, '')),
      category: store === 'recipes' ? 'Buffer' : store === 'protocols' ? '实验方法' : store === 'stocks' ? 'Stock Solution' : 'OCR 导入',
      tags: [],
      notes: '',
      favorite: false,
      version: 1,
      versionHistory: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (store === 'recipes') {
      return {
        ...common,
        name: '未命名实验配方',
        purpose: '',
        targetVolume: 50,
        targetVolumeUnit: 'mL',
        targetPh: '',
        storage: '4℃',
        components: [{ id: uid('component'), name: '', targetValue: '', targetUnit: 'mM', sourceType: 'auto', stockId: '', molecularWeight: '' }],
        steps: [],
      };
    }
    if (store === 'protocols') {
      return { ...common, name: '未命名实验方法', purpose: '', materials: '', markdown: '# 实验步骤\n\n1. ', cautions: '', troubleshooting: '', references: '', preview: false };
    }
    if (store === 'stocks') {
      return { ...common, name: '未命名母液', chemicalId: '', concentration: 1, unit: 'M', molecularWeight: '', preparation: '', storage: '', expiryDays: '', records: [] };
    }
    return { ...common, title: '未命名 OCR 记录', name: '', mime: '', fileType: '', text: '', status: '待确认' };
  }

  async function createRecord(store, seed = {}) {
    const record = { ...createBaseRecord(store), ...seed };
    await dbPut(store, record);
    state.records[store].unshift(record);
    state.selection = { store, id: record.id };
    state.page = store === 'recipes' || store === 'stocks' ? 'recipes' : store === 'protocols' ? 'protocols' : 'ocr';
    renderShell();
    notice(`已新建${recordLabel(store)}，后续修改会自动保存。`, 'good');
    return record;
  }

  async function flushSave(key) {
    const pending = state.pendingSaves.get(key);
    if (!pending) return;
    const timer = state.autosaveTimers.get(key);
    if (timer) window.clearTimeout(timer);
    state.autosaveTimers.delete(key);
    state.pendingSaves.delete(key);
    try {
      await dbPut(pending.store, pending.record);
      if (!state.pendingSaves.size) setAutosaveState('saved');
    } catch (error) {
      console.error(error);
      setAutosaveState('error');
      notice(`自动保存失败：${error.message}`, 'bad');
      throw error;
    }
  }

  async function flushPendingSaves() {
    const keys = [...state.pendingSaves.keys()];
    if (!keys.length) return;
    await Promise.allSettled(keys.map(flushSave));
  }

  function scheduleSave(record, store = state.selection?.store) {
    if (!record || !store || !record.id) return;
    record.updatedAt = now();
    const key = `${store}:${record.id}`;
    setAutosaveState('saving');
    const previousTimer = state.autosaveTimers.get(key);
    if (previousTimer) window.clearTimeout(previousTimer);
    state.pendingSaves.set(key, { store, record });
    const timer = window.setTimeout(() => {
      flushSave(key).catch(() => {});
    }, 480);
    state.autosaveTimers.set(key, timer);
  }

  function updateRecordField(field, rawValue, element) {
    const record = selectedRecord();
    if (!record) return;
    const numericFields = new Set(['targetVolume', 'concentration', 'molecularWeight', 'expiryDays']);
    if (field === 'tags') record.tags = String(rawValue).split(/[,，\n]/).map(value => value.trim()).filter(Boolean);
    else if (numericFields.has(field)) record[field] = rawValue === '' ? '' : Number(rawValue);
    else record[field] = element?.type === 'checkbox' ? element.checked : rawValue;
    if (field === 'chemicalId' && state.selection.store === 'stocks') {
      const chemical = state.records.chemicals.find(item => item.id === rawValue);
      if (chemical) {
        record.molecularWeight = chemical.molecularWeight;
        if (!record.name || record.name === '未命名母液') record.name = `${record.concentration || 1} ${record.unit || 'M'} ${chemical.name}`;
      }
    }
    scheduleSave(record);
  }

  function updateRecipeComponent(index, field, rawValue) {
    const recipe = selectedRecord();
    const component = recipe?.components?.[index];
    if (!component) return;
    const numericFields = new Set(['targetValue', 'molecularWeight']);
    component[field] = numericFields.has(field) ? (rawValue === '' ? '' : Number(rawValue)) : rawValue;
    if (field === 'name') {
      const chemical = findChemicalRecord(rawValue);
      if (chemical && !(Number(component.molecularWeight) > 0)) component.molecularWeight = chemical.molecularWeight;
    }
    scheduleSave(recipe);
  }

  function findChemicalRecord(name) {
    return Core.findChemical(name, [...state.records.chemicals, ...Core.CHEMICALS]);
  }

  function findMatchingStock(component) {
    if (component.stockId) return state.records.stocks.find(item => item.id === component.stockId) || null;
    const name = String(component.name || '').trim().toLowerCase();
    if (!name) return null;
    return state.records.stocks.find(stock => {
      const stockName = String(stock.name || '').toLowerCase();
      const chemical = state.records.chemicals.find(item => item.id === stock.chemicalId);
      return stockName.includes(name) || name.includes(stockName) || String(chemical?.name || '').toLowerCase() === name;
    }) || null;
  }

  function hydrateComponents(components) {
    return (components || []).map(component => {
      const chemical = findChemicalRecord(component.name);
      const stock = findMatchingStock(component);
      return {
        ...component,
        chemical,
        stock: (component.sourceType === 'stock' || component.sourceType === 'auto') ? stock : null,
        molecularWeight: Number(component.molecularWeight) > 0 ? Number(component.molecularWeight) : chemical?.molecularWeight,
      };
    });
  }

  async function saveCalculation(type, input, result, label, summary) {
    const record = {
      id: uid('calculation'),
      type,
      input: clone(input),
      result: clone(result),
      label,
      summary,
      createdAt: now(),
      updatedAt: now(),
    };
    await dbPut('calculations', record);
    state.records.calculations.unshift(record);
    return record;
  }

  async function recalculateRecipe(resetSteps = true) {
    const recipe = selectedRecord();
    if (!recipe || state.selection.store !== 'recipes') return;
    try {
      const result = Core.calculateBuffer({
        name: recipe.name,
        finalVolume: recipe.targetVolume,
        finalVolumeUnit: recipe.targetVolumeUnit,
        targetPh: recipe.targetPh,
        storage: recipe.storage,
        chemicals: [...state.records.chemicals, ...Core.CHEMICALS],
        components: hydrateComponents(recipe.components),
      });
      recipe.components = result.components.map(component => {
        const clean = { ...component };
        delete clean.stock;
        delete clean.chemical;
        delete clean.calculation;
        return clean;
      });
      if (resetSteps || !(recipe.steps || []).length) recipe.steps = result.steps;
      recipe.calculatedAt = result.calculatedAt;
      recipe.calculationBasis = 'm = C × V × MW；C1V1 = C2V2；% 按终体积计算';
      recipe.updatedAt = now();
      await dbPut('recipes', recipe);
      await saveCalculation('recipe', { recipeId: recipe.id, targetVolume: recipe.targetVolume, targetVolumeUnit: recipe.targetVolumeUnit }, result, recipe.name, `${recipe.targetVolume} ${recipe.targetVolumeUnit} · ${result.components.length} 个成分`);
      setAutosaveState('saved');
      refreshMain();
      notice('配方已重新计算并写入计算历史。', 'good');
    } catch (error) {
      notice(error.message, 'bad');
    }
  }

  async function createNewVersion() {
    const record = selectedRecord();
    if (!record) return;
    const snapshot = {
      version: record.version || 1,
      savedAt: now(),
      name: record.name || record.title,
      category: record.category,
      purpose: record.purpose,
      targetVolume: record.targetVolume,
      targetVolumeUnit: record.targetVolumeUnit,
      components: clone(record.components || []),
      steps: clone(record.steps || []),
      markdown: record.markdown,
    };
    record.versionHistory = [...(record.versionHistory || []), snapshot].slice(-50);
    record.version = (record.version || 1) + 1;
    record.updatedAt = now();
    await dbPut(state.selection.store, record);
    refreshMain();
    notice(`已生成 v${record.version}，上一版本已保留。`, 'good');
  }

  function recipeTsv(recipe) {
    return [
      ['成分', '最终浓度', '母液/来源', '分子量', '实际加入量', '单位', '计算依据'].join('\t'),
      ...(recipe.components || []).map(component => [
        component.name,
        `${component.targetValue ?? ''} ${component.targetUnit || ''}`.trim(),
        component.sourceType === 'stock' ? (state.records.stocks.find(item => item.id === component.stockId)?.name || '母液') : component.sourceType === 'solid' ? '固体称量' : '自动',
        component.molecularWeight || '',
        component.actualAmount?.value ?? '',
        component.actualAmount?.unit || '',
        component.basis || '',
      ].join('\t')),
      '',
      '配制步骤',
      ...(recipe.steps || []).map((step, index) => `${index + 1}\t${step}`),
    ].join('\n');
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }

  async function calculateCurrent() {
    const tab = state.calculatorTab;
    const draft = state.calculatorDraft[tab];
    try {
      let result;
      if (tab === 'molarity') result = Core.calculateMolarity(draft);
      else if (tab === 'stock') result = Core.calculateStock(draft);
      else if (tab === 'dilution') result = Core.solveDilution(draft);
      else if (tab === 'percentage') result = Core.convertPercentage(draft);
      else {
        result = Core.calculateBuffer({
          ...draft,
          chemicals: [...state.records.chemicals, ...Core.CHEMICALS],
          components: hydrateComponents(draft.components),
        });
      }
      state.calculatorResult = result;
      const summary = result.type === 'buffer'
        ? `${result.finalVolume} ${result.finalVolumeUnit} · ${result.components.length} 个成分`
        : result.mass ? Core.formatQuantity(result.mass)
          : result.stockVolume ? Core.formatQuantity(result.stockVolume)
            : result.converted ? `${Core.formatNumber(result.converted.value)} ${result.converted.unit}`
              : result.unknown ? `${result.unknown.toUpperCase()} = ${Core.formatNumber(result.value)}`
                : '计算完成';
      await saveCalculation(tab, draft, result, tab === 'buffer' ? result.name : PAGE_LABELS.calculator, summary);
      refreshMain();
      notice('计算完成，结果已自动写入历史。', 'good');
    } catch (error) {
      state.calculatorResult = { error: error.message };
      refreshMain();
    }
  }

  async function saveCalculatorResultAsRecipe() {
    const result = state.calculatorResult;
    if (!result || result.type !== 'buffer') return;
    const record = await createRecord('recipes', {
      name: result.name,
      purpose: '由智能计算器生成',
      targetVolume: result.finalVolume,
      targetVolumeUnit: result.finalVolumeUnit,
      targetPh: result.targetPh,
      storage: result.storage,
      components: result.components.map(component => {
        const clean = { ...component };
        delete clean.stock;
        delete clean.chemical;
        delete clean.calculation;
        return clean;
      }),
      steps: result.steps,
      calculatedAt: result.calculatedAt,
      calculationBasis: 'm = C × V × MW；C1V1 = C2V2；% 按终体积计算',
    });
    const calculation = state.records.calculations[0];
    if (calculation) {
      calculation.recipeId = record.id;
      await dbPut('calculations', calculation);
    }
    notice('计算结果已永久保存到实验配方。', 'good');
  }

  async function createStockRecipe() {
    const stock = selectedRecord();
    if (!stock || state.selection.store !== 'stocks') return;
    const chemical = state.records.chemicals.find(item => item.id === stock.chemicalId) || findChemicalRecord(stock.name);
    if (!['M', 'mM', 'µM'].includes(stock.unit) || !(Number(stock.molecularWeight || chemical?.molecularWeight) > 0)) {
      notice('只有具有有效分子量的摩尔浓度母液可自动生成称量配方。', 'bad');
      return;
    }
    const recipe = await createRecord('recipes', {
      name: `${stock.name} 配制`,
      category: 'Stock Solution',
      purpose: `配置 ${stock.name}`,
      targetVolume: 100,
      targetVolumeUnit: 'mL',
      storage: stock.storage || '',
      components: [{
        id: uid('component'),
        name: chemical?.name || stock.name.replace(/^[\d.]+\s*(?:M|mM|µM)\s*/i, ''),
        targetValue: stock.concentration,
        targetUnit: stock.unit,
        sourceType: 'solid',
        stockId: '',
        molecularWeight: Number(stock.molecularWeight || chemical?.molecularWeight),
      }],
      steps: [],
    });
    await recalculateRecipe(true);
    recipe.notes = `由母液库“${stock.name}”生成；默认终体积 100 mL，可直接修改后重新计算。`;
    scheduleSave(recipe, 'recipes');
  }

  function runSearch() {
    const query = state.searchQuery.trim();
    const collection = [
      ...state.records.recipes.map(item => ({ ...item, store: 'recipes', kind: '实验配方' })),
      ...state.records.protocols.map(item => ({ ...item, store: 'protocols', kind: '实验方法' })),
      ...state.records.stocks.map(item => ({ ...item, store: 'stocks', kind: '母液' })),
      ...state.records.ocrRecords.map(item => ({ ...item, store: 'ocrRecords', kind: 'OCR 记录' })),
      ...state.records.chemicals.map(item => ({ ...item, store: 'chemicals', kind: '试剂' })),
    ];
    state.searchResults = Core.searchRecords(collection, query).map(item => ({
      ...item,
      excerpt: item.purpose || item.notes || item.text || item.markdown || (item.components || []).map(component => component.name).join('、'),
    }));
    refreshMain();
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  function readFileAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function dataUrlToBlob(value) {
    const [header, payload] = String(value).split(',');
    const mime = header.match(/data:(.*?);base64/)?.[1] || 'application/octet-stream';
    const binary = atob(payload || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
  }

  async function importOcrFiles(files) {
    const accepted = [...files].filter(Boolean);
    if (!accepted.length) return;
    let last = null;
    for (const file of accepted) {
      const text = file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt') ? await readFileAsText(file) : '';
      const record = {
        ...createBaseRecord('ocrRecords'),
        title: file.name.replace(/\.[^.]+$/, ''),
        name: file.name,
        mime: file.type || 'application/octet-stream',
        fileType: file.type?.startsWith('image/') ? '图片' : file.type === 'application/pdf' ? 'PDF' : '文本',
        blob: file,
        text,
        status: text ? '待确认' : '待识别/录入',
      };
      await dbPut('ocrRecords', record);
      state.records.ocrRecords.unshift(record);
      last = record;
    }
    if (last) {
      state.page = 'ocr';
      state.selection = { store: 'ocrRecords', id: last.id };
      renderShell();
      notice(`已导入 ${accepted.length} 个文件，原文件仅保存在当前浏览器。`, 'good');
    }
  }

  async function runLocalOcr() {
    const record = selectedRecord();
    if (!record?.blob || state.selection.store !== 'ocrRecords') return;
    if (!String(record.mime || '').startsWith('image/')) {
      notice('当前离线 OCR 仅可尝试识别图片；PDF 请先导出页面截图。', 'bad');
      return;
    }
    if (!('TextDetector' in window)) {
      notice('当前浏览器未提供离线 TextDetector。可保留原图并粘贴或手动校对文字。', 'bad');
      return;
    }
    try {
      notice('正在使用浏览器本地 OCR，不会上传图片。');
      const bitmap = await createImageBitmap(record.blob);
      const detector = new window.TextDetector();
      const blocks = await detector.detect(bitmap);
      bitmap.close?.();
      const text = blocks.map(block => block.rawValue || '').filter(Boolean).join('\n');
      if (!text.trim()) throw new Error('未识别到文字');
      record.text = text;
      record.status = '待人工确认';
      record.updatedAt = now();
      await dbPut('ocrRecords', record);
      refreshMain();
      notice('离线 OCR 完成，请人工核对标题、数值和单位。', 'good');
    } catch (error) {
      notice(`离线 OCR 失败：${error.message}`, 'bad');
    }
  }

  function parseOcrComponents(text) {
    const unitPattern = '(mM|µM|μM|M|%\\s*\\(w\\/v\\)|%\\s*\\(v\\/v\\)|%\\s*w\\/v|%\\s*v\\/v)';
    return String(text || '').split(/\r?\n/).map(line => {
      const match = line.match(new RegExp(`^\\s*([^\\d:：]{1,60}?)\\s*[:：]?\\s*(\\d+(?:\\.\\d+)?)\\s*${unitPattern}`, 'i'));
      if (!match) return null;
      const name = match[1].replace(/[-–—|]+$/g, '').trim();
      if (!name) return null;
      const unit = match[3].replace(/μ/g, 'µ').replace(/%\s*w\/v/i, '% (w/v)').replace(/%\s*v\/v/i, '% (v/v)');
      const chemical = findChemicalRecord(name);
      return {
        id: uid('component'),
        name,
        targetValue: Number(match[2]),
        targetUnit: unit,
        sourceType: 'auto',
        stockId: '',
        molecularWeight: chemical?.molecularWeight || '',
      };
    }).filter(Boolean);
  }

  async function ocrToRecipe() {
    const record = selectedRecord();
    if (!record || state.selection.store !== 'ocrRecords') return;
    const components = parseOcrComponents(record.text);
    await createRecord('recipes', {
      name: record.title || 'OCR 导入配方',
      category: 'OCR 导入',
      purpose: '由 OCR 记录生成，需人工核对',
      notes: `来源文件：${record.name || '未知'}\n\nOCR 原文：\n${record.text || ''}`,
      components: components.length ? components : createBaseRecord('recipes').components,
      steps: [],
      ocrRecordId: record.id,
    });
    notice(`已生成配方草稿${components.length ? `，解析到 ${components.length} 个成分` : ''}；请人工核对。`, 'good');
  }

  async function ocrToProtocol() {
    const record = selectedRecord();
    if (!record || state.selection.store !== 'ocrRecords') return;
    await createRecord('protocols', {
      name: record.title || 'OCR 导入实验方法',
      category: 'OCR 导入',
      purpose: '由 OCR 记录生成，需人工核对',
      markdown: record.text || '# 实验步骤\n\n',
      notes: `来源文件：${record.name || '未知'}`,
      ocrRecordId: record.id,
    });
    notice('已生成实验方法草稿，请人工核对后继续编辑。', 'good');
  }

  async function addAttachments(files) {
    if (!state.selection || !files?.length) return;
    const ownerKey = `${state.selection.store}:${state.selection.id}`;
    for (const file of files) {
      const attachment = {
        id: uid('attachment'),
        ownerKey,
        ownerType: state.selection.store,
        ownerId: state.selection.id,
        name: file.name,
        mime: file.type || 'application/octet-stream',
        size: file.size,
        blob: file,
        createdAt: now(),
        updatedAt: now(),
      };
      await dbPut('attachments', attachment);
      const { blob, ...metadata } = attachment;
      state.records.attachments.unshift(metadata);
    }
    refreshMain();
    notice(`已保存 ${files.length} 个附件到本地知识库。`, 'good');
  }

  async function exportLibrary() {
    notice('正在生成离线知识库备份…');
    const payload = { schema: 'bioassay-experiment-library', version: 1, exportedAt: now(), stores: {} };
    for (const storeName of STORE_NAMES) {
      payload.stores[storeName] = [];
      const storedRecords = await dbGetAll(storeName);
      for (const record of storedRecords) {
        const item = { ...record };
        if (item.blob instanceof Blob) {
          item.blobDataUrl = await readFileAsDataUrl(item.blob);
          delete item.blob;
        }
        payload.stores[storeName].push(item);
      }
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    downloadBlob(blob, `BioAssay-Experiment-Library-${new Date().toISOString().slice(0, 10)}.json`);
    notice('知识库备份已导出，包含附件与 OCR 原文件。', 'good');
  }

  async function importLibrary(file) {
    try {
      if (!file || file.size > 512 * 1024 * 1024) throw new Error('备份文件无效或超过 512 MB，请拆分附件后重试。');
      const payload = JSON.parse(await readFileAsText(file));
      if (payload?.schema !== 'bioassay-experiment-library' || !payload.stores) throw new Error('不是有效的 BioAssay 实验知识库备份');
      const prepared = {};
      let recordCount = 0;
      for (const storeName of STORE_NAMES) {
        const sourceRecords = payload.stores[storeName] || [];
        if (!Array.isArray(sourceRecords)) throw new Error(`备份中的 ${storeName} 数据结构无效。`);
        prepared[storeName] = sourceRecords.map(raw => {
          if (!raw || typeof raw !== 'object' || !String(raw.id || '').trim()) throw new Error(`${storeName} 中存在缺少 ID 的记录。`);
          const record = { ...raw };
          if (record.blobDataUrl) {
            record.blob = dataUrlToBlob(record.blobDataUrl);
            delete record.blobDataUrl;
          }
          return record;
        });
        recordCount += prepared[storeName].length;
      }
      if (recordCount > 100000) throw new Error('备份记录超过 100000 条，已停止导入以避免浏览器失去响应。');
      if (!window.confirm('导入将合并同 ID 记录；同 ID 的现有记录会被备份内容覆盖。是否继续？')) return;
      await new Promise((resolve, reject) => {
        const tx = state.db.transaction(STORE_NAMES, 'readwrite');
        for (const storeName of STORE_NAMES) {
          const store = tx.objectStore(storeName);
          prepared[storeName].forEach(record => store.put(record));
        }
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('备份事务写入失败'));
        tx.onabort = () => reject(tx.error || new Error('备份事务已回滚'));
      });
      await loadRecords();
      state.selection = null;
      state.page = 'home';
      renderShell();
      notice(`知识库备份已原子导入 ${recordCount} 条记录。`, 'good');
    } catch (error) {
      notice(`导入失败：${error.message}`, 'bad');
    }
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function deleteRecord() {
    const record = selectedRecord();
    if (!record || !window.confirm(`确认删除“${record.name || record.title || '未命名记录'}”？此操作无法撤销。`)) return;
    const { store, id } = state.selection;
    const saveKey = `${store}:${id}`;
    const pendingTimer = state.autosaveTimers.get(saveKey);
    if (pendingTimer) window.clearTimeout(pendingTimer);
    state.autosaveTimers.delete(saveKey);
    state.pendingSaves.delete(saveKey);
    await dbDelete(store, id);
    state.records[store] = state.records[store].filter(item => item.id !== id);
    const ownerKey = `${store}:${id}`;
    for (const attachment of state.records.attachments.filter(item => item.ownerKey === ownerKey)) {
      await dbDelete('attachments', attachment.id);
    }
    state.records.attachments = state.records.attachments.filter(item => item.ownerKey !== ownerKey);
    state.selection = null;
    renderShell();
    notice(`${recordLabel(store)}已删除。`, 'good');
  }

  async function deleteAttachment(id) {
    await dbDelete('attachments', id);
    state.records.attachments = state.records.attachments.filter(item => item.id !== id);
    refreshMain();
  }

  async function openAttachment(id) {
    const item = await dbGet('attachments', id);
    if (!item?.blob) return;
    downloadBlob(item.blob, item.name || 'attachment');
  }

  function updateCalculatorField(field, rawValue) {
    const draft = state.calculatorDraft[state.calculatorTab];
    const textFields = new Set(['chemicalName', 'name', 'targetPh', 'storage', 'kind', 'sourceUnit', 'targetUnit', 'volumeUnit', 'concentrationUnit', 'stockUnit', 'finalVolumeUnit']);
    draft[field] = textFields.has(field) || rawValue === '' ? rawValue : Number(rawValue);
    if (state.calculatorTab === 'molarity' && field === 'chemicalName') {
      const chemical = findChemicalRecord(rawValue);
      if (chemical) draft.molecularWeight = chemical.molecularWeight;
    }
  }

  function bindEvents() {
    mount.addEventListener('click', async event => {
      const pageButton = event.target.closest('[data-el-page]');
      if (pageButton) {
        state.page = pageButton.dataset.elPage;
        state.selection = null;
        renderShell();
        return;
      }
      const openButton = event.target.closest('[data-el-open]');
      if (openButton) {
        const store = openButton.dataset.elOpen;
        if (store === 'chemicals') {
          state.page = 'search';
          state.selection = null;
          state.searchQuery = state.records.chemicals.find(item => item.id === openButton.dataset.elId)?.name || '';
          runSearch();
          return;
        }
        state.selection = { store, id: openButton.dataset.elId };
        state.page = store === 'recipes' || store === 'stocks' ? 'recipes' : store === 'protocols' ? 'protocols' : 'ocr';
        renderShell();
        return;
      }
      const newButton = event.target.closest('[data-el-new]');
      if (newButton) {
        await createRecord(newButton.dataset.elNew);
        return;
      }
      const tabButton = event.target.closest('[data-el-calc-tab]');
      if (tabButton) {
        state.calculatorTab = tabButton.dataset.elCalcTab;
        state.calculatorResult = null;
        refreshMain();
        return;
      }
      const actionButton = event.target.closest('[data-el-action]');
      if (!actionButton) return;
      const action = actionButton.dataset.elAction;
      if (action === 'cycle-theme') cycleTheme();
      else if (action === 'open-print') openPrintDialog(false);
      else if (action === 'print-current') openPrintDialog(true);
      else if (action === 'close-print') closePrintDialog();
      else if (action === 'print-select-all') {
        state.print.selectedKeys = printableEntries().map(item => item.key);
        renderShell();
      } else if (action === 'print-clear-all') {
        state.print.selectedKeys = [];
        renderShell();
      } else if (action === 'system-print') await printSelectedRecords();
      else if (action === 'export-library') await exportLibrary();
      else if (action === 'toggle-favorite') {
        const record = selectedRecord();
        if (record) {
          record.favorite = !record.favorite;
          await dbPut(state.selection.store, record);
          refreshMain();
        }
      } else if (action === 'new-version') await createNewVersion();
      else if (action === 'delete-record') await deleteRecord();
      else if (action === 'download-attachment') await openAttachment(actionButton.dataset.elId);
      else if (action === 'delete-attachment') await deleteAttachment(actionButton.dataset.elId);
      else if (action === 'recalculate-recipe') await recalculateRecipe(true);
      else if (action === 'reset-protocol') await recalculateRecipe(true);
      else if (action === 'copy-recipe') {
        await copyText(recipeTsv(selectedRecord()));
        notice('配方表格已复制，可粘贴到 Excel 或 Word。', 'good');
      } else if (action === 'add-component') {
        const recipe = selectedRecord();
        recipe.components.push({ id: uid('component'), name: '', targetValue: '', targetUnit: 'mM', sourceType: 'auto', stockId: '', molecularWeight: '' });
        scheduleSave(recipe);
        refreshMain();
      } else if (action === 'delete-component') {
        const recipe = selectedRecord();
        recipe.components.splice(Number(actionButton.dataset.index), 1);
        scheduleSave(recipe);
        refreshMain();
      } else if (action === 'add-step') {
        const recipe = selectedRecord();
        recipe.steps = [...(recipe.steps || []), ''];
        scheduleSave(recipe);
        refreshMain();
      } else if (action === 'delete-step') {
        const recipe = selectedRecord();
        recipe.steps.splice(Number(actionButton.dataset.index), 1);
        scheduleSave(recipe);
        refreshMain();
      } else if (action === 'toggle-protocol-preview') {
        const protocol = selectedRecord();
        protocol.preview = !protocol.preview;
        scheduleSave(protocol);
        refreshMain();
      } else if (action === 'add-stock-record') {
        const stock = selectedRecord();
        stock.records = [...(stock.records || []), { date: new Date().toISOString().slice(0, 10), volume: '', operator: '', notes: '' }];
        scheduleSave(stock);
        refreshMain();
      } else if (action === 'delete-stock-record') {
        const stock = selectedRecord();
        stock.records.splice(Number(actionButton.dataset.index), 1);
        scheduleSave(stock);
        refreshMain();
      } else if (action === 'create-stock-recipe') await createStockRecipe();
      else if (action === 'calculate') await calculateCurrent();
      else if (action === 'save-result-recipe') await saveCalculatorResultAsRecipe();
      else if (action === 'add-calc-component') {
        state.calculatorDraft.buffer.components.push({ id: uid('component'), name: '', targetValue: '', targetUnit: 'mM', sourceType: 'auto', stockId: '', molecularWeight: '' });
        refreshMain();
      } else if (action === 'delete-calc-component') {
        state.calculatorDraft.buffer.components.splice(Number(actionButton.dataset.index), 1);
        refreshMain();
      } else if (action === 'paste-components') {
        const text = window.prompt('粘贴“成分<Tab>浓度<Tab>单位<Tab>MW”，每行一个成分：');
        if (text) {
          const rows = text.split(/\r?\n/).map(line => line.split(/\t|,/)).filter(row => row[0]?.trim());
          state.calculatorDraft.buffer.components = rows.map(row => ({
            id: uid('component'),
            name: row[0].trim(),
            targetValue: Number(row[1]) || '',
            targetUnit: row[2]?.trim() || 'mM',
            sourceType: 'auto',
            stockId: '',
            molecularWeight: Number(row[3]) || findChemicalRecord(row[0])?.molecularWeight || '',
          }));
          refreshMain();
        }
      } else if (action === 'open-calculation') {
        const calculation = state.records.calculations.find(item => item.id === actionButton.dataset.elId);
        if (calculation) {
          state.calculatorTab = calculation.type;
          if (state.calculatorDraft[calculation.type]) state.calculatorDraft[calculation.type] = clone(calculation.input);
          state.calculatorResult = clone(calculation.result);
          refreshMain();
        }
      } else if (action === 'search') runSearch();
      else if (action === 'run-local-ocr') await runLocalOcr();
      else if (action === 'ocr-to-recipe') await ocrToRecipe();
      else if (action === 'ocr-to-protocol') await ocrToProtocol();
    });

    mount.addEventListener('input', event => {
      if (event.target.matches('[data-el-field]')) updateRecordField(event.target.dataset.elField, event.target.value, event.target);
      else if (event.target.matches('[data-el-component]')) updateRecipeComponent(Number(event.target.dataset.elComponent), event.target.dataset.elComponentField, event.target.value);
      else if (event.target.matches('[data-el-step]')) {
        const recipe = selectedRecord();
        recipe.steps[Number(event.target.dataset.elStep)] = event.target.value;
        scheduleSave(recipe);
      } else if (event.target.matches('[data-el-stock-record]')) {
        const stock = selectedRecord();
        const row = stock.records[Number(event.target.dataset.elStockRecord)];
        row[event.target.dataset.elStockField] = event.target.value;
        scheduleSave(stock);
      } else if (event.target.matches('[data-el-calc-field]')) {
        updateCalculatorField(event.target.dataset.elCalcField, event.target.value);
      } else if (event.target.matches('[data-el-calc-component]')) {
        const component = state.calculatorDraft.buffer.components[Number(event.target.dataset.elCalcComponent)];
        const field = event.target.dataset.elCalcComponentField;
        component[field] = ['targetValue', 'molecularWeight'].includes(field) ? (event.target.value === '' ? '' : Number(event.target.value)) : event.target.value;
        if (field === 'name' && !(Number(component.molecularWeight) > 0)) component.molecularWeight = findChemicalRecord(event.target.value)?.molecularWeight || '';
      } else if (event.target.id === 'elSearchInput') state.searchQuery = event.target.value;
    });

    mount.addEventListener('change', async event => {
      if (event.target.matches('[data-el-print-key]')) {
        const key = event.target.dataset.elPrintKey;
        const selected = new Set(state.print.selectedKeys);
        if (event.target.checked) selected.add(key);
        else selected.delete(key);
        state.print.selectedKeys = [...selected];
        renderShell();
      } else if (event.target.matches('[data-el-print-option]')) {
        const option = event.target.dataset.elPrintOption;
        state.print[option] = event.target.type === 'checkbox' ? event.target.checked : option === 'fontSize' ? Number(event.target.value) : event.target.value;
        renderShell();
      } else if (event.target.id === 'elOcrInput') await importOcrFiles(event.target.files);
      else if (event.target.id === 'elAttachmentInput') await addAttachments(event.target.files);
      else if (event.target.id === 'elBackupInput' && event.target.files[0]) await importLibrary(event.target.files[0]);
      else if (event.target.matches('[data-el-calc-field]') && event.target.dataset.elCalcField === 'kind') refreshMain();
      else if (event.target.matches('[data-el-component]') && ['name', 'sourceType', 'stockId'].includes(event.target.dataset.elComponentField)) refreshMain();
      else if (event.target.matches('[data-el-calc-component]') && ['name', 'sourceType', 'stockId'].includes(event.target.dataset.elCalcComponentField)) refreshMain();
    });

    mount.addEventListener('keydown', event => {
      if (event.key === 'Escape' && state.print.open) {
        event.preventDefault();
        closePrintDialog();
      } else if (event.target.id === 'elSearchInput' && event.key === 'Enter') {
        event.preventDefault();
        runSearch();
      }
    });
  }

  async function init() {
    try {
      state.db = await openDatabase();
      await loadRecords();
      await seedChemicals();
      await inspectStorage();
      bindEvents();
      renderShell();
    } catch (error) {
      console.error(error);
      mount.innerHTML = `<div class="el-fatal"><h3>无法打开本地实验知识库</h3><p>${escapeHtml(error.message)}</p><p>请确认浏览器允许 IndexedDB；file:// 模式建议改用项目附带的本地启动脚本。</p></div>`;
    }
  }

  window.addEventListener('beforeunload', () => {
    state.objectUrls.forEach(url => URL.revokeObjectURL(url));
    state.objectUrls.clear();
  });
  window.addEventListener('pagehide', () => { flushPendingSaves(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPendingSaves();
  });

  window.ExperimentLibraryReady = true;
  init();
})();
