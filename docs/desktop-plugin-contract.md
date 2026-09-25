# 桌面版插件接口契约

> 适用范围：dsh-plugin-prompt-tool 作为外部 Cordis 插件，在 Electron 桌面版（DeepSeek Harness Desktop）中的装配方式、可用宿主接口与 Web 版的行为差异。
> 本文描述当前实现的稳定契约，不是实施计划；与官方源码不一致时以官方源码为准。
> 相关代码：`cordis.patch.yml`、`package.json#dsh`、`src/index.ts`、`src/client/index.ts`、`src/shared/bridge-contract.ts`。
> 官方依据：DeepSeek Harness 工作树 `apps/desktop/README.zh.md` 与 `apps/desktop/src/`；本文所有结论均可回溯到具体文件行号。

本文只记录长期稳定的接口边界。桌面版自身的打包、签名、更新与安装器流程不在范围内。

## 1. 桌面版是什么

桌面应用是完整 dsh Web 应用外的一层 Electron 壳：Electron 以 RunAsNode 子进程启动共享 profile runner，主窗口立即从打包静态资源加载 Web 入口，等待 Host 启动注入后在**同一个文档**里激活客户端插件。Web 负责 RPC 与流，桌面载体把本地页面接到已认证的 Host 上。

| 事实 | 值 |
|---|---|
| 应用文档来源 | `dsh-app://app/`（本地静态文件，不走 Host） |
| 默认端口 | `19387`（Web 版为 `3080`），可由 `webserver.config.port` patch 覆盖 |
| profile | `$DSH_HOME/profiles/desktop`，Electron 独占 |
| 发布身份 | Electron 壳与 `@deepseek-ai/dsh` 恒为同一精确版本；升级 dsh 必须发布新 Desktop 版本 |

