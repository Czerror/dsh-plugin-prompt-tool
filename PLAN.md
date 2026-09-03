# dsh-plugin-prompt-tool UI 结构框架优化计划

> 分支：`dev`
> 仓库基线：`cd9c64e`
> DSH 宿主基线：`76fda729`
> 策略级别：L3 结构重构，按可独立回滚的小 Wave 实施
> 当前状态：**待用户批准，尚未实施任何 UI 代码改动**

## 一、目标

本计划优化的是 Web 客户端的结构、依赖方向、状态边界、样式所有权与可测试性，不重写产品能力。

完成后应达到：

1. `src/client/index.ts` 只负责宿主能力适配与总装配。
2. SlotRegistry 接入、工作台壳、业务页面、数据层、共享 UI 各有单一职责。
3. 五个业务页面按领域组织，不再全部依赖一个平铺目录和一个 1500 行样式文件。
4. `PromptToolStore` 继续作为统一状态入口，但保存队列、字段映射、脏检测等纯逻辑移出 React hook。
5. 所有 bridge 路径和载荷通过 `src/shared/bridge-contract.ts` 的类型化契约消费，不再散落字符串路径。
6. 标准控件直接复用 `@deepseek-ai/dsh-client-ui-primitives`；原生 HTML 能解决的继续用原生 HTML。
7. 本地 UI 模块只隐藏真实复杂行为，不创建薄 `Button`、通用 `Card` 或未来占位脚手架。
8. CSS 按壳层、共享形态和业务领域归属，继续使用 CSS Modules、`clsx` 与 DSH `--dsw-*` token。
9. Tabs、Dialog、拖拽替代操作、焦点恢复等交互具备确定性可访问性契约。
10. 重构期间不改变 preset、params、promptConfigs、variables、customTools、角色卡或子代理策略的存储和生成语义。

核心结论：

> 采用“宿主原子优先 + 现有 seam 深化 + 领域文件归位”的 A′ 路线；不引入 Tailwind、shadcn/ui、Base UI、Radix、Redux、Zustand、路由库或新测试框架。

---

## 二、明确排除

本轮不做：

- 不修改 DeepSeek Harness 源码。
- 不改 `cordis.patch.yml`、bundle 顺序或现有三个 SlotRegistry 注册点。
- 不新增宿主 DOM 选择器、`MutationObserver` 或独立 React root。
- 不引入 Shadow DOM、Tailwind、全局 reset、CSS-in-JS 或第二套主题变量。
- 不引入通用客户端状态库、事件总线或 URL router。
- 不把 settings bridge 改成另一套网络协议。
- 不改变 `preset.yml` 的字段、空值、优先级和原子写盘语义。
- 不改变提示词插入层、位置、时机、受众、epoch 或组合模块运行语义。
- 不把 PTC、首轮锚定、router-guide、Flash 路由等可选能力提升为默认主线。
- 不为减少文件行数机械拆文件；只有形成清晰接口、消除错误依赖方向或获得可测试性时才拆。
- 不全量替换 98 个原生按钮或一次性重写全部 CSS。
- 不重启、停止或替换当前运行中的 DSH 服务。

---

## 三、已确认现状

### 3.1 规模

`src/client/` 当前共有：

```text
31 个文件
约 8547 行
约 394 KiB 源码
```

主要集中点：

| 文件 | 行数 | 当前责任 |
|---|---:|---|
| `prompt-tool-store.ts` | 1101 | fields、加载、保存队列、脏检测、模型目录、参数、技能动作、草稿状态 |
| `PromptUi.module.css` | 1542 | 几乎所有页面与控件的共享和业务样式 |
| `EngineModuleCards.tsx` | 613 | 模型、委派工具、引擎模块卡片 |
| `PromptConfigCard.tsx` | 511 | 通用 Field、JSON、变量、策略参数、配置表单、卡片壳 |
| `SkillsSettings.tsx` | 468 | 页面、筛选、统计、技能行、目录管理 |
| `prompt-tool-bridge.ts` | 472 | UI Fields、默认值、HTTP、上传、响应解析、view 映射 |
| `CustomToolsModuleCard.tsx` | 412 | 参数编辑器、工具卡、列表加载保存、模板和工具面 |
| `PromptConfigList.tsx` | 408 | 排序、过滤、校验、保存、批量操作、卡片列表 |
| `SubagentToolPolicyCard.tsx` | 376 | policy 解析、加载保存、角色绑定、规则编辑、预览 UI |

文件大不是单独的缺陷；问题在于同一文件拥有多个变化原因，纯逻辑与 React、传输与状态模型、共享控件与业务页面互相穿透。

### 3.2 当前正确边界必须保留

- `src/client/index.ts` 已只使用官方 client services 装配宿主能力。
- `slot-workbench.tsx` 通过 `ctx.slots.inject()` / `ctx.slots.register()` 注册：
  - `shell.overlay`
  - `settings.plugins.tab`
  - `sidebar.footer.action` 几何探针
- 工作台与 settings tab 共享 controller、Host API 和 settings transport。
- `PromptToolWorkspaceController` 是轻量、引用稳定的外部状态面。
- 当前会话模型走官方 sessions projection 与 `session.selectModel`。
- fields 使用 `useSyncExternalStore` 选择器避免全树无关重渲染。
- 打开工作台时通过聚合 `/bootstrap` 读取主数据，模型目录单独惰性加载。
- 保存链已有草稿版本、防旧响应覆盖、队列串行化和条件参数发送语义。
- Client/host 共用 bridge 契约已存在于 `src/shared/bridge-contract.ts`。

优化必须深化这些 seam，不能用新框架替换它们。

### 3.3 当前结构病灶

#### P1：传输文件拥有 UI 状态模型

`prompt-tool-bridge.ts` 同时声明：

