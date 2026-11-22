# Web 客户端 UI 结构框架

提示词工具的工作台负责编辑、展示和提交配置。宿主持有官方会话、预设及页面容器，工作台沿 SlotRegistry、ConfigForms、官方会话服务和 loopback Bridge 接入。引擎负责九个插入点及执行语义，`module.yml` 持有规则和模块配置，`promptConfigs` 提供运行时投影和指令文件视图。

## 按任务查阅

- [关闭工作台会不会发请求？](subsystems/ui-lifecycle.md#入口与关闭行为) 查看 Slot、桌面接入、可见性、诊断与会话回退。
- [画布如何筛选、创建和排序？](subsystems/ui-workbench.md#画布导航模块与规则) 查看工作台导航、规则编辑器和模块操作。
- [保存失败如何恢复？](subsystems/ui-editing.md#保存保护) 查看首屏、草稿、保存应答、冲突及导入确认。
- [请求如何选择模块和验证权限？](subsystems/ui-bridge.md#模块主语策略) 查看共享载荷、传输和信任边界。
- [改控件、文案或样式要验收什么？](subsystems/ui-controls.md) 查看共享交互、键盘焦点和浏览器验收。

## 分层与依赖方向

| 层 | 责任 | 可以依赖 | 不应依赖 |
|---|---|---|---|
| index.ts | 声明 inject、构造宿主适配面、注册工作台 | app/workbench、data、shared | 具体页面、业务卡片、CSS 细节 |
| app/ | Slot owner、工作台壳、页面组合 | features、data、ui、官方槽位类型与注入面 | host 内部实现、另一套导航/状态框架 |
| features/ | 单一业务领域的视图、瞬时状态和领域 helper | data、ui、自己的 CSS | 其他 feature 的内部文件、slot 注册 |
| data/ | bridge、Fields、store facade、保存与纯逻辑 | shared contract、React hooks（仅 hook 文件）、纯 engine `.mjs`（无宿主 import；如 `rule-facts` / `audience`） | React 业务视图、feature 组件 |
| ui/ | 只接收 props/callback 的共享呈现和交互 | React、同层 helper、插件 CSS | store、bridge、data、features、宿主 DOM |
| shared/ | client/host 共用的字段、路径和载荷契约 | 标准 TypeScript | 任一具体 UI 实现 |

跨领域视图在 `app/workspace/pages/` 组合，业务页面复用 `ui/` 的控件与宿主主题 token。feature 间只通过各自的公开依赖面协作。相对 TypeScript import 保留 `.ts` 或 `.tsx` 扩展名。

## 状态所有者

`native-workspace-state` 管理入口和会话浏览状态。`WorkspaceStoreOwner` 管理插件级字段、目录、模块草稿和保存队列，指令正文按 `contextId` 隔离。模块编辑目标由当次请求声明，官方会话预设由宿主持有。页面只订阅所需字段，业务视图把显式值和回调传给共享控件。

组件通过 [store-ports.ts](../src/client/data/store-ports.ts) 依赖所需端口。`src/client/index.ts` 装配宿主适配，`lib/` 为构建产物。

### 4.3 入口与关闭行为

见[工作台入口与关闭行为](subsystems/ui-lifecycle.md#入口与关闭行为)。

### 5.2 画布导航、模块与规则

见[画布导航、模块与规则](subsystems/ui-workbench.md#画布导航模块与规则)。

### 10. 样式所有权

见[客户端样式所有权](subsystems/ui-controls.md#样式所有权)。

### 12.1 契约测试

见[客户端契约测试](subsystems/ui-controls.md#契约测试)。
