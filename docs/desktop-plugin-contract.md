# 桌面版插件接口契约

> 适用范围：dsh-plugin-prompt-tool 作为外部 Cordis 插件，在 Electron 桌面版（DeepSeek Harness Desktop）中的装配方式、可用宿主接口与 Web 版的行为差异。
> 插件构建与依赖基线为已发布的 DSH `0.2.2-rc.2`；本文桌面壳行为核对自官方 `0.2.2-rc.3` 工作树，不据此承诺 rc.2 的桌面能力。升级或适配以目标版本的发布包、类型和源码为准。
> 相关代码：`cordis.patch.yml`、`package.json#dsh`、`src/index.ts`、`src/client/index.ts`、`src/shared/bridge-contract.ts`。
> 官方依据：DeepSeek Harness 的 `apps/desktop/src/`、`apps/desktop-host/src/` 与 `packages/client/modules/src/index.ts`。行号随版本变化，核对时按符号定位。

本文只记录长期稳定的接口边界。桌面版自身的打包、签名、更新与安装器流程不在范围内。

## 1. 桌面版是什么

桌面应用是完整 dsh Web 应用外的一层 Electron 壳：Electron 以 RunAsNode 子进程启动共享 profile runner，主窗口立即从打包静态资源加载 Web 入口，等待 Host 启动注入后在**同一个文档**里激活客户端插件。Web 负责 RPC 与流，桌面载体把本地页面接到已认证的 Host 上。

| 事实 | 值 |
|---|---|
| 应用文档来源 | `dsh-app://app/`（本地静态文件，不走 Host） |
| 默认端口 | 由系统分配（`apps/desktop-host/src/index.ts:30` 的 `--port 0`），可由 `webserver.config.port` patch 覆盖 |
| profile | `$DSH_HOME/profiles/desktop`，Electron 独占 |
| 发布身份 | Electron 壳与 `@deepseek-ai/dsh` 恒为同一精确版本；升级 dsh 必须发布新 Desktop 版本 |

**对本插件最重要的一条**：桌面壳**不提供插件扩展点**。应用 preload 只向 `dsh-app://app` 文档暴露启动就绪、致命启动失败上报、原生目录选择、`__DSH_HOST_PATHS__` 桥接和租约范围内的 Browser 桥接；插件的安装与激活一律通过共享的 Web 插件管理器与认证 HTTP 路由，**任何渲染进程都拿不到文件系统访问、原始 Electron IPC、shell 或任意 pnpm 参数**。

## 2. 插件在桌面版的装配链

Desktop 从 web 模板初始化 `$DSH_HOME/profiles/desktop`，随后加载该目录。本插件作为外部 bundle 加入 `dsh.profile.bundles`。该 profile 由 Electron 独占，CLI 拒绝使用 `desktop` 名称（大小写不敏感）。

官方包通过 runtime resolution 解析，不在 profile 的 `node_modules` 建链接，启动不运行 pnpm。签名 runtime 资源内部的物理 `node_modules` 不属于 profile 装配面。

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
| 3 | 连接信任 | 壳提供 `ownsHost: true`，连接视为 loopback | 按页面 hostname 判断，localhost／loopback 地址也为 true |
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

插件业务状态通过 loopback settings bridge 读写，导航、会话与目录选择复用官方客户端服务：

- 所有插件状态读写走 `/api/prompt-tool/settings/*`，不新增任何 Electron IPC 依赖；桌面壳没有为插件预留这类通道。
- bridge 的 loopback、Host/Origin 校验、请求体上限、统一 `{ ok, value }` 包装在两端一致，桌面版不额外放宽。
- 桌面版多一层 Electron HTTP 转发，**插件侧不需要为之做任何特殊处理**；反向代理式的头改写由壳负责。
- 诊断插件问题时，页面文档是 `dsh-app://app`，不要把 `http://127.0.0.1:<端口>/...` 的裸探测结果当成插件行为的证据：桌面版端口由系统分配，且该端口需要 Host 认证 cookie、`/plugins/*` 与 `/api/prompt-tool/*` 的认证要求不同。
- 目录选择调用 `ctx.uiWorkspace.pickDirectory()`（`src/client/index.ts`），由宿主决定是否使用原生对话框；插件不直接依赖 `__DSH_DIRECTORY_PICKER__`。

### 7.1 窗口 chrome 让位（消费官方 CSS 变量）

工作台使用宿主原生槽位，面板几何和标题栏让位由宿主持有，不再创建 body portal 抽屉或叠加标题栏内边距。

插件自有业务浮层仍须避开窗口拖拽带：

| 消费位置 | 官方变量 | 规则 |
|---|---|---|
| `src/client/ui/controls.module.css` | `--dsh-frame-chrome-top` | 模态背板的顶部与最大高度只让位一次；Web 下回退 0 |
| `src/client/ui/anchored-popover.ts` | `--dsh-windows-titlebar-height` | 按实际 caption 行高夹取悬浮面板，不用含额外留白的 `--dsh-frame-top-clearance` |

插件不再消费 `--dsh-frame-leading-clearance`。不读取宿主 DOM，不新增运行时平台分支；桌面窗口几何的版本变化需对照官方布局源码复核。

## 8. 已知残留

- 模块导出仍由 `src/client/features/modules/ModuleExportDialog.tsx` 使用 blob URL 与 `a[download]`，60 秒后回收 URL。rc.3 的 `apps/desktop/src/file-actions.ts` 已有 `will-download` 处理，但只接管带 `#dsh-download=` 的官方请求；本插件未走该接口，下载交互仍由 Electron 默认流程决定，需按目标桌面版本实测。

工作台已采用原生导航、会话分页与右侧 tab，不再有悬浮入口或其 localStorage 位置偏好。

## 9. 与本文相关的官方文档/源码不一致

本文不维护随版本漂移的官方注释差异清单。遇到文档与类型冲突，先核对目标发布版本的实现；本地 rc.3 源码只能作为对应版本的依据，不能替代 rc.2 发布契约。

## 10. 更新本文的方式

改动本插件的桌面版适配时：

1. 先在官方工作树核对对应文件（本文引用的行号会随官方版本漂移，行号失效时按符号名重新定位）。
2. 只记录稳定契约及必要版本条件；一次性探测和历史排查结论不保留在本文。
3. 交付前运行 `git -C <repo> diff --check`，并核对本文中的路径与命令仍然存在。