- `Fields`
- `StageDraft`
- `EMPTY_FIELDS`
- fetch/upload transport
- runtime shape guard
- `fieldsFromView()`

结果是 store 的核心状态类型反向依赖传输模块。目标应是“状态模型被 bridge mapper 使用”，而不是“状态模型属于 bridge”。

#### P1：bridge 路径仍散落在业务模块

客户端存在二十余处：

```ts
bridgePost('/bootstrap', ...)
bridgePost('/preset-delete', ...)
bridgePost('/characters-list', ...)
```

虽然 server 注册使用 `BRIDGE_ENDPOINTS`，client 调用仍可拼错或在路径改名时漏改。已有 `BridgeRequestMap` / `BridgeValueMap` 足以建立一个泛型调用函数，无需为每个端点手写一层类。

#### P1：store 接口过宽

多个页面直接接收完整 `PromptToolStore`，调用方需要知道全部 fields、草稿、保存方法和临时状态。当前选择器已解决部分重渲染问题，但接口知识仍扩散到业务组件。

#### P1：共享样式与业务样式没有所有者

`PromptUi.module.css` 有约 324 个顶层 selector：

- `pillButton` 被 11 个文件使用；
- settings 行、配置字段和配置卡壳被多文件共享；
- Skills、Preset、PromptConfig 等大量 selector 只属于单个领域；
- 仍存在约二十个疑似未使用 selector。

继续向该文件追加样式会让任何视觉改动都需要理解整份文件。

#### P1：跨领域复用方向错误

`CustomToolsModuleCard.tsx` 从 `PromptConfigCard.tsx` 导入 `Field`。`Field` 是共享表单形态，却由提示词配置卡拥有，导致 tools 领域依赖 prompts 的具体实现。

#### P1：Tabs 只实现了部分 ARIA 行为

现有 `tab-key.ts` 支持左右键与 Home/End，但两个 tablist：

- 没有 roving `tabIndex`；
- 键盘选择后没有移动 DOM 焦点；
- 缺少 tab 与 tabpanel 的 id/aria 配对；
- 所有 tab 都进入普通 Tab 顺序。

这是应优先修复的真实共享行为。

#### P2：弹窗焦点逻辑重复

`TemplatePicker.tsx` 与 `PresetSwitcher.tsx` 都手写焦点循环；前者还负责焦点恢复。宿主 `Modal` 当前可提供 portal、mask、Escape 和主题样式，但不能直接替换并丢失这些现有行为。

#### P2：壳层文件混合三个 slot owner

`slot-workbench.tsx` 同时实现：

- 浮动触发器；
- 侧栏几何探针；
- overlay 工作台；
- settings tab；
- slot 注册。

这些生命周期由同一个注册函数编排是正确的，但具体渲染实现不必继续挤在一个文件里。

#### P2：页面编排与领域视图混合

`PromptWorkspace.tsx` 同时拥有：

- 页面导航；
- 页面标题/说明/meta 计算；
- loading/notice 壳；
- 主会话页；
- 子代理页；
- 配置列表与模板选择组合。

工作台壳应只知道“当前页面是什么、怎样切换、怎样渲染公共壳”，业务页面应独立。

---

## 四、架构不变量

### 4.1 Slot 与宿主

- `index.ts` 保留字符串数组 `inject`。
- Slot 注册继续使用官方 `ctx.slots.inject()`，并由 Cordis disposer 回收。
- 不改变三个 slot 的 id、order 和 cardinality 语义。
- `sidebar.footer.action` 仍只提供几何，不渲染第二个可见入口。
- body portal 只用于本插件拥有的浮层；不查询宿主 class 或页面结构。
- settings tab 只承载部署轴和默认预设，不复制完整工作台。

### 4.2 状态与存储

- `preset.yml` 继续是预设行为单一来源。
- 标准 settings 继续走 `SettingsScope`。
- 复杂 CRUD、导入导出、大文本和文件继续走 loopback bridge。
- 内容资产不进入 settings descriptor。
- 参数空字符串/空数组继续表示删键；variables 空字符串仍是合法值。
- 保存期间继续防止旧响应覆盖新草稿。
- 切换预设继续通过官方 `agentPresets` 与本插件物化链同步。

### 4.3 UI 与样式

- 标准原子优先使用 `@deepseek-ai/dsh-client-ui-primitives`。
- 继续使用 CSS Modules 和 `clsx`。
- 颜色、边框、背景、状态、动效使用 DSH 语义 token。
- 不定义插件级全局主题，不使用 `:root` 复制色板。
- feature CSS 不使用宿主选择器。
- 每个 selector 有明确 owner；共享 selector 必须对应真实共享形态。

### 4.4 依赖方向

固定依赖方向：

```text
index
  ↓
app/workbench + app/workspace
  ↓
features
  ↓
data + ui
  ↓
src/shared 契约 / React / DSH primitives
```

约束：

- `ui/` 不得导入 `features/`、store 或 bridge。
- `data/` 不得导入 React 视图或 feature。
- feature 不直接导入另一个 feature 的内部文件。
- 多 feature 组合只发生在 `app/workspace/pages/`。
- `index.ts` 不导入具体业务卡片。
- 不新增 feature barrel；相对 TypeScript import 继续显式扩展名。

---

## 五、目标目录结构

这是最终结构方向，不要求一次性移动所有文件；每个目录只有在 Wave 中接收真实代码时创建。

