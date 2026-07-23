'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'bioassay',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

let mainWindow = null;
const smokeTest = process.env.BIOASSAY_SMOKE_TEST === '1';
let updateCheckRequested = false;
let updateDialogOpen = false;

function sendUpdateStatus(status, detail = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:status', { status, ...detail });
}

async function requestUpdateCheck() {
  if (!app.isPackaged) {
    sendUpdateStatus('development', { message: '开发模式不执行在线更新检查。' });
    return { ok: false, code: 'development' };
  }
  if (updateCheckRequested) return { ok: false, code: 'busy' };
  updateCheckRequested = true;
  sendUpdateStatus('checking', { message: '正在检查 GitHub Releases…' });
  try {
    await autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    updateCheckRequested = false;
    sendUpdateStatus('error', { message: error?.message || '检查更新失败。' });
    return { ok: false, code: 'error', message: error?.message || '检查更新失败。' };
  }
}

function setupUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus('checking', { message: '正在检查新版本…' });
  });

  autoUpdater.on('update-not-available', async info => {
    updateCheckRequested = false;
    sendUpdateStatus('not-available', {
      version: info?.version || app.getVersion(),
      message: `当前已是最新版本 v${app.getVersion()}。`,
    });
    if (smokeTest || updateDialogOpen) return;
    updateDialogOpen = true;
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'BioAssay Studio 更新',
      message: '当前已是最新版本',
      detail: `已安装版本：v${app.getVersion()}`,
      buttons: ['确定'],
      defaultId: 0,
      noLink: true,
    });
    updateDialogOpen = false;
  });

  autoUpdater.on('update-available', async info => {
    updateCheckRequested = false;
    const version = info?.version || '新版本';
    sendUpdateStatus('available', { version, message: `发现新版本 v${version}。` });
    if (smokeTest || updateDialogOpen) return;
    updateDialogOpen = true;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '发现 BioAssay Studio 新版本',
      message: `发现新版本 v${version}`,
      detail: '是否现在从 GitHub Releases 下载？下载期间可继续使用软件，完成后可一键重启安装。',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    updateDialogOpen = false;
    if (result.response !== 0) {
      sendUpdateStatus('cancelled', { version, message: '已暂缓本次更新。' });
      return;
    }
    sendUpdateStatus('downloading', { version, percent: 0, message: '正在下载更新…' });
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      sendUpdateStatus('error', { message: error?.message || '下载更新失败。' });
      await dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: '更新下载失败',
        message: '暂时无法下载更新',
        detail: `${error?.message || '未知错误'}\n\n可稍后重试，或从项目主页手动下载安装包。`,
        buttons: ['确定'],
        noLink: true,
      });
    }
  });

  autoUpdater.on('download-progress', progress => {
    sendUpdateStatus('downloading', {
      percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
      transferred: Number(progress?.transferred) || 0,
      total: Number(progress?.total) || 0,
      message: `正在下载更新 ${Math.round(Number(progress?.percent) || 0)}%`,
    });
  });

  autoUpdater.on('update-downloaded', async info => {
    const version = info?.version || '新版本';
    sendUpdateStatus('downloaded', { version, message: `v${version} 已下载完成。` });
    if (smokeTest || updateDialogOpen) return;
    updateDialogOpen = true;
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '更新已准备完成',
      message: `BioAssay Studio v${version} 已下载完成`,
      detail: '建议先保存当前项目。选择“立即重启安装”后，软件将关闭并完成更新。',
      buttons: ['立即重启安装', '退出软件时安装'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    updateDialogOpen = false;
    if (result.response === 0) autoUpdater.quitAndInstall(false, true);
  });

  autoUpdater.on('error', async error => {
    const wasRequested = updateCheckRequested;
    updateCheckRequested = false;
    sendUpdateStatus('error', { message: error?.message || '更新服务暂时不可用。' });
    if (!wasRequested || smokeTest || updateDialogOpen) return;
    updateDialogOpen = true;
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '无法检查更新',
      message: '更新服务暂时不可用',
      detail: `${error?.message || '请检查网络连接后重试。'}\n\n软件其他离线功能不受影响。`,
      buttons: ['确定'],
      noLink: true,
    });
    updateDialogOpen = false;
  });

  ipcMain.handle('update:check', requestUpdateCheck);
}

