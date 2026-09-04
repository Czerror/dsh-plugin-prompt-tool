# 引擎能力卡片重构计划

## 状态

- **当前阶段**：Wave 0–4 已执行；视口 smoke 已通过，保留少量文档/业务限制。
- **本轮目标**：把模块列表重构为按引擎能力归一的卡片；由预设模块事实决定卡片存在；官方预设按实际 `ToolSchema` 展开工具卡；能力/recipe 创建使用一次原子写盘；小控件紧凑而大文本/JSON 保持自适应。
- **已完成前置**：`project-engine.md` 已重命名为本文件；`SillyTavern.md` 位于 `docs/`；卡片拆分、官方 `Menu`、模块事实、ToolSchema 预览和 recipe 创建已按下列 Wave 落地。

## 一、审查结论与修订动作

| 编号 | 问题 | 修订动作 |
|---|---|---|
| P1 | 静态八卡造成未装配能力的幻影卡 | Wave 0 先返回模块事实，Wave 1 只按能力满足规则渲染 |
| P1 | `effectiveModules` 未定义空数组、composition、嵌套行和别名 | 统一 `declaredModules/effectiveModules/rowIds/sourceMode/editable`，能力目录用 `moduleKeys + rowIds` |
| P1 | 通用设置/引擎能力视图在重写中丢失 | Wave 1 增加 `general/capability` 正交视图，layer filter 保持独立 |
| P1 | `toolFilter*`、`allowKinds` 在主页面和子代理卡重复编辑 | 只保留引擎模块卡 owner；Delegation 只编辑 `maxDepth` 和策略 |
| P1 | 官方工具来源不应使用 `pluginInventory` 或本插件目录 | Wave 2 使用 `agentPresets.list()` 白名单 + `standingKeyFor()` + `tools.schemas(scope)` |
| P1 | 自定义工具与官方 schema 同名时重复显示/运行时失败 | 保存前拒绝重复 id/name；有效 schema 去重；可编辑 custom 卡优先显示 |
| P1 | recipe “写入 preset.yml”与“不写入实体”互相矛盾 | 明确 recipe 不持久化为实体，但展开结果一次写入目标 `preset.yml` |
| P2 | 紧凑 CSS 误伤普通卡片 | `moduleCard/toolCard` 专用 scope；普通 input/Menu 保留标准尺寸 |
| P2 | `moduleConfigs` 不回显 | Wave 0 将 params > moduleConfigs > row default 的有效摘要返回给 UI |
| P2 | 仅源码正则测试不能证明行为 | 增加纯函数、bridge fake service、写盘回滚和 owner 唯一性测试；最后做隔离视口 smoke |

## 二、稳定接口与事实模型

### 2.1 卡片类型

| 卡片 | 存在性来源 | 内容来源 | 写入方式 |
|---|---|---|---|
| 通用行为卡 | `promptConfigs` | `PromptConfigDraft` | 现有配置保存链 |
| 引擎设置卡 | `PresetModuleFacts` 满足能力目录 | `params/moduleConfigs` | 现有参数桥 |
| 预设工具卡 | `ctx.tools.schemas(presetScope)` | `name/description`，首期不下发完整 schema | 只读 |
| 自定义工具卡 | `preset.yml.customTools` | `ToolDraft` | `/custom-tools`，编辑卡优先于只读 shadow |

清空 `customTools` 只删除自定义工具声明，不自动反向删除 `tool-config-engine`；该模块可能由用户显式装配，保留为 dormant 模块，能力目录不会为它生成编辑卡。

### 2.2 模块事实契约

```ts
interface PresetModuleFacts {
  declaredModules: string[] | null // 缺少 modules = null；不把缺失当空数组
  effectiveModules: string[] | null // modules:[] 展开 FALLBACK；composition 以 null 表示无模块清单
  rowIds: string[] // 顶层及嵌套 config 行的稳定 id，去重保序
  sourceMode: 'explicit' | 'fallback' | 'composition' | 'official' | 'unknown'
  editable: boolean
}
```

规则：