```text
src/client/
├─ index.ts
│
├─ app/
│  ├─ workbench/
│  │  ├─ register-workbench.tsx
│  │  ├─ WorkbenchOverlay.tsx
│  │  ├─ FloatingTrigger.tsx
│  │  ├─ SidebarGeometryProbe.tsx
│  │  ├─ SettingsTab.tsx
│  │  ├─ workspace-controller.ts
│  │  └─ Workbench.module.css
│  └─ workspace/
│     ├─ PromptWorkspace.tsx
│     ├─ WorkspaceNavigation.tsx
│     ├─ WorkspaceFrame.tsx
│     ├─ PromptWorkspace.module.css
│     └─ pages/
│        ├─ MainSessionPage.tsx
│        └─ SubagentPage.tsx
│
├─ data/
│  ├─ bridge-client.ts
│  ├─ bridge-transport.ts
│  ├─ prompt-tool-fields.ts
│  ├─ prompt-tool-view.ts
│  ├─ dirty-state.ts
│  ├─ save-queue.ts
│  ├─ use-prompt-tool-store.ts
│  ├─ use-prompt-tool-fields.ts
│  ├─ session-model-face.ts
│  └─ host-api.ts
│
├─ features/
│  ├─ prompts/
│  │  ├─ PromptConfigCard.tsx
│  │  ├─ PromptConfigForm.tsx
│  │  ├─ PromptConfigFields.tsx
│  │  ├─ PromptConfigList.tsx
│  │  ├─ PromptConfigsEditor.tsx
│  │  ├─ TemplatePicker.tsx
│  │  ├─ useTemplatePicker.ts
│  │  └─ prompts.module.css
│  ├─ modules/
│  │  ├─ EngineModuleCard.tsx
│  │  ├─ EngineModuleList.tsx
│  │  └─ modules.module.css
│  ├─ models/
│  │  ├─ ModelRouteCard.tsx
│  │  └─ ModelRouteStatus.tsx
│  ├─ subagents/
│  │  ├─ DelegationToolsCard.tsx
│  │  ├─ SubagentToolPolicyCard.tsx
│  │  ├─ subagent-policy-draft.ts
│  │  ├─ useSubagentToolPolicy.ts
│  │  └─ subagents.module.css
│  ├─ tools/
│  │  ├─ CustomToolsCard.tsx
│  │  ├─ CustomToolEditor.tsx
│  │  ├─ ToolSurfaceView.tsx
│  │  └─ tools.module.css
│  ├─ skills/
│  │  ├─ SkillsPage.tsx
│  │  ├─ SkillRow.tsx
│  │  └─ skills.module.css
│  ├─ presets/
│  │  ├─ PresetsPage.tsx
│  │  ├─ PresetSwitcher.tsx
│  │  └─ presets.module.css
│  └─ characters/
│     ├─ CharactersPage.tsx
│     ├─ character-card.ts
│     └─ characters.module.css
│
└─ ui/
   ├─ FormField.tsx
   ├─ SettingInputRow.tsx
   ├─ ToggleRow.tsx
   ├─ TagInput.tsx
   ├─ CollapsibleCard.tsx
   ├─ tab-key.ts
   ├─ dialog-focus.ts
   ├─ controls.module.css
   └─ config-card.module.css
```

### 5.1 不创建的目录/模块

- 不创建 `ui/Button.tsx`：直接使用宿主 `Button`。
- 不创建空泛 `ui/Card.tsx`：保留领域卡片和已有 `CollapsibleCard`。
- 不创建 compound `Tabs` 体系：先深化现有 `tab-key.ts`。
- 不创建 `services/`、`repositories/`、`controllers/` 三层同义目录。
- 不创建每个 feature 的 `index.ts` barrel。
- 不创建只含一个常量或一行 re-export 的文件。

---

## 六、各层职责

### 6.1 `index.ts`：宿主适配入口

只保留：

1. `inject` 声明；
2. SettingsScope transport 构造；
3. Host API 构造；
4. session model face 构造；
5. controller 与 workbench face 构造；
6. `registerWorkbenchSlots()` 调用。

不得加入页面、bridge endpoint、表单或业务状态。

### 6.2 `app/workbench/`：slot owner 与浮层壳

- `register-workbench.tsx`：唯一注册点，返回统一 disposer。
- `WorkbenchOverlay.tsx`：读取 controller，处理关闭、Escape、焦点恢复和 drawer portal。
- `FloatingTrigger.tsx`：只负责按钮展示和 controller.toggle。
- `SidebarGeometryProbe.tsx`：只负责 `--pt-sidebar-edge`，保留现有响应式与 ResizeObserver 语义。
- `SettingsTab.tsx`：只展示部署开关和默认预设。
- `workspace-controller.ts`：继续保持无 React、无 Cordis 的开关状态面。

注册逻辑和 owner 组件分离后，slot 生命周期仍集中，渲染细节获得局部测试与样式 owner。

### 6.3 `app/workspace/`：工作台框架

- `PromptWorkspace.tsx`：创建 store、持有当前页、打开时触发同步。
- `WorkspaceFrame.tsx`：header、nav、canvas、loading、notice 公共壳。
- `WorkspaceNavigation.tsx`：五页 tablist 与键盘行为。
- `pages/MainSessionPage.tsx`：组合 models、modules、prompts、tools。
- `pages/SubagentPage.tsx`：组合 models、delegation、policy、subagent prompts。

页面元数据使用一个静态描述表：

```ts
type WorkspacePage = 'features' | 'subagent' | 'skills' | 'presets' | 'characters'
```

描述表只保存 label/title/detail；页面渲染使用简单 `switch`，不引入动态 registry 或路由库。

### 6.4 `data/`：状态、传输和纯逻辑

#### `bridge-transport.ts`

只负责：

- fetch；
- JSON 响应 shape guard；
- body-size/错误消息消费；
- 原始文件流上传。

#### `bridge-client.ts`

使用共享契约提供一个泛型入口：

```ts
call<K extends keyof BridgeRequestMap>(
  endpoint: K,
  body: BridgeRequestMap[K],
): Promise<BridgeResult<BridgeValueMap[K]>>
```