function webRoot() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'web')
    : path.join(__dirname, 'web');
}

function registerLocalProtocol() {
  const root = path.resolve(webRoot());
  protocol.handle('bioassay', request => {
    const url = new URL(request.url);
    const requestPath = decodeURIComponent(url.pathname || '/').replace(/^[/\\]+/, '') || 'index.html';
    const resolved = path.resolve(root, requestPath);
    const rootPrefix = `${root}${path.sep}`.toLowerCase();
    if (resolved.toLowerCase() !== root.toLowerCase() && !resolved.toLowerCase().startsWith(rootPrefix)) {
      return new Response('Forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(resolved).toString());
  });
}

function installSecurityPolicy(session) {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: blob:; worker-src 'self' blob:; frame-src 'self' data: blob:",
        ],
      },
    });
  });
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

function createMenu() {
  const template = [
    {
      label: '\u6587\u4ef6',
      submenu: [
        { label: '\u91cd\u65b0\u52a0\u8f7d', accelerator: 'Ctrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: '\u9000\u51fa', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: '\u7f16\u8f91',
      submenu: [
        { role: 'undo', label: '\u64a4\u9500' },
        { role: 'redo', label: '\u91cd\u505a' },
        { type: 'separator' },
        { role: 'cut', label: '\u526a\u5207' },
        { role: 'copy', label: '\u590d\u5236' },
        { role: 'paste', label: '\u7c98\u8d34' },
        { role: 'selectAll', label: '\u5168\u9009' },
      ],
    },
    {
      label: '\u89c6\u56fe',
      submenu: [
        { role: 'zoomIn', label: '\u653e\u5927' },
        { role: 'zoomOut', label: '\u7f29\u5c0f' },
        { role: 'resetZoom', label: '\u6062\u590d\u9ed8\u8ba4\u7f29\u653e' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '\u5168\u5c4f' },
      ],
    },
    {
      label: '\u5e2e\u52a9',
      submenu: [
        {
          label: '\u68c0\u67e5\u66f4\u65b0\u2026',
          click: () => requestUpdateCheck(),
        },
        { type: 'separator' },
        {
          label: '\u6253\u5f00\u9879\u76ee\u4e3b\u9875',
          click: () => shell.openExternal('https://github.com/x738/bioassay-studio'),
        },
        {
          label: `\u7248\u672c ${app.getVersion()}`,
          enabled: false,
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'BioAssay Studio',
    width: 1600,
    height: 980,
    minWidth: 1180,
    minHeight: 720,
    show: false,
    backgroundColor: '#f5f7fb',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  installSecurityPolicy(mainWindow.webContents.session);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('bioassay://')) event.preventDefault();
  });
  mainWindow.webContents.on('did-finish-load', async () => {
    console.log(`[desktop-ready] ${mainWindow?.webContents.getURL()}`);
    if (smokeTest) {
      const state = await mainWindow.webContents.executeJavaScript(`({
        title: document.title,
        version: document.documentElement.dataset.appVersion,
        moduleCount: document.querySelectorAll('[data-module]').length,
        bodyReady: document.body.classList.contains('app-ready'),
        desktopUpdateVisible: !document.getElementById('desktopUpdateButton')?.hidden,
        updateApiReady: typeof window.bioassayDesktop?.checkForUpdates === 'function'
      })`);
      console.log(`[desktop-smoke] ${JSON.stringify(state)}`);
      setTimeout(() => app.quit(), 250);
    }
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[desktop-load-error] ${errorCode} ${errorDescription} ${validatedURL}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[desktop-renderer-gone] ${details.reason} exit=${details.exitCode}`);
  });
  mainWindow.once('ready-to-show', () => {
    if (!smokeTest) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL('bioassay://app/index.html');
}

app.whenReady().then(() => {
  app.setAppUserModelId('cn.x738.bioassaystudio');
  registerLocalProtocol();
  setupUpdater();
  createMenu();
  createWindow();
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('window-all-closed', () => app.quit());
