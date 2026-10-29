# Nuvyn PWA 安装与运行（REQ-PWA-001）

PWA 使用与 Web 相同的 Vue 前端、Hono API 和 NAS 数据。它不是独立原生 App，
**不提供离线记账、离线日记保存或跨设备本地草稿同步**。

## 安装

前提：通过同一个 HTTPS 反向代理域名访问 Nuvyn（生产环境的
`NUVYN_PUBLIC_ORIGIN` 必须与实际访问的 origin 一致）。

- Android：使用 Chrome 打开 Nuvyn，在浏览器菜单中选择“安装应用”或“添加到主屏幕”。
  取决于浏览器、设备与 Google 服务支持情况，可能安装为 WebAPK 或主屏幕快捷方式。
- iPhone：在 Safari 打开 Nuvyn，使用“分享 → 添加到主屏幕”，选择作为 Web App 打开。
- 首次安装后，独立 PWA 的浏览器存储可能与原浏览器标签页隔离；需要重新登录是正常的。
  已保存的 NAS 数据不受影响，但 IndexedDB 中未保存的本地草稿不会自动迁移。

安装图标全部源自现有 `public/logo.svg`：保留 SVG 矢量图标，同时提供
Android 192×192、512×512 PNG，以及单独留安全边距的 512×512 maskable 图标。
iOS 主屏幕使用独立的 180×180 PNG；背景为与当前 PWA 主题一致的 `#f8fafc`。
这不是新的品牌图形或移动端专用 Logo。

## 图标维护

仅在 `public/logo.svg` 品牌图形发生改变时重新导出 PNG：

```bash
python -m pip install "cairosvg==2.7.1" "Pillow==11.3.0"
python scripts/generate-pwa-icons.py
```

PNG 作为静态资源提交到仓库，不在 NAS 生产启动或 Docker 构建时依赖 Python 图像库。
安装、验证过程中不要清理浏览器的 IndexedDB 草稿。

## 缓存与更新

- Service Worker 只处理同源、路径为 `/assets/*` 且带 Vite 内容哈希的 JS、CSS、字体与图片。
- 不拦截导航 HTML、`/api/*`、日记正文、Ledger 交易、附件、认证响应及其写操作。
- HTML 一律 `Cache-Control: no-store`；`sw.js` 和 `manifest.webmanifest`
  使用 `Cache-Control: no-cache` 以便重新校验。
- 新版通常在重新打开/刷新页面后取得新的 HTML 和带哈希文件。
  Worker 不调用 `skipWaiting()`，避免强行替换正在编辑的窗口。
- 无网络时显示浏览器自身的离线/网络错误；**不得提示写入成功**。

## 真机验收

1. Android Chrome 和 iOS Safari 分别安装，确认图标、名称、独立窗口、可返回及安全区域。
2. 登录、退出、七天有效期、Diary 锁、Ledger 新增交易正常；禁用网络后不可误报保存成功。
3. 打开日记，使用软键盘输入，切换页面并返回；测试不同屏幕尺寸与刘海/底部手势区域。
4. DevTools Application → Cache Storage：仅包含 `nuvyn-pwa-assets-v1` 的静态资源，
   不出现用户 API 响应、HTML 或未保存的日记/账本数据。
5. 部署新版本后刷新：确认 HTML/JS 更新，不显示旧包页面；打开正在编辑的日记时不强制刷新。
6. 若在离线或代理故障下看到旧 UI，应先恢复网络并刷新；切勿直接清理网站数据，
   以免删除当前设备尚未恢复的草稿。

## 构建与测试

```bash
npm run typecheck
npm run build
npm run test:unit -- server/__tests__/pwa-install.test.ts
```

PWA 资源随 `public/` 一起进入 Vite `dist/` 和现有 GHCR 镜像；
不修改数据库、Vault、Docker Compose 或 Release Workflow。