内部用 `BRIDGE_ENDPOINTS[endpoint]`，业务代码不再写 `'/preset-delete'` 等字符串。

流式角色卡上传保留一个专用 typed 函数，不为 29 个端点生成 29 个薄方法。

#### `prompt-tool-fields.ts`

拥有：

- `Fields`
- `StageDraft`
- `HostDefaultModel`
- `EMPTY_FIELDS`
- `EMPTY_META`
- `SwitchSnapshot`
- 默认展示值与字段级纯 helper

UI 状态模型不再属于 bridge。

#### `prompt-tool-view.ts`

拥有：

- bootstrap/view 到 `Fields` 的转换；
- 内容资产 text 提升/剥离；
- runtime shape 到 UI 模型的纯映射；
- 参数已存在键集计算。

#### `dirty-state.ts`

拥有：

- snapshot 生成；
- fields/configs/variables 深比较；
- incomplete stage 判断；
- dirty 汇总。

所有函数无 React、无网络，可由 Node test 直接导入。

#### `save-queue.ts`

隐藏：

- 串行保存；
- revision 冲突刷新；
- 草稿版本判断；
- 保存期间继续编辑；
- 成功后是否 reload/rebuild。

接口只暴露“提交一次保存任务”和“当前是否繁忙”，不把 Promise 链细节泄漏到页面。

#### `use-prompt-tool-store.ts`

继续是统一 facade，负责把：

```text
settings mirror + typed bridge + save queue + fields snapshot
```

组合成 React 可消费状态。

它不再包含可独立测试的 parser、deepEqual、参数 ops 构造和 feature 专属网络流程。

### 6.5 `features/`：业务领域

每个 feature 负责：

- 本领域视图；
- 本领域瞬时状态；
- 必要的领域纯 helper；
- 本领域 CSS；
- 本领域直接回归测试。

每个 feature 不负责：

- SlotRegistry；
- 全局工作台导航；
- 共享 bridge transport；
- 其他 feature 的内部状态；
- 主题定义。

### 6.6 `ui/`：共享呈现与交互

只接收 props/callback，不读取 store、bridge、session 或 preset。

保留或新增的真实共享 seam：

- `FormField`：从 `PromptConfigCard` 移出，供 prompts/tools/modules 共用。
- `SettingInputRow`
- `ToggleRow`
- `TagInput`
- `CollapsibleCard`
- `tab-key`：完整键盘导航。
- `dialog-focus`：只在两个弹窗共同迁移时加入，封装首焦点、循环、恢复。

---

## 七、信息架构与页面框架

### 7.1 可见入口保持不变

```text
settings.plugins.tab
  └─ 基础设置：部署开关 + 默认预设

shell.overlay
  └─ 完整工作台
      ├─ 主会话
      ├─ 子代理
      ├─ 技能设置
      ├─ 预设配置
      └─ 角色管理
```

不新增第二套入口，不把工作台内容塞回 settings tab。

### 7.2 主会话页

固定编排：

```text
模型路由状态
主会话模型
工具与深度
提示词配置入口/内容资产
按层筛选的配置列表
可选引擎模块
自定义工具
```

注意：这是 UI 分组，不定义六个 seam 的全局运行顺序。运行时仍按各官方插入点独立装配。

### 7.3 子代理页

固定编排：

```text
模型路由状态
子代理模型
委派工具与深度
实例级工具策略
子代理受众提示词配置
```

主会话专属模块不在此复制，避免双入口。

### 7.4 技能、预设、角色页

- Skills：统计/筛选、技能列表、目录来源三块。
- Presets：切换/新建/导入导出、部署路径与生成开关。
- Characters：导入、库存、应用状态、删除/打开目录。

每页使用同一 `WorkspaceFrame`，但不创建万能 `Page` props 体系；公共壳只负责布局，领域内容仍由页面自己拥有。

### 7.5 状态展示

统一语义：

- `loading`：保留旧数据，不闪回全页骨架。
- `saving`：禁用冲突操作，但不冻结其他草稿编辑。
- `notice`：工作台公共状态区，使用 `role="status"`。
- 表单级 validation：贴近字段展示，不只依赖顶部 notice。
- destructive confirmation：保持二次确认与焦点不丢失。

---

## 八、状态所有权

| 状态 | Owner | 生命周期 |
|---|---|---|
| 工作台 open | `PromptToolWorkspaceController` | client 插件生命周期 |
| 当前顶层页 | `PromptWorkspace` | 工作台挂载期；不写 URL/localStorage |
| fields/meta/providers/catalog | `usePromptToolStore` | 工作台挂载期，打开时重同步 |
| settings tab 值 | 官方 `SettingsScope` | 宿主 mirror 生命周期 |
| 当前会话模型 | `session-model-face` | 官方 sessions projection 生命周期 |
| config/filter/search | 对应 feature | 页面/feature 生命周期 |
| modal open/delete confirm | 对应 feature | 局部瞬时状态 |
| preset/character/tool CRUD busy | 对应 feature hook | 请求生命周期 |
| 保存队列/revision/draft version | `save-queue` + store | 工作台挂载期 |
| 大文本/角色文件 | 文件/bridge | 不进入 settings descriptor |

规则：

- 不把所有瞬时状态塞进全局 store。
- 不让叶子组件直接读取整个 store。
- page orchestrator 使用 selector 取得窄切片，再把值和 callback 传给叶子。
- 只有多个页面共享且需要一致事务语义的状态才进入 store。
- 不新增 React Context；当前树深和调用关系不需要它。

---

## 九、Bridge 优化方案

### 9.1 目标

- client 路径与 shared contract 单一来源；
- 载荷获得编译期 request/value 映射；
- transport、view mapper、UI model 分离；
- 不改变任何 endpoint 或 server handler。