1. `modules` 非空：`sourceMode=explicit`，`effectiveModules` 为清理后的模块名。
2. `modules: []`：`sourceMode=fallback`，`effectiveModules` 为引擎现有 `FALLBACK_MODULES`；不改变运行时兼容语义。
3. 无 `modules` 但有 `composition`：解析内联/相对文件/组合名的所有行 id，`sourceMode=composition`。
4. 无法解析组合或非本插件官方预设：`sourceMode=unknown`，UI 不猜测、不创建能力卡。
5. `rowIds` 递归包含 group 的 `config` 子行，覆盖 `official-persistent-shell → persistent-shell`、`bootstrap-filesystem → str-replace-editor`、`delegation-ptc → delegation` 等别名/嵌套情况。
6. `moduleConfigs` 有效值按 `params > moduleConfigs > row default` 合并，仅作为编辑器回显，不改变单一写入 owner。

### 2.3 能力目录

能力 id 与组合文件名、Cordis row id 分离：

| capabilityId | moduleKeys | rowIds/别名 | displayLayer | owner |
|---|---|---|---|---|
| `tool-bootstrap` | `tool-bootstrap` | `tool-bootstrap` | `system-section` | EngineModuleList |
| `context-gate` | `context-gate` | `context-gate` | `pre-step` | EngineModuleList |
| `anchor-turn` | `anchor-turn` | `anchor-turn` | `pre-step` | EngineModuleList |
| `code-presentation` | `code-presentation` | `code-presentation` | `tool-pipeline` | EngineModuleList |
| `tool-filter` | `tool-filter` | `tool-filter` | `tool-pipeline` | EngineModuleList |
| `str-replace-editor` | `str-replace-editor`, `bootstrap-filesystem` | `str-replace-editor` | `tool-pipeline` | EngineModuleList |
| `deliberation-gate` | `deliberation-gate` | `deliberation-gate` | `tool-pipeline` | EngineModuleList |
| `cot-drip` | `cot-drip` | `cot-drip` | `tool-pipeline` | EngineModuleList |

满足条件是 `moduleKeys` 或 `rowIds` 任一命中；facts 为 `unknown/null` 时不显示可编辑卡。

## 三、Wave 执行清单

### Wave 0：事实与能力目录（阻塞项）

**目标**：提供可测试的 facts/capability/identity 纯函数，不改 UI。

- 在 `src/shared/engine-capabilities.ts` 定义 facts、能力目录、满足判断、recipe 定义和自定义工具 identity 校验。
- 在 `src/host/manifest.ts` 暴露 `resolvePresetModuleFacts()`；复用现有 `FALLBACK_MODULES`、`moduleFile()` 和 YAML parser，递归收集 row id。
- `/bootstrap` 返回 `moduleFacts`；客户端 store 保留该事实。
- 自定义工具 identity：`id` 唯一、运行时 `name`（缺省回落 id）唯一；空/重复在写盘前 fail loud。

**验收**：显式模块、`modules:[]`、composition、嵌套 row、别名、未知组合和 params-only 均有纯函数测试；未知 facts 不产生卡片；重复 custom id/name 被拒绝。

### Wave 1：模块卡与视图

**目标**：按 Wave 0 facts 显示卡片，恢复通用/能力双视图，修正 owner 与 CSS scope。

- `EngineModuleList.tsx` 按 capability 满足判断渲染；保留原 store action 和 layer filter。
- `PromptConfigsEditor.tsx`/`MainSessionPage.tsx` 增加 `viewMode: general | capability`；两个视图不复制状态，切换不改变 layer filter、dirty 状态或保存协议。
- `DelegationToolsCard.tsx` 删除 `toolFilterAllow/toolFilterDeny/allowKinds` 编辑入口，只保留 `maxDepth` 与 `subagentToolPolicy`。
- `EngineModuleCard.tsx` 增加 `moduleCard` 标记；`CustomToolCard` 增加 `toolCard` 标记。
- `MenuSelect` 标准触发器 36px、模块/工具卡紧凑触发器 28px；普通 `.configInput` 34px；模块/工具卡单行输入 28px；标准开关保留 40×24，模块/工具卡视觉开关 32×18 且 label 保留可点击热区。
- `configTextarea`、JSON `autoResizeTextarea`、`field-sizing: content`、`max-height` 不改。

**验收**：只装配 `context-gate` 的预设不出现其他能力卡；`modules:[]` 仅显示 fallback 满足的卡；双视图切换可逆；每个引擎参数只有一个 UI owner；普通卡和模块卡尺寸 scope 正确。

### Wave 2：官方预设 ToolSchema 卡

**目标**：按官方 roster 懒加载一个预设的有效工具面。