**对本插件最重要的一条**：桌面壳**不提供插件扩展点**。应用 preload 只向 `dsh-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择、`__DSH_HOST_PATHS__` 桥接和租约范围内的 Browser 桥接；插件的安装与激活一律通过共享的 Web 插件管理器与认证 HTTP 路由，**任何渲染进程都拿不到文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数**。

## 2. 插件在桌面版的装配链

    PROFILE_TEMPLATES.web            packages/boot/app-boot/src/profile.ts:183-185
      -> initProfile(profileDir)     apps/desktop/src/project-manager.ts:175
      -> $DSH_HOME/profiles/desktop  apps/desktop/src/paths.ts:19
      -> loadProfileDirectory        apps/desktop-host/src/index.ts:23
      -> runtime resolution          apps/cli/src/profile-boot.ts:205-206

要点：

- Desktop profile 由 **web 模板**初始化（`['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']`），本插件是随后追加进 `dsh.profile.bundles` 的外部 bundle。
- Desktop 用 `loadProfileDirectory` 加载已初始化目录，**不经 CLI 的 profile 查找**；CLI 直接拒绝该名字：`profile "desktop" is managed exclusively by the Electron application`（`apps/cli/src/args.ts:83-87`，大小写不敏感）。
- 官方包经 **runtime resolution 拦截 ESM/CJS 解析器**，不在 profile 的 `node_modules` 里建链接；profile 侧只清理早期 Link 后端写下的 `.dsh-module-fallback` 投影（`apps/desktop/src/project-manager.ts:89`）。启动**从不运行 pnpm**。
- 不要与"不可变 runtime 树里存在物理 `node_modules/<name>`"混淆（`apps/desktop/src/runtime-tree.ts:130`）——那是签名资源内部，不是 profile 的链接。

本插件的声明（三处缺一不可）：

| 声明 | 位置 | 作用 |
|---|---|---|
| `dsh.bundle.patch` | `package.json` | 指向 `./cordis.patch.yml`，声明这是一个 profile 组合层 |
| insert 行 | `cordis.patch.yml` | `- insert: [{ id: prompt-tool, name: dsh-plugin-prompt-tool }]` |
| `dsh.client` + `exports["./client"]` | `package.json` | 声明浏览器半侧 roster 条目与产物入口 |

装包时的硬规则：`dsh.bundle` 缺失的依赖只会被装成**普通依赖**并收到 stderr 警告，不会成为 profile 层（`packages/boot/plugin-manager/src/operations.ts:101-104`）；`dsh.bundle.patch` 引用的每个 patch 文件都会被预校验，任一不可解析即整体失败。

## 3. patch 层的应用顺序

唯一实现在 `packages/boot/app-boot/src/profile-context.ts:63-74`，顺序为：

1. bundle 层，按 `dsh.profile.bundles` 顺序；层内按 `dsh.bundle.patch` 的文件顺序
2. profile 自己的 `cordis.patch.yml`
3. home 级 `$DSH_HOME/cordis.patch.yml`
4. `--patch` overlay，按 argv 顺序
5. 遥测 disable patch

两种形态：按 `id` 替换目标行的**整个 config（不深合并）**，或 `- insert:` 插入新行。patch 目标不存在只打 stderr 警告；**空文件或纯注释文件会导致启动失败**，禁用某一层必须显式写 `[]`。

本插件只在 profile patch 层插入一行，不覆盖任何官方行。

## 4. 客户端半侧的 roster 规则

浏览器半侧不是自动发现的，必须同时满足（`packages/client/modules/src/index.ts:823-858`）：

1. 该行是**裸包名** specifier（子路径行永不带浏览器半侧）
2. 包 manifest 声明 `dsh.client`
3. `dsh.client.platform === 'web'`
4. 存在 `exports["./client"]`

`dsh.client` 的字段全部是手写校验，无 JSON Schema：

| 字段 | 必需 | 语义 |
|---|---|---|
| `platform` | 是 | 只选 `web` |
| `inject` | 否 | **信息性包名依赖，不是 Cordis 服务注入** |
| `immediately` | 否 | boot 一阶段注册屏障；缺省进 application 批 |
| `external` | 否 | 基座之外的精确 module-table 请求 |

两个静默失败模式必须记住：导出 `./client` 但漏写 `dsh.client` → **浏览器半侧永不提供且无报错**；声明 `dsh.client` 但没有 `./client` → 无条目可服务（官方由 `scripts/verify-cordis-config.ts:112-117` 兜底）。

真正的服务注入写在浏览器半侧源码里（本插件为 `src/client/index.ts` 的 `export const inject`），与 manifest 的 `dsh.client.inject` 是两回事。

## 5. 桌面版与 Web 版的差异

两端共用同一套客户端插件系统、`dsh.client` 扫描、`/plugins/*` 路由与 slots/settings 接口。以下是桌面版**真实存在**的差异：

| # | 差异 | 桌面版 | Web 版 |
|---|---|---|---|
| 1 | 启动注入的传递 | Host 采集后经 IPC 下发，页面调 `applyIndexInjections` | 服务端直接渲染进 index.html |
| 2 | 页面侧 `script-preload` 注入行 | **空操作** | 生效 |
| 3 | `__DSH_TRANSPORT__` | `{ ownsHost: true, streamBaseUrl }` → `isLoopback = true` | 不携带 → `isLoopback = false` |
| 4 | 插件 bundle 缓存头 | 强制改写为 `no-store`（revision 每次启动都变） | 沿用 Host 的 immutable |
| 5 | 转发时的头处理 | 响应剥 `set-cookie` 与连接级头；请求剥 `host/origin/cookie/sec-fetch-site` 再注入 Host cookie | 直连，无此层 |
| 6 | origin 校验 | `origin` 非 `dsh-app://app` 直接 403 | 无 |
| 7 | 侧栏浏览器标签 | **启用**（`profileContext.name === 'desktop'` 才挂该行） | 整行缺席，tab 类型不存在 |
| 8 | `<webview>` | 仅主窗口允许，且受主进程租约/分区强制 | 不适用 |

第 3 条的推论：桌面版下 `ctx.connection.isLoopback` 与 `ctx.remote.$host.isLoopback` 均为 `true`，因此**设置持久化正常走 Host**；官方 ui-settings README 里"非 loopback 无持久化"那句在桌面版不适用。

## 6. 客户端插件可用与禁用的接口

两端一致、可放心依赖：

- `ctx.slots` 全套：`register` / `inject` / `registerFactory` / `entries` / `entriesOfSlot` / `snapshot` / `subscribe` / `getVersion`
- 设置面：`ctx.configForms.get(entryId)`、`describe()`、`whileServed(namespaces, register)`；`ctx.settingsSchema`
- **`ctx.settings` 是 Host 服务，浏览器半侧不存在**
- `ctx.remote.*` 与 `ctx.remote.$on()`

桌面版独有、可探测使用的桥：

| 桥 | 用途 |
|---|---|
| `dshDesktop.protocolVersion === 1` | 桌面判定（Web 不存在） |
| `html[data-platform]` | 平台判定 |
| `dshDesktop.browser` | 侧栏浏览器租约（只有 lease 与 URL 穿层） |
| `dshDesktop.shortcuts` / `.keyboard` | 快捷键 |
| `dshDesktop.updates.status/open/subscribe` | 只读更新态（不接受版本、产物 URL 或安装授权） |
| `__DSH_HOST_PATHS__.pathFor(file)` | 拖入文件转 `@path` 引用 |
| `__DSH_DIRECTORY_PICKER__.pick()` | 原生目录选择 |
| `__DSH_LOCALE__.read/onChange` | 语言 |

明确拿不到：`fs`、`nodeIntegration`、原始 `ipcRenderer`、任意 pnpm 参数、Host 端口；非 `dsh-app://app` 文档与 `dsh-app://app` 的子框架只拿到 `{ protocolVersion: 1 }`。

## 7. 适配约束

本插件与桌面版的接口只有一条:**loopback settings bridge**。因此：

- 所有插件状态读写走 `/api/prompt-tool/settings/*`，不新增任何 Electron IPC 依赖；桌面壳没有为插件预留这类通道。
- bridge 的 loopback、Host/Origin 校验、请求体上限、统一 `{ ok, value }` 包装在两端一致，桌面版不额外放宽。
- 桌面版多一层 Electron HTTP 转发，**插件侧不需要为之做任何特殊处理**；反向代理式的头改写由壳负责。
- 诊断插件问题时，页面文档是 `dsh-app://app`，不要把 `http://127.0.0.1:19387/...` 的裸探测结果当成插件行为的证据：该端口需要 Host 认证 cookie，且 `/plugins/*` 与 `/api/prompt-tool/*` 的认证要求不同。

### 7.1 窗口 chrome 让位（消费官方 CSS 变量）

桌面版的窗口顶部有一段**原生** chrome 不参与网页布局；插件若把可交互控件画在那里，点击会被 Electron 判成拖窗口。官方为此在根元素发布三个变量，**插件只消费它们，不做运行时平台探测**：

| 变量 | 桌面版取值 | Web 版 | 用途 |
|---|---|---|---|
| `--dsh-windows-titlebar-height` | Windows 40px | 未定义 → 回退 0 | 精确的原生 caption 行高度 |
| `--dsh-frame-top-clearance` | 固定 48px | 未定义 | 「窗口顶带下沉量」语义，含额外 8px |
| `--dsh-frame-leading-clearance` | macOS 收起侧栏时 160px / 全屏 84px | 未定义 | 左上角窗口 chrome 的行内带宽 |

**为什么选 `--dsh-windows-titlebar-height`**：它是唯一精确的 caption 高度真源（`apps/desktop/src/preload-windows.ts:13` 设为 40px），而 `--dsh-frame-top-clearance` 面向「窗口顶带下沉」语义、会多让 8px。变量在 Web 版未定义即回退 0，因此叠加写法两端都对，**不需要任何 `data-platform` 分支**。

本插件消费这些变量的位置：

| 位置 | 变量 | 解决的问题 |
|---|---|---|
| `src/client/app/workspace/PromptWorkspace.module.css`（masthead 上内边距） | titlebar-height | 标题栏内的「返回对话」/关闭按钮落在拖拽带上点不动 |
| `src/client/app/workbench/Workbench.module.css`（抽屉面板四向 padding） | titlebar-height + leading-clearance | 抽屉内容顶到窗口边缘；macOS 交通灯压住品牌与标题 |
| `src/client/ui/controls.module.css`（模态背板与最大高度） | titlebar-height | 矮窗口下居中模态的头部进入拖拽带 |
| `src/client/app/workbench/floating-trigger-position.ts`（`titlebarTopInset()`） | titlebar-height | 悬浮入口被拖进拖拽带后**点不开也拖不回来**（位置已持久化，等于永久失去入口） |

悬浮入口的夹取下界取「边缘留白」与「顶部安全线」的较大者；视口矮到两者无法同时满足时，退化为「按钮完整可见」，与 `clampAxis` 的既有契约一致。

## 8. 已知残留

- **预设导出的下载确认**：`src/client/features/presets/PresetExportDialog.tsx` 用 blob URL + `a[download]` 触发下载。桌面主窗口 session 没有 `will-download` 处理（只有 guest 侧 session 注册并 `preventDefault`），因此走 Electron 默认下载流程（原生「另存为」对话框）。当前把 `revokeObjectURL` 的宽限期设为 60 秒作为冗余保险；blob 数据在下载启动时已被读取，**这是保险而非功能依赖**。
- **悬浮入口位置偏好不做跨载体迁移**：位置只写 `localStorage`，桌面 origin 是 `dsh-app://app`，与 Web 版互不相通，清站点数据即丢。官方同类偏好在桌面版有走原生文件适配器的先例（快捷键存 `userData/keybindings.json`），本插件暂不跟进。

## 9. 与本文相关的官方文档/源码不一致

排查时已核对并记录，供后续升级时复核：

| 位置 | 不一致 |
|---|---|
| `docs/subsystems/boot.zh.md:19` | 只列 `ChangeResult.application` 四个值；源码是五个（含 `cancelled`，`packages/boot/plugin-manager/src/types.ts:114`） |
| `packages/extensions/cordis-client-runner/src/index.ts:5` | 注释写作 `dshClient`，实际字段是 `package.json.dsh.client` |
| `packages/boot/app-boot/src/profile.ts:11-14` | 层顺序注释漏了 home 级 patch；实现与另外三处文档都含它 |
| `packages/bundle/web-app/cordis.patch.yml:271` | 注释称 "Web profiles opt in"，与 `:274` 表达式（非 desktop 一律 disabled，无 opt-in 开关）不符 |
| `docs/cookbook/adding-a-settings-card.zh.md:42` | 写 `form.state`；源码无 `state` 成员，只有 `getSnapshot()` / `subscribe()` |

## 10. 更新本文的方式

改动本插件的桌面版适配时：

1. 先在官方工作树核对对应文件（本文引用的行号会随官方版本漂移，行号失效时按符号名重新定位）。
2. 只把**稳定契约**写进本文；一次性的排查结论、临时探测与版本相关的临时现象留在 `.ai-memory/`。
3. 交付前运行 `git -C <repo> diff --check`，并核对本文中的路径与命令仍然存在。