### 9.2 迁移规则

1. 从 `prompt-tool-bridge.ts` 移出 `Fields` 与默认值。
2. 建立 typed `bridgeCall()`，替换所有 raw path。
3. `useTemplatePicker`、ToolSurface、Preset、Character、CustomTools、Policy 全部使用 endpoint key。
4. 保留统一 `{ ok: true, value }` / `{ ok: false, code?, message? }`。
5. 流式上传继续验证文件名、Content-Length 和服务端上限。
6. 删除旧导出，不保留长期 re-export 兼容层。

### 9.3 不做

- 不生成 API client class。
- 不引入 schema client、OpenAPI 或代码生成器。
- 不在 React 组件内重复解析错误载荷。
- 不增加轮询或请求频率。

---

## 十、Store 深化方案

### 10.1 保留统一 facade

页面仍通过一个 `usePromptToolStore(api, settings)` 获得工作台状态，不把加载、revision 和保存事务分散到五个页面。

### 10.2 移出的纯逻辑

- fields/view 映射；
- snapshot/dirty 比较；
- settings path ops 构造；
- param overrides 条件发送；
- stage draft 完整性；
- save queue；
- provider convenience default 判断。

### 10.3 保留在 hook 的逻辑

- React state/ref/effect；
- 打开时 load；
- fields subscriber 发布；
- feature 共用的 action 调度；
- notice；
- 与 Host API 的组合。

### 10.4 Feature face

不为每个页面先定义大接口。迁移时采用最小方式：

- page orchestrator 选取 fields 切片；
- leaf component 接收显式 props；
- 只有同一组值/动作被两个以上组件稳定共享时，才命名为 face。

这样避免把当前大 store 换成五个同样宽的 facade。

---

## 十一、共享 UI 与可访问性

### 11.1 Button

- 新代码直接导入 DSH `Button` / `Pill`。
- 普通、primary、outline、toolbar 映射宿主 variant。
- danger、极小排序按钮、布局尺寸由 feature class 补充。
- 不单独发起“替换全部按钮”工程。
- 使用新 primitive export 时同步更新 client bundle facade 的 require stub。

### 11.2 Card

不创建通用 Card。

保留：

- `CollapsibleCard`：简单非受控折叠设置块；
- 业务配置卡：受控展开、拖拽、保存、删除等由领域拥有；
- 共享 `config-card.module.css`：只承载确定共用的卡壳/header/form 几何。

若共享 CSS 最终仍要求大量条件 selector，说明这些卡片不应共享同一个模块，应回到 feature CSS。

### 11.3 Tabs

第一项代码试点：

1. 当前 tab 只有一个 `tabIndex=0`；
2. 方向键、Home、End 改变选择并移动焦点；
3. tab 设置稳定 id、`aria-controls`；
4. panel 设置 `role="tabpanel"`、`aria-labelledby`；
5. 选择与焦点模式保持自动激活；
6. 纯索引算法留下 Node test。

先深化 `tab-key.ts`；第三个真实 tablist 出现后再评估是否需要 React `Tabs` 模块。

### 11.4 Dialog

迁移两个现有 picker 时统一：

- body portal；
- Escape；
- backdrop 点击；
- 首控件聚焦；
- Tab/Shift+Tab 循环；
- 关闭后恢复触发元素焦点；
- `role="dialog"`、`aria-modal`、可读 title；
- 与 drawer 的 z-index/elevation 一致。

优先复用宿主 `Modal` 的视觉和 portal；若其焦点契约仍不足，只补一个本地 `dialog-focus` 行为模块，不复制整套第三方 Dialog。

### 11.5 表单

- `FormField` 成为共享 label/hint/error seam。
- 原生 `input/select/textarea/details` 保留。
- label 与控件 id 配对；错误通过 `aria-describedby` 关联。
- 数值输入在提交点做解析，草稿期保留字符串，避免输入中间态跳动。
- 文件选择继续使用隐藏原生 input，不伪造文件系统路径。

### 11.6 拖拽与键盘

提示词、技能、阶段排序继续同时提供：

- pointer drag；
- 上移/下移按钮；
- 禁用边界；
- 明确 aria-label。

不能只保留拖拽。

---

## 十二、样式框架

### 12.1 所有权

最终分为：

```text
app/workbench/Workbench.module.css
app/workspace/PromptWorkspace.module.css
ui/controls.module.css
ui/config-card.module.css
features/*/*.module.css
```

### 12.2 迁移方法

- 组件移动时同步移动其独占 selector。
- 同一个 selector 被四个以上领域稳定复用时才进入 `ui/`。
- 每 Wave 迁移一组 owner，不先复制再长期双写。
- 新 CSS 导入生效后立即删除旧 selector。
- `PromptUi.module.css` 最终无引用后删除。

### 12.3 宿主规范对齐

迁移 selector 时同步对齐当前 DSH 样式规范：

- 中性平面边框使用 `0.5px`；
- 高层浮层使用 elevation token，不叠加中性 border；
- 正圆和胶囊配对 `corner-shape: round`；
- 动画提供 `prefers-reduced-motion`；
- 焦点态清晰可见；
- 不写主题选择器和静态色板；
- 不新增组件专用全局滚动条规则。

### 12.4 删除候选

现有疑似未使用 selector 只作为审查名单，不能凭文本扫描直接删除。删除前必须检查：

- CSS Modules 动态访问；
- 构建产物映射；
- 条件 class；
- 测试与截图。

候选包括 `assetTabs`、`bootstrapTokensInput`、`configBody`、`pageShell`、`success` 等。

---

## 十三、性能规则