- 扩展 `/tool-surface` 请求为互斥 `{ sessionId } | { presetId }`，响应增加 `source` 与 `presetId?`，保持旧 session 调用兼容。
- Host 仅在显式 `presetId` 请求时调用 `await agentPresets.list()`、`standingKeyFor(presetId)`、`tools.schemas(scope)`；不遍历/轮询/预热全部预设。
- 只返回 `name/description`，按 name 首次保留并稳定排序；PTC 文案称“预设工具能力”，不称模型直连工具。
- 客户端通过官方 `ctx.remote.agentPresets.list()` 获取选择器 roster；`ToolSurfaceView` 支持 session/preset 二选一，tool-pipeline 中一份 schema 一张只读卡。
- custom 同名时编辑卡优先；只读列表标明 shadow/已由自定义卡呈现，不重复生成。

**验收**：unknown preset=404、mount/schema 失败=409、两个 id 同时提供=400；session 回归；只调用一次 standingKeyFor；动态工具/shadow/run_code 由 schemas 原样反映；现有会话不热切换。

### Wave 3：能力创建与 recipe

**目标**：UI 新建一项能力或 recipe 时，服务端一次写入 modules/初始 params 并重建一次。

- 新增受控 `engineCapability` bridge：只接受服务端白名单的 `capabilityId/recipeId`，不接受任意模块路径或参数对象。
- 展开 recipe 得到有序去重 module keys；先在内存 YAML Document 合并 `modules`、不覆盖已有 params/moduleConfigs。
- 候选文档执行 render/assert 与 row path 检查，全部通过后原子替换 `preset.yml`，再调用一次 `rebuildPreset()`。
- recipe 不作为持久化实体；展开结果必须写入目标 preset.yml。写盘/重建失败时 preset.yml 与生成目录均保持原样；串行队列/expectedRevision 防并发丢写。
- system preset 先复制为 user preset；首期不做删除（避免反向依赖与 dormant 参数误删）。

**验收**：重复创建幂等、一次写盘/一次 rebuild、失败零写入、既有参数不覆盖、依赖循环拒绝、system 只读。

### Wave 4：文档、视口与交付

- 同步 `docs/ui-architecture.md`、`docs/architecture-params.md`、`docs/engine-reuse.md`；本文件只保留执行状态。
- 隔离 `DSH_HOME`、随机端口做 1440×900 与 390×844 smoke：菜单 portal、卡片无横向溢出、标准/紧凑尺寸、JSON 自适应、无 console/page error。
- 运行完整 `typecheck/lint/test/build/diff --check`，仅暂存本轮文件，提交中文 Conventional Commit 并推送 `origin/dev`。

## 四、非目标与回滚

- 不移动或复制 `engine/` 文件，不改变六个 seam 的运行顺序、epoch、disposer 或参数优先级。
- 不把 `pluginInventory` 当工具 schema 来源，不使用静态 knownTools/provider 猜测归属。
- 不支持同一模块多实例；不在本轮实现能力删除。
- 每个 Wave 结束保留可回滚提交点；bridge/schema 失败时先回退该 Wave，不覆盖用户 preset；UI 失败只回退客户端文件和测试。

## 五、验证证据登记

| Wave | 状态 | 证据 |
|---|---|---|
| Wave 0 | 已完成 | `module-facts.test.mjs`、`engine-capability.test.mjs`；显式/fallback/嵌套/params-only/重复 identity |
| Wave 1 | 已完成 | `engine-module-cards.test.mjs`、`menu-select.test.mjs`、ARIA tabs；typecheck/lint |
| Wave 2 | 已完成 | `bridge-contract.test.mjs`、`bridge-client.test.mjs`；session/preset XOR、roster、排序、错误码 |
| Wave 3 | 已完成 | `engine-capability.test.mjs`；一次写入、幂等、候选失败不改文件 |
| Wave 4 | 已完成 | 隔离 DSH_HOME + 随机端口 Edge CDP smoke：1440×900/390×844、0 原生 select、无横溢出、无聚合卡 |

对应提交点：`ad81b28`（卡片/工具面）、`0d43fde`（模块事实/视图）、`0973cb4`（边界/回显）；本次视图筛选和计划收口另行使用 `refactor:` 提交。

## 六、完成定义

Wave 0–4 已完成。后续若要增加 schema 参数详情、能力删除或更复杂的 preset 归属，必须另开计划并补充对应 Host/bridge 回归；本计划不把这些未实现扩展算作当前交付。
