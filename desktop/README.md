# BioAssay Studio Windows 桌面版

此目录包含 Windows 安装版的 Electron 外壳。网页端与桌面端共用仓库根目录中的 qPCR、WB、蛋白定量和实验知识库代码；构建前会自动复制最新网页资源。

## 本地运行

需要 Node.js 与 npm：

```powershell
npm install
npm start
```

## 生成 Windows 安装包

```powershell
npm run dist:win
```

输出位于 `dist/`：

- `BioAssay-Studio-v<版本>-Windows-x64-Setup.exe`
- 同名 `.blockmap`
- `latest.yml`

其中安装包、blockmap 和 `latest.yml` 必须一起上传到同一个 GitHub Release，在线更新才能正常工作。

## 更新与隐私

- 软件不会在后台自动检查更新。
- 只有用户点击页面右上角或“帮助”菜单中的“检查更新”时，主进程才连接 GitHub Releases。
- 用户确认后才下载；下载完成后可立即重启安装，或在退出软件时安装。
- qPCR、WB、蛋白定量和知识库数据始终在本机处理，不会经由更新服务上传。

## 代码签名

构建配置支持标准 NSIS 安装包，但仓库不包含商业代码签名证书。未签名安装包首次运行时可能触发 Windows SmartScreen 提示。