- 保留 `usePromptToolFields` 的引用稳定 selector。
- 叶子组件只订阅实际使用的 fields 切片。
- 不把 store 放入 Context 触发整树广播。
- `useSyncExternalStore.getSnapshot()` 值不变必须复用引用。
- 保留一次 `/bootstrap` 聚合，不拆回多请求首屏。
- 模型目录继续惰性加载和缓存。
- filter/search 只在客户端处理，不因输入字符增加 bridge 请求。
- 不引入虚拟列表；只有实测列表规模和渲染指标证明需要时再做。
- 不引入 dynamic import/code splitting；当前 client module facade 是单 bundle 契约。
- 不为理论性能添加 memo；只保留能隔离真实父级重渲染的 memo/稳定 callback。

---

## 十四、实施 Wave

每个 Wave 独立提交、独立验证、工作树清洁后再进入下一 Wave。

### Wave 0：锁定契约与测试基线

目标：重构前让关键行为可检测。

改动：

- 新增 tabs 纯逻辑测试。
- 增加 client 不允许 raw bridge path 的静态契约测试。
- 固化五页导航 id、三个 slot 注册和无宿主 DOM 选择器契约。
- 为 fields mapper、dirty 比较和保存期间继续编辑补最小测试。
- 记录完整测试基线。

退出条件：所有测试通过；没有业务代码移动。

### Wave 1：类型化 Bridge 与 Fields 归位

目标：先修依赖方向，不改 UI。

改动：

- 新建 `data/prompt-tool-fields.ts`、`data/prompt-tool-view.ts`。
- 新建 `data/bridge-transport.ts`、`data/bridge-client.ts`。
- 使用 `BridgeRequestMap` / `BridgeValueMap` / `BRIDGE_ENDPOINTS`。
- 替换所有 raw path。
- 删除旧 `prompt-tool-bridge.ts`，不留双入口。
- 更新 shared bridge contract 测试和 client 测试。

退出条件：网络请求数量、路径、载荷和错误文案不变。

### Wave 2：Store 纯逻辑抽离

目标：保留一个 facade，减少 hook 的变化原因。

改动：

- 抽 `dirty-state.ts`。
- 抽 `save-queue.ts`。
- 抽参数 path ops / 条件发送纯函数到 fields/view 所属模块。
- `use-prompt-tool-store.ts` 只保留 React 编排。
- 移动 `use-prompt-tool-fields.ts`、`session-model-face.ts`、Host API 类型。

退出条件：

- 保存队列、revision、草稿版本、silent load 行为保持；
- params 与 variables 空值语义不变；
- fields snapshot 引用稳定测试通过。

### Wave 3：Workbench 壳拆分

目标：一个注册点，三个明确 owner。

改动：

- 拆 `slot-workbench.tsx` 为 `app/workbench/*`。
- `register-workbench.tsx` 保留全部 slot 注册和 disposer。
- 几何探针逻辑原样迁移，不重写算法。
- settings tab 独立。
- overlay/drawer/floating trigger 独立。
- `index.ts` 只改 import 路径。

退出条件：

- slot id/order/inject face 完全一致；
- 悬浮按钮覆盖展开、折叠、拖拽、断点；
- 不触碰运行中的 DSH。

### Wave 4：Workspace 与页面编排

目标：工作台壳不再拥有业务页面实现。

改动：

- 拆 `WorkspaceFrame`、`WorkspaceNavigation`。
- 移出 `MainSessionPage`、`SubagentPage`。
- 保留五页 id、顺序、文案与默认页。
- 修复 Tabs 完整 ARIA 行为。
- 页面内容仍使用原组件，先不同时拆 feature。

退出条件：页面切换、重新打开、loading 保留旧内容、notice 行为一致。

### Wave 5：共享 UI seam

目标：先解决错误复用方向，再做领域移动。

改动：

- `Field` 移为 `ui/FormField.tsx`。
- 移动 SettingInputRow、ToggleRow、TagInput、CollapsibleCard。
- 新代码开始直接使用 DSH Button/Pill；不批量迁移无关按钮。
- 两个 picker 同时迁移时加入 `dialog-focus.ts`。
- 建立 `controls.module.css` 与必要的 `config-card.module.css`。

退出条件：`ui/` 不依赖 store/bridge/features；焦点和键盘 smoke 通过。

### Wave 6：Prompt / Module 主链拆分

目标：优先处理复用最多、耦合最大的 UI 主链。

改动：

- `PromptConfigCard` 拆 Form/Fields/Card。
- `PromptConfigList` 保留排序保存编排，纯排序 helper 独立测试。
- `PromptConfigsEditor` 与 TemplatePicker 归入 prompts。
- `EngineModuleCards` 按 EngineModule、ModelRoute、DelegationTools 拆分。
- app page 负责组合，不让 feature 相互导入内部文件。
- 迁移 prompts/modules 独占 CSS。

退出条件：配置顺序、拖拽、批量操作、模板插入、自动保存和 layer/audience 筛选不变。

### Wave 7：其余 Feature 归位

按以下顺序，每个领域可单独提交：

1. Skills：页面/SkillRow/CSS。
2. Subagents：policy draft、feature hook、view、CSS。
3. Tools：参数编辑器、工具卡、工具面、CSS。
4. Presets：CRUD、picker、CSS。
5. Characters：导入/应用/删除、解析 helper、CSS。

退出条件：每个 feature 的 direct bridge 流程已改 typed client，且不存在 feature 内部交叉导入。

### Wave 8：样式收口与清理

目标：删除旧共享大文件和死代码。

改动：

- 迁完剩余 selector。
- 删除确认未使用 selector。
- 对齐 0.5px/elevation/corner-shape/reduced-motion。
- 删除 `PromptUi.module.css`。
- 更新静态契约测试，禁止新代码重新导入它。
- 更新 README 与 `project-architecture/` 图。

退出条件：无全局样式污染、明暗主题一致、窄宽度与侧栏拉伸 smoke 通过。

### Wave 9：全量验收与交付

- 完整 typecheck/lint/test/build。
- 检查 bundle external 和 client facade。
- 隔离 DSH_HOME + 随机端口执行浏览器 smoke。
- 检查工作树和生成物。
- 分 Wave 提交均已推送 `origin/dev`。
- 若只有源码/client bundle 变化，报告用户按实际加载方式刷新；不由本轮重启当前 DSH。

---

## 十五、文件级变更矩阵

| 当前文件 | 目标 | Wave | 处理 |
|---|---|---:|---|
| `src/client/index.ts` | 原路径 | 3 | 只保留装配，改 import |
| `slot-workbench.tsx` | `app/workbench/*` | 3 | 按 slot owner 拆分后删除 |
| `workspace-controller.ts` | `app/workbench/workspace-controller.ts` | 3 | 原样移动 |
| `PromptWorkspace.tsx` | `app/workspace/*` + pages | 4 | 壳与业务页分离 |
| `PromptWorkspace.module.css` | `app/workspace/PromptWorkspace.module.css` | 4/8 | 壳样式保留、业务样式迁走 |
| `prompt-tool-bridge.ts` | `data/bridge-*` + fields/view | 1 | 拆分后删除 |
| `prompt-tool-store.ts` | `data/use-prompt-tool-store.ts` + pure modules | 2 | 保留 facade，抽纯逻辑 |
| `prompt-tool-types.ts` | `data/host-api.ts` / fields / feature types | 1/2/6 | 按 owner 归位后删除 |
| `session-model-face.ts` | `data/session-model-face.ts` | 2 | 原样移动并保留测试 |
| `use-prompt-tool-fields.ts` | `data/use-prompt-tool-fields.ts` | 2 | 原样移动 |
| `PromptConfigCard.tsx` | `features/prompts/*` + `ui/FormField` | 5/6 | 拆共享字段与业务表单 |
| `PromptConfigList.tsx` | `features/prompts/PromptConfigList.tsx` | 6 | 纯排序逻辑可测试化 |
| `PromptConfigsEditor.tsx` | `features/prompts/PromptConfigsEditor.tsx` | 6 | 归位 |
| `TemplatePicker.tsx` | `features/prompts/TemplatePicker.tsx` | 6 | 共用焦点行为 |
| `useTemplatePicker.ts` | `features/prompts/useTemplatePicker.ts` | 6 | typed bridge |
| `EngineModuleCards.tsx` | modules/models/subagents | 6 | 按公开责任拆分后删除 |
| `CustomToolsModuleCard.tsx` | `features/tools/*` | 7 | 编辑器/卡片/加载保存分离 |
| `ToolSurfaceView.tsx` | `features/tools/ToolSurfaceView.tsx` | 7 | typed bridge |
| `SubagentToolPolicyCard.tsx` | `features/subagents/*` | 7 | draft/hook/view 分离 |
| `SkillsSettings.tsx` | `features/skills/*` | 7 | page/row/CSS 分离 |
| `PresetsPage.tsx` | `features/presets/PresetsPage.tsx` | 7 | 归位 |
| `PresetSwitcher.tsx` | `features/presets/PresetSwitcher.tsx` | 7 | typed bridge + picker focus |
| `CharactersPage.tsx` | `features/characters/CharactersPage.tsx` | 7 | 归位 |
| `character-card.ts` | `features/characters/character-card.ts` | 7 | 原样移动 |
| `SettingInputRow.tsx` | `ui/SettingInputRow.tsx` | 5 | 原样移动 |
| `ToggleRow.tsx` | `ui/ToggleRow.tsx` | 5 | 原样移动 |
| `TagInput.tsx` | `ui/TagInput.tsx` | 5 | 原样移动 |
| `CollapsibleCard.tsx` | `ui/CollapsibleCard.tsx` | 5 | 保留具体接口 |
| `tab-key.ts` | `ui/tab-key.ts` | 4 | 深化行为与测试 |
| `textarea-resize.ts` | prompts 或 ui | 6 | 仅一个 owner 时归 prompts |
| `PromptUi.module.css` | ui + feature CSS | 5-8 | 渐进迁移后删除 |

---

## 十六、测试结构

目标测试布局：

```text
test/client/
├─ app/
│  ├─ workbench-contract.test.mjs
│  └─ workspace-navigation.test.mjs
├─ data/
│  ├─ bridge-client.test.mjs
│  ├─ prompt-tool-view.test.mjs
│  ├─ dirty-state.test.mjs
│  ├─ save-queue.test.mjs
│  └─ session-model-face.test.mjs
├─ features/
│  ├─ prompts-ordering.test.mjs
│  ├─ subagent-policy-draft.test.mjs
│  └─ skills-filter.test.mjs
└─ ui/
   └─ tab-key.test.mjs
```

不要求机械迁移所有旧测试目录；只有当源码 owner 迁移时同步归位。

### 16.1 必须保留的契约测试

- client bundle queue/live facade；
- manifest client inject；
- SlotRegistry 注册；
- no-host-DOM；
- sidebar geometry；
- SettingsScope；
- bridge prefix/path/payload；
- session model snapshot 引用稳定。

### 16.2 新增纯逻辑测试

- tabs next index/focus target；
- fields mapper；
- dirty snapshot；
- param ops 条件发送；
- save queue 草稿版本；
- prompt config 排序；
- policy draft normalize；
- typed bridge endpoint coverage。

### 16.3 不新增的测试依赖

- 不加 Jest/Vitest。
- 不加 jsdom/happy-dom。
- 交互 DOM 行为由最小纯 helper 测试、静态契约和隔离浏览器 smoke 共同覆盖。

---

## 十七、浏览器 Smoke 矩阵

使用隔离 `DSH_HOME` 与随机端口，不接触当前服务。

### 壳层

- 左侧栏 56px 折叠。
- 264px 展开。
- 264-420px 拖拽。
- `<1024px` 自动折叠。
- drawer 打开/关闭、Escape、焦点返回触发器。

### 页面

- 五页均可访问，切换后状态不串页。
- 重新打开工作台同步最新 settings。
- loading 保留旧内容。
- notice 与字段错误可读。

### 主题与尺寸

- 明色/暗色。
- 620px 以下窄布局。
- 长路径、长预设名、长技能名。
- 动效减少偏好。
- 键盘-only 操作。

### 高风险流程

- 切换预设。
- 保存 promptConfigs。
- 保存参数同时继续编辑。
- 模板插入和拖拽排序。
- 技能筛选/排序/目录增删。
- 子代理策略加载/保存/预览。
- 角色卡导入、应用、移除、删除。
- picker 焦点循环与恢复。

---

## 十八、验证命令

所有测试 cwd 固定为 `D:\AI\workspase\_temp`：

```pwsh
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'

pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

开发循环只运行受影响测试，但每个 Wave 结束至少执行：

```pwsh
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
```

纯文档 Wave 只运行：

```pwsh
git -C $Repo diff --check
```

---

## 十九、验收标准

### 19.1 架构

- [ ] `index.ts` 只有装配责任。
- [ ] slot 注册只有一个入口，owner 实现分离。
- [ ] workspace 壳不包含 feature 业务实现。
- [ ] `Fields` 不再由 bridge transport 文件拥有。
- [ ] client 不存在 raw bridge endpoint 字符串。
- [ ] feature 不导入其他 feature 的内部实现。
- [ ] `ui/` 不依赖 store/bridge/feature。
- [ ] 不新增状态库、路由库、UI 库或 Tailwind。
- [ ] `PromptUi.module.css` 最终删除。

### 19.2 行为

- [ ] 五页入口、顺序、默认页和 settings tab 行为不变。
- [ ] 三个官方 slot 的 id/order/inject/disposer 不变。
- [ ] 保存队列、revision、草稿保护不变。
- [ ] preset/params/variables/promptConfigs 空值和优先级不变。
- [ ] 预设切换和会话模型仍走官方 API。
- [ ] 无额外首屏 bridge 请求。
- [ ] 未启用可选模块的预设生成结果不变。

### 19.3 UI

- [ ] 所有标准按钮优先消费宿主 primitive，新代码无本地 Button wrapper。
- [ ] Tabs 具备完整键盘和 ARIA 关系。
- [ ] Dialog 具备首焦点、循环、Escape、backdrop 与焦点恢复。
- [ ] 拖拽流程保留键盘替代。
- [ ] 明暗主题、窄布局、reduced motion 正常。
- [ ] 无宿主全局样式污染。

### 19.4 测试与交付

- [ ] typecheck、lint、test、build 全部通过。
- [ ] isolated browser smoke 通过。
- [ ] 每 Wave 一个中文 Conventional Commit。
- [ ] 每 Wave 推送 `origin/dev`。
- [ ] README 与架构图反映最终结构。
- [ ] 未停止或重启用户当前 DSH 服务。

---

## 二十、风险与回滚

| 风险 | 预防 | 回滚 |
|---|---|---|
| 大量移动导致 import/test 漏改 | 每 Wave 只移动一个 owner；禁用长期 re-export | 回退该 Wave 单独提交 |
| store 抽离破坏保存并发 | 先补版本/队列测试，再移动纯函数 | 保留旧 hook 提交作为上一稳定点 |
| typed bridge 与 server key 不一致 | 直接使用 shared maps + coverage test | 回退 Wave 1，不改 server |
| CSS 迁移视觉漂移 | 组件与 selector 同 Wave 移动；逐页 smoke | 回退对应 feature CSS 提交 |
| 宿主 Modal 焦点能力不足 | 保留本地行为 helper | 不替换原弹窗 |
| selector 优化导致重渲染或死循环 | 快照引用稳定测试 | 回退 selector 变更 |
| 路径移动让 client facade require 变化 | bundle facade 测试 | 回退该 Wave |
| 结构重构夹带行为改动 | 行为变更另起任务/提交 | 从结构 Wave 移除行为 diff |

任何 Wave 出现以下情况立即停止后续工作：

- 需要修改 DSH 源码才能继续；
- 需要重启当前用户服务才能完成验证；
- 需要新增 UI/状态/路由库才能维持现有行为；
- 保存语义、bridge 载荷或生成结果发生非计划变化；
- 为兼容过渡产生第二套长期状态源或样式源；
- UI 预览与 runtime 实际结果不一致。

---

## 二十一、提交拆分建议

```text
test: 锁定客户端结构重构契约
refactor: 类型化客户端 bridge 契约
refactor: 拆分提示词工具状态纯逻辑
refactor: 拆分工作台 slot 壳层
refactor: 拆分工作台页面编排
refactor: 归一共享 UI 交互
refactor: 拆分提示词与模块编辑器
refactor: 归位技能与子代理 UI
refactor: 归位工具预设与角色 UI
refactor: 收口客户端样式所有权
docs: 更新 UI 架构与验收记录
```

不得把全部 Wave 压成一个不可审查提交。

---

## 二十二、执行前批准项

用户批准后才进入实现。默认执行顺序为 Wave 0 → 9，不并行修改相互依赖的文件。

需要批准的决策只有三项：

1. **采用本计划的四层结构：`app / data / features / ui`。**
2. **保持现有五页信息架构，不在结构重构中重做产品导航。**
3. **采用 A′ 组件策略：宿主 primitive 优先，不建立本地 Button/Card/Tabs 脚手架。**

未获批准前，本文件是唯一交付物，不修改 UI 源码。
