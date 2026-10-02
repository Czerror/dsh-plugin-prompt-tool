# 后端参数框架（架构说明）

> 适用范围：dsh-plugin-prompt-tool 的模块参数、规则兼容投影与配置排序全链路。
> 相关代码：`src/shared/engine-params.ts`、`src/shared/param-keys.ts`、`src/host/manifest.ts`、
> `src/host/write-preset.ts`（materializeModule）、`src/host/module-config-order.ts`、`src/index.ts`、
> `src/runtime/settings-bridge.ts`（/param-overrides）、`src/client/data/use-prompt-tool-store.ts`（fields / persist）。

## 部署设置与编辑目标

Config 只保留持久兼容键 `writePreset`，表示模块运行总闸。关闭只卸载模块注入与工具贡献，不删除模块定义或物化产物；总闸关闭时仍可调整配置排序。`presetOrder`、`fallbackText`、`presetTemplate` 均已退出部署设置。

编辑选择由请求头 `x-module-id` 声明，不改写 settings，也不切换或跟随官方会话预设。未声明目标时由宿主适配器解析默认目录；聚合读取把该目录传给身份投影、共享参数、变量、配置卡与模块事实。写请求的 `expectedPresetId` 只作一致性检查，等待期间仍按同一请求复核目标，错误身份或目标变化返回 `409 preset-changed`。

## 磁盘格式：按插入点组织共享参数

共享引擎参数唯一存于 `layerSettings.<层名>.<参数键>`，例如 `layerSettings.subagent-start.maxDepth: 2`。归属由 `ENGINE_PARAM_DEFINITIONS.storageLayer` 固定；`card` 与编辑组 `displayLayer` 只管理展示，不改变磁盘路径。该段不创建提示词实例，也不生成空 UI 卡。

`promptConfigs[].params` 仍属于单条规则。persona、variables、customTools、subagentToolPolicy 和 moduleConfigs 保留独立所有者。`loadModuleSpec().params` 是读取新格式后得到的**内部平铺适配面**，本文下文的参数桥 `params` 均指该内部对象，不再表示旧磁盘位置。

共享只限于同一预设内的配置卡。预设主模型的 provider/model 与采样参数通过该预设的 `agent-request` 规则生效；预设加载、保存和能力操作不再调用 `agentDefaultModel.saveSelection` 改写宿主全局默认。模型未配置时继承该会话选择。用户在官方“当前会话模型”控件中的显式选择仍遵循官方接口语义。

显式模块预设存在 `promptConfigs` 或可生成的模型请求规则时，生成组合自动补齐 `prompt-config-engine`；`effectiveModules` 同步反映此依赖，`declaredModules` 保持磁盘声明。模型规则由 `host/prompt-configs.ts#modelRequestConfigs` 同时服务生成和依赖判定，避免“规则文件已生成但无消费者”。没有规则或请求参数的空预设仍为空，手写 composition 不被改写。

正常读写仅消费 `layerSettings`；磁盘上的 `params`、`model`、`subagentModel` 和其他未知字段原样保留，但不参与运行参数，也不触发迁移阻断。`layerSettings` 中登记键放错层、层名或形态错误返回 `preset-layer-settings-invalid`（bridge 返回 400），不静默回落成空值。

预设与代码同步维护当前格式，不提供层参数离线迁移、回滚脚本或迁移备份。参数保存直接更新 `module.yml`，空预设保持为空，包内预设和导入产物使用当前格式。

九层 UI、官方参数与插件参数的对照见 [九层契约](injection-point-contracts.md)。

根目录 [module.yml](../module.yml) 是可复制的全参数参考：九层模板与 14 个公开共享参数自动生成，规则示例默认关闭，共享参数以注释参考提供。`pnpm rebuild:preset-template` 使用 YAML Document 从权威目录重建，`-- --check` 检查漂移。

| 公开参数组 | 字段 | 实际作用面 |
|---|---|---|
| 主模型 | `modelProvider`、`modelName`、`modelReasoningEffort`、`modelTemperature`、`modelMaxTokens` | 主会话模型请求 |
| 子模型 | `subagentModelProvider`、`subagentModelName`、`subagentReasoningEffort`、`subagentTemperature`、`subagentMaxTokens` | 本地子代理的实际请求；不改写普通官方 spawn 预检 |
| 策略深度 | `maxDepth` | 已启用的插件子代理工具策略；普通官方委派由宿主管理 |
| 指令提示 | `instructionHint` | 官方指令消息过滤后的可选转换 |
| 工具 | `toolGitBashEnabled`、`customToolRequireApproval` | 插件 Git Bash 开关与自定义执行器批准要求 |

锚定、引导和正文注入的 15 个旧快捷键单列在 `shared/legacy-prompt-params.ts`，不属于公开 EngineParams。`host/legacy-prompt-params.ts` 负责读取与旧 API 投影；新编辑器直接保存规则实例。`strReplaceEditorMaxOutputChars` 已退出插件参数面，编辑器输出限制归宿主工具所有。

## 1. 分层与职责

| 层 | 文件 | 职责 |
|---|---|---|
| 契约层 | `shared/engine-params.ts` | 14 个公开 EngineParams 的类型、校验、storageLayer、UI 归属、默认草稿与组合映射；键集由目录派生 |
| 兼容层 | `shared/legacy-prompt-params.ts`、`host/legacy-prompt-params.ts` | 旧快捷键到规则实例的单一投影；已承接键在保存规则时清理，无承接键保留并告警 |
| 键集合 | `shared/param-keys.ts` | 参数写入白名单包含公开参数、旧 API 兼容键与 `promptConfigs`；不推断模板变量 |
| 存储层 | `host/manifest.ts`、`host/module-layer-settings.ts` | `loadModuleSpec`（layerSettings → 内部平铺值）、`saveModuleParams`（平铺值 → 所属层；空值删键）、`buildModuleConfigsFromParams`（参数桥）、`renderComposition`（参数桥 > moduleConfigs > 行默认） |
| 物化层 | `host/write-preset.ts` | `materializeModule` 统一读取目标模块定义与正文，再由 `writePreset` 生成组合和资产；不使用全局行为参数镜像 |
| 排序层 | `host/module-config-order.ts` | 读配置身份和版本、启用时尾部追加、按身份重排并写回各模块 `configOrder` |
| 装配层 | `index.ts`、`runtime/agent-assembly.ts` | 运行总闸、按启用集合挂载贡献、按配置序号排序与释放 |
| 接线层 | `runtime/settings-bridge.ts` | `/param-overrides` POST 空载荷读取、参数载荷写入请求目标；`/module-config-order` 保存跨模块身份顺序 |
| 消费端 | `client/data/param-overrides.ts`、`prompt-tool-fields.ts`、`dirty-state.ts` | 从共享定义派生 Fields、默认值、读回、序列化及全参数保存快照；store 保留保存队列和宿主适配 |

`buildEngineModuleParams()` 与 `moduleParamFallbacks()` 使用同一字段映射正向装配、反向回显；仅投影白名单参数，不把任意 `moduleConfigs` 或内部路径发送到浏览器。复杂的子代理模型路由／授权关系仍由 `buildModuleConfigsFromParams()` 处理，不伪装成简单字段映射。

`EngineParamFields` 按定义渲染现有能力配置卡。模型路由、子代理策略、自定义工具保留专用编辑器；规则的受众、晋升、内容与匹配条件归规则实例。

## 2. 参数流链路（保存 → 生效）

```
UI fields
  → persistParamOverrides（只发送已存键或用户已改动键；含需清除的 '' / [] 与合法的 false / 0）
    → /param-overrides POST（settings-bridge）
      → saveModuleParams（写 module.yml：layerSettings 的所属层；空值删键）
        → materializeModule（按模块 ID 读取自身定义、正文与兼容规则）
          → writePreset（参数桥、模型请求规则与资产物化）
            → assembly.refresh（刷新受影响 Agent 的运行贡献）
```

本插件的种子化、预设列表、参数与内容读取、保存、物化及导入／导出／复制／删除，
均使用本插件的存储根 `$DSH_HOME/.prompt-tool`，模块根为 `modules/`（`host/paths.ts#MODULES_DIR`，不可配置）。
宿主从不扫描此目录：定义由插件自己解析，运行时装配由插件的配装通道承担（见
[engine-reuse.md](engine-reuse.md)）；会话原有的宿主预设继续提供官方工具行。旧根
`.agent-presets/` 只读不删，本插件不再读写它，也不为其写迁移代码。

模块身份由目录与定义确定。模块列表和配置执行顺序是不同事实，旧 `module.yml.order` 不再由部署设置覆盖；配置排序使用 `configOrder`，不从 `meta.order` 推断。
该目录不只是输出位置，也是预设定义的读取根；不存在对应定义时回退包内模板，
不读取其他部署根中的同名用户副本。

已有用户预设缺少组合源时标记为不可渲染，重建报错并保留原定义，不改用包内同名模板。

### 本地引用与配装路径

模块不经 `agentPresets.register()` 发布，路径换算由运行时配装通道 `runtime/agent-assembly.ts` 承担，不改写宿主 `baseUrl`。

本地引用在**装配期**统一换算——只改装配输入，正本 `agent.cordis.yml` 一字不改，因此用户改
`DSH_HOME` 或复制整个模块根后按新位置重新换算：

- **共享引擎行**由生成侧写**包名说明符** `dsh-plugin-prompt-tool/engine/<module>.mjs`：引擎是
  插件包资产，不再物化到 `<预设根>/.engine/`，预设根只承载用户数据。
- **其它本地模块说明符**（`name` 以 `.` 开头）按预设目录换算为绝对 `file://`。
- **受管配置字段**（`configsDir` / `strategyDir` / `policyFile` / `triggersFile`）按历史语义相对
  `<预设根>/.engine/` 解析为绝对 `file://`。引擎由包内加载后其 `import.meta.url` 不再位于该目录，
  而实测只有 `file://` 形态对全部受管字段一致有效（写成 Windows 盘符路径会被 `new URL()` 当成
  URL scheme，报 `is not readable: The URL must be of scheme file`）。
- 需要 `templateFile` 越界校验的引擎行（`prompt-config-engine`、`tool-config-engine`）额外注入
  `presetRoot`；相对 `templateFile` 仍按历史引擎位置解析，用户预设与提示词配置无需改写。
- `declared-triggers` 同样由注册层注入 `presetRoot`，但其新声明中的模板和自定义策略相对实际
  `triggers.yml` 解析。运行时不虚构历史引擎目录，也不假设声明文件必在固定层数的目录中。

**旧布局不再兼容**：仍写 `./engine/`、`../.engine/` 的预设不再被特殊处理，需重建后重新物化。

该取向与官方一致：`editing-cordis-compositions` 技能要求「Resolve assets from installed
packages rather than a preset directory」，并把 `!!js` 限制在插件配置与 `disabled` 上（行 `name`
不做表达式求值，见 `vendor/loader/lib/types/config/entry.js`）。

### 模块目录与独立补建

包内 `modules/` 是复制与补建来源，不注册到官方预设目录，不探测或重命名用户已有模块。

- **初始化**：`ensurePresetSeed` 按包内同名目录检查，缺哪个只复制哪个；已有目录的定义、组合与资源保持原样。
  初次复制的定义由统一物化入口生成产物，不覆盖其他模块。
- **保存**：当前预设以自身目录为唯一来源生成，模块、人设、变量、工具和子代理策略都从该目录读取。
  保存只重建目标模块；关闭运行总闸不清空组合、正文或配置切片。
- **新建**：直接复制包内同名目录；显式要求递增副本时仍沿用现有目录后缀规则。
- **不与官方预设联动**：模块不进入官方注册表；工作台的编辑选择不保存为部署默认值，不切换或跟随官方会话预设。官方预设继续拥有原有工具与委派创建配置。

### 操作目标与生效结果

工作台编辑目标、宿主默认预设和执行 Agent 的运行时配装是三种身份。角色卡和世界书模型工具**不查询官方预设绑定**：装配期把「这个 Agent 装了哪几层提示词」记进运行时配装记录（启用表 ∩ 磁盘，顺序即启用表顺序），工具执行时按 `ToolExecution.agent.id` 取该记录的第一层作为写入目标，再用**存储根目录事实**判定落点（模块目录含 `module.yml` 的即本插件管理的模块，`moduleDirExists`），最后经 `assertModuleDirectory` 校验存在性、链接与身份。未配装、目录已消失和身份不匹配一律拒绝。写入目标只来自宿主 `agent/created` 建立的装配记录，**不取自工具参数或模型输出**；主会话与子代理各按自己的配装记录解析，工作台切换到另一模块不改变工具写入目标。

保存按实际模块 ID 读取其自身定义并完成物化，再更新当前运行时贡献。启用表改变时，
刷新官方 `agents.list()` 中全部存活 Agent，包括此前没有启用模块的 Agent；配置保存则
刷新受影响的运行实例。bridge、TUI 和模型工具等待刷新完成后才报告成功。定义已保存
而物化或挂载失败时，bridge 返回 `preset-activation-failed`（声明端点保留
`triggers-rebuild-failed`）；已保存定义保留，准备失败不撤旧贡献，挂载失败尝试恢复旧贡献。

### 官方运行时接线

`runtime/agent-assembly.ts` 消费现有模块配置和物化文件，不向官方预设注册表发布模块，
也不持久化模块与会话的绑定。启用表是所有主会话与子代理的共同装配来源；Agent 身份
仅用于官方 scope 的注册、串行更新和释放，不决定加载哪一套配置。

- 官方 `agent/created` 是串行初始化边界：返回装配 Promise，首条请求等待完成；首次
  失败只报告诊断，不中止宿主创建会话。恢复、清空和压缩后的新 Agent 同样走此边界。
- 提示词切片先经既有 `createPromptConfigs` 编译默认值、文本、策略和条件，再由
  `applyPromptConfigs` 接入各自官方插入点；不建立跨插入点的全局执行顺序。
- 模块人设通过 `systemPrompt.section()` 注册独立命名的前缀与后缀；`complete`
  由官方组装器执行，`includeRuntimeContext: false` 调用官方
  `suppressRuntimeContext()`。不覆盖宿主或子代理创建期注册的同名段。
- 内置工具复用 `pt-*` 服务适配器，自定义工具复用现有引擎并调用官方工具注册表；
  顶层触发器的隐含消费者也从已有组合事实挂载。路径在装配期换算到实际模块资产，
  不依赖宿主 Loader 的预设目录或包解析锚点。
- 注册都由运行时 fiber 拥有；关闭、重装、Agent 释放或插件卸载时撤回贡献。
  子代理策略工具同时受模块和 Agent 生命周期约束，注册通知不能重入重复安装。

关闭只影响后续注入及工具可见面，不删除已经进入会话历史的消息。更新插件代码后
需要用户重启 DSH 服务以加载新版；加载后模块开关和配置保存走上述运行时更新链。

### 配置序号与跨模块排序

`module.yml.configOrder` 保存 `{ 配置ID: 非负安全整数 }`，配置的完整身份仍是模块 ID＋配置 ID，正文留在原配置。导入保留来源局部顺序；启用时，未编号配置按步长 10 接在尾部；若已有序号与其他启用模块碰号，按已保存的相对顺序将该模块整体接到尾部，不恢复旧定义数组顺序。重复启用不改无冲突的已保存顺序，新增配置由同一物化入口补齐尾号。

物化文件名前缀来自已存序号，至少补齐四位，不截断大号。文件名前缀和 bridge 读回的 `sequence` 都是投影；排序写入不接受任意序号、正文或路径。

全局排序读取已启用配置的身份列表与 `revision`；写入通过 `/module-config-order` 提交完整身份列表和读取时的版本。服务端拒绝未知／重复身份及过期集合，按身份写回各模块，等待受影响模块物化与刷新后才返回成功。普通配置卡排序使用同一端点，只交换自己的原有槽位，模块启用或停用均可保存自身顺序；模块页可在同一插入点、位置内跨模块移动。

`config.yml.enabled` 只决定参与装配的成员，不决定配置次序；模型工具仍沿用启用表首项的写入目标语义。官方 system/context 的 `order`、显式注册名的同序比较、无模块来源的引擎与触发器，以及 ST 世界书预算的顺序语义见[九层契约](injection-point-contracts.md#order-的作用面与刻度来源)。决策依据见 [ADR-0006](adr/0006-module-config-order.md)。

## 声明规则读写

声明规则独立保存在 `module.yml` 顶层 `triggers`，不进入 `layerSettings`、模板变量或提示词配置数组。`/triggers` 返回声明、完整预设文件的 SHA-256 版本与引擎编辑目录；请求必须携带当前预设身份，保存还必须带读取时的版本。

读取不写盘；`validateOnly: true` 调用实际声明编译器且不写盘；保存通过编译后用 YAML Document 更新顶层段，保留其他字段与注释，再原子替换并走既有重建链。空数组移除声明段。只有带可编辑 `modules` 清单的用户预设可保存，从而保证声明引擎能够自动装配。

当前预设已切换、版本变化、目录或定义为链接、系统只读目录、坏载荷均拒绝写入。重建失败报告“声明已保存，但预设重建失败”，不能作为已生效处理。客户端复用预设保存队列，保留请求期间的新输入；重新读取时若规则未被外部改动可更新版本，否则保留本地草稿并要求显式处理冲突。

## 3. 空值语义（统一规则）

`saveModuleParams` 对空值统一处理（2026-08-25 起）：

| 值 | 处理 | 原因 |
|---|---|---|
| `''`（字符串清空） | **删键** | 回落模板/引擎默认（如 reasoningEffort 留空 = 继承宿主） |
| `[]`（列表清空） | **删键** | 恢复该参数的默认行为 |
| `0`（其余数字） | **写 0，按字段语义消费** | 如策略启用时 `maxDepth: 0` 禁止该策略委派 |
| `false`（布尔） | **写 false** | 引擎 `=== true` 归一，false = 显式关闭（与默认等价或明确） |


**保存前全量参数校验（2026-09-01）**：`/param-overrides` 写分支在落盘前调用
`validateEngineParamValues()`（契约层与渲染消费同源）——覆盖全部 `ENGINE_PARAM_KEYS`：
布尔键必须是 boolean；数值键（temperature/maxTokens）按各自约束（有限数 /
正整数 / 非负整数）；字符串键必须是 string；列表键必须是 string 或
string[]；`maxDepth` 接受 `''`/`provider-managed`/非负安全整数及其数字字符串，
保存校验与插件实例工具策略共用归一化规则（`"0"` 与 `0` 同义），不改写普通官方委派。
公开参数与登记的旧快捷键分别由自身契约校验，其他未知键在保存期返回
`400 overrides-unknown-key` 或 `400 overrides-invalid-value`。
UI 字符串与 module.yml 手写 number 两通道统一；空字符串仍是合法删键值。
渲染层保持宽容（never-brick），配置错误只在保存期响亮失败。

Bridge 读取器区分空请求体与畸形 JSON；非对象 `overrides`、非数组 `promptConfigs`、
非字符串值的 `variables` 均返回 `400`，不会退化为读取或空操作。所有依赖当前预设的
写端点共用 system 预设只读守卫，只有插件预设存储根内的当前预设目录可写。

UI 侧 `persistParamOverrides` **条件发送**：

- `load` 时记录 module.yml 已存在的参数键；
- 已有键即使被改成 `''` / `[]` / `false` / `0` 也发送；保存层只删除空字符串与空列表，合法的 `false` / `0` 照常保留；
- 未改动且 module.yml 未声明的值不发送；比较基线是最近读回／保存的有效草稿，避免把组合行默认值固化进 params；
- 用户把值改到与已加载基线不同即发送，包括从行级 true 改为 false；
- YAML 数值模型参数转换成编辑器字符串，列表完整投影，不再因为草稿类型不同而漏回显。

> 这里的「空值删键」只适用于引擎行为参数，不适用于内容占位变量。`variables` 的空字符串占位键是有意设计，必须继续写入 `variables.yml`，供世界书条目正文以 `{{key}}` 引用：登记发生在 ST 导入期（`src/host/sillytavern.ts:785` 把卡内无源宏登记为空占位）与工作台「模板变量」编辑（`VariablesEditor`，`src/client/features/prompts/PromptConfigFields.tsx:509`），交付时按既有插值替换，空值替换为空串、不留字面量（`engine/executor.mjs:237`、`engine/interpolate.mjs:119`）；占位键不参与引擎参数校验。`world_book_upsert` 只写世界书条目与 note 记忆（`src/runtime/world-book-tools.ts:134-151`），不登记也不调整变量。

### 物化缺省语义：未提供 ≠ 显式空值（2026-09-20）

`writePreset` 的 `runtimeOf` 只投影调用方**真正提供**的引擎参数：

- **未提供（`undefined`）= 不覆盖**：`resolvePresetParams` 跳过 `undefined` 键，缺省值来自
  预设 `module.yml` 的 `layerSettings` 段。导入
  （`installPresetPackage`）、离线物化、补建其他预设等调用方只给部署字段，不再被 writer
  补上的 `false` / `''` / `true` 覆盖作者定义（锚定被关、自定义文本被清空、关闭的注入器被
  启用、子代理模型路由消失）。
- **显式 `false` / `0` / `''` = 显式语义**：布尔的 `false` 是显式关闭；字符串的 `''` 是
  「不设置该值」（路由与模型参数因此不产生行配置或 patch），不回落到预设定义值。
- 验收入口：`test/host/write-preset.test.mjs`（未提供 vs 显式值两组对照）。


## 4. variables 双通道（两套体系，不互串）

1. **引擎行为参数**：公开键由 `ENGINE_PARAM_KEYS` 派生，兼容键由 legacy 目录单列；`params` 整段不参与模块模板变量的读取与生成。
2. **内容占位变量**：`spec.variables` 段（module.yml 顶层 variables）→ `variables.yml`——空值占位键也写入：
   - 引擎插值（`engine/interpolate.mjs`）`hasOwnProperty` 命中 → 替换（空串不留字面）；
   - 用途：模型经 `world_book_upsert` 写世界书条目，内容引用 `{{key}}` 占位；ST 未定义宏登记；
   - UI 模板变量卡（VariablesEditor）可编辑默认值覆盖。

新增参数时必须明确归属：引擎行为参数 → `ENGINE_PARAM_KEYS`（自动进 PARAM_KEYS 参数集合）；内容占位 → `spec.variables` 段。二者不互串。

`variables` 与 `params` 是独立命名空间，允许同名键。保存或清空模板变量只更新
`variables` 段，不删除或覆盖 `params` 中的同名参数（包括显式 `false` 与 `0`）。

预设级变量的唯一来源是顶层 `variables`。`params` 中的旧内容键和嵌套
`params.variables` 不再作为变量读取、回显或生成，也不会自动迁移或删除；旧预设
需自行把所需内容变量改到顶层 `variables` 后重新物化。清空顶层变量后，旧键不再复活。
单条提示词配置的 `promptConfigs[].variables` 仍是局部覆盖，优先于同名预设级变量。

内容变量进入官方插值两层（`system-section` / `runtime-context`）时按每次 assembly 求值：
被引用且已声明的名字注册为官方 `systemPrompt.variable()`，取值优先级＝会话变量覆盖 >
声明值 > 运行时事实（`lastusermessage`/`time` 等）。非法官方名（中文/大写/连字符）改写为
`sv_<slug>_<hash>` 别名并同步改写引用；未声明的引用在出口剥离（`warnOnce` 记录样本）。
同名但不同配置默认值分别绑定，运行时事实大小写变体只注册一次；变量值有界展开后也经过出口清洗。
`random`/`roll`/`chance` 内联求值，动态文本每次 assembly 重算；`pick` 按会话与模板位置稳定选择。
ST 导入配置显式带 `params.stMacros: true`，赋值模板保留到运行期；变量帧只服务宏求值，不建立
跨插入点的全局注入顺序。local/global 分表但均不跨会话持久化，详见 [SillyTavern.md](SillyTavern.md)。

未填写变量名的空键行属于客户端草稿：保存载荷不携带空键，但保存成功不清理本地编辑行，同一预设的后台刷新也不覆盖该草稿。变量值为空字符串与变量名为空不是同一语义；具名空值仍正常持久化。

## 5. 新增参数 checklist（引擎行为参数）

1. `shared/engine-params.ts`：`EngineParams` 加字段，并在 `ENGINE_PARAM_DEFINITIONS` 登记校验、`storageLayer`、默认草稿、卡片和组合映射；键集、普通字段渲染、读写和保存快照自动派生。
2. `PresetWriterParams` 与 `WRITER_PARAM_KEYS` 从公开目录及兼容目录派生；通过键覆盖与真实消费回归验证透传，不再添加手写字段副本。
3. 只有跨字段的模型／授权关系才修改 `host/manifest.ts`；普通模块参数不再额外手写双向映射。
4. 存储：`storageLayer` 是持久契约，不能随 `card` 或 UI 编辑组移动；旧规则兼容只走已有适配器，不恢复全局参数镜像。
5. UI：现有模块普通字段自动渲染；新增特殊交互才扩展专用编辑器，禁止增加第二份参数清单。
6. `docs/architecture-params.md` 如有语义变更同步；CHANGELOG 记条目。

### 旧规则快捷参数的兼容边界

旧键只通过 `shared/legacy-prompt-params.ts` 与 `host/legacy-prompt-params.ts` 进入规则投影，不再进入公开 UI 字段、默认草稿或保存快照。旧 API 保存仍先校验类型与正则，再由同一适配器转换；新功能不得追加第二条规则参数通道。

### 九层编辑归属契约（2026-09-20）

`engine/schema.mjs` 的 `LAYER_ORDER` 是九层顺序的唯一权威，`getEngineMeta()` 同源下发 `layerOrder`；
`src/shared/engine-capabilities.ts` 用 `EngineLayer` 表达同一组层，`ENGINE_EDITOR_GROUP_MAP` 把能力组
（id = 能力 id，通道即 `displayLayer`）与少量专用编辑组（`prompt-defaults` / `persona` / `variables` /
`main-model` / `subagent-model` / `custom-tools`）的主归属登记在一处，`relatedLayers` 只登记确有第二通道的
组。`/meta` 与 `/bootstrap` 只下发 `id` / `displayLayer` / `relatedLayers` / `hook` 白名单字段，不含路径、
行级配置或函数；前端对旧宿主缺字段退化到共享的 `ENGINE_LAYER_ORDER`。展示归属不改变运行时消费：hook、
注册顺序、作用域与 disposer 仍由引擎行自身决定。

## 6. 保存状态机（防保存期间编辑丢失）

`persistParamOverrides` 与 `persistConfigs` 不直接把“当前 fields”当作保存结果：

1. 参数、提示词配置与能力创建/组合创建/移除进入同一个预设保存队列，写入与读回在队列内完成；切换等待已入队操作，失败任务不阻断后续任务；
2. 入队时生成请求快照，载荷与成功后的已保存基线都来自该快照；
3. 请求成功后只确认该快照；若用户在请求期间继续编辑，当前 fields 与快照不等，仍保持 dirty；
4. 只有全局草稿版本未变化、其他保存通道无待存草稿，且对应草稿与请求快照一致时，才在队列内执行静默 `load()`；
5. provider 自动预选只是显示兜底：preset 未声明 provider 且模型名为空时不写入 params，防止 UI convenience default 被固化成用户覆盖。

参数、提示词资产、模板变量、自定义工具、子代理策略及能力变更请求携带可选 `expectedPresetId`。目录由同一请求头解析，该字段只校验已解析目标；旧草稿或等待期间目标改变返回 `409 preset-changed`，不写盘。客户端切换先等待保存队列，再更新编辑目标请求头并重读，不修改部署设置或官方会话预设。

`SwitchSnapshot` 的参数键从目录派生，使用结构化克隆隔离数组和对象；全部参数自动参与脏检测。客户端 `Fields` 从 `EngineParams` 派生草稿类型；bridge transport 保留响应 shape guard。

## 自定义模型工具

`customTools` 仍是预设顶层资产，不进入扁平参数。`host/custom-tools.ts` 的 `compileCustomTool()` 使用官方 DSL 转换函数，随后调用与运行时共用的 `engine/tool-definition.mjs` 校验。`validateCustomTools()` 先检查 ID／工具名称冲突，再完整编译每条定义；失败在 bridge 返回 `400 custom-tools-invalid`，不写盘、不重建。

合法保存保留原始 DSL，通过 `withPresetDoc`、依赖补齐和 `materializeModule()` 物化；运行时仍由 `ctx.effect` 注册和清理。手写／导入模块中的单条坏定义仍告警跳过。自定义工具支持 shell、HTTP、已有工具委托、文件操作和用户询问；本功能不管理外部 MCP 或插件安装。

工具卡同时提供参数行编辑与高级 JSON，修改名称／描述／必填不丢弃嵌套 `properties/items/oneOf/enum`。文件写入／追加显式编辑内容；超时为 `1–2147483647` 毫秒，单工具定义上限 1 MiB，执行器字段在保存前按类型校验。

`customToolRequireApproval` 映射到 `tool-config-engine.requireApproval`，仅允许现有五种执行器名称；内部 `configsDir` 仍由生成器管理，不向配置卡开放。

## 7. 合并优先级（组合行 config）

组合模块目录分工：`engine/compositions/source/local/` 是本项目自有模块的唯一源，
`engine/compositions/library/` 只保存从官方预设切出的行与确有语义差异的变体——随包分发的
版本化快照，生成它的 `rebuild:composition` 已随内置预设目录退场，快照不再重建；
`renderComposition` 跨目录发现同名模块时直接失败，避免源文件与
生成产物漂移。


`renderComposition`：**参数桥（params/UI）> moduleConfigs（模板/ST 行级直写）> 行默认**。
moduleConfigs 仅补充参数桥未覆盖的键（如 ST 导入 tool-web.fetch），不再锁定覆盖 UI 可管理参数（2026-08-25 翻转）。

## 8. 内容策略三功能与参数归属

`engine/instruction-hint.mjs` 是通用内置能力：`placeholder + fill: instruction-hint`
与共享参数 `instructionHint`（由 `instruction-hint` 模块行承接）共用同一组
文件探测、提示文本与转换函数；它不属于任何预设专属模块。`instructionHint` 是默认关闭的
预设级转换开关；对官方待注入消息先应用逐文件过滤，再转换剩余符合条件的全文，不替换历史。

`engine/strategies.mjs` 三个内容策略是**独立功能**，仅分类器在 fallback 层共用：

| 策略 | 功能 | 消费参数 | 注入时机 |
|---|---|---|---|
| `first-turn-anchor`（near-anchor） | 首轮任务分类 → 一次性锚句 | 规则 `params.useCustom/text/buildPattern/complexPattern/firstTurnBuild/firstTurnInspect/firstTurnDeep` | 首条用户消息后一次 |
| `guide-auto`（router-guide） | 每轮路由强弱引导 | 规则 `params.useCustom/text/guideWeak/guideDeep/complexPattern` | 晋升后每轮 |
| `custom-fallback`（prompt-injector） | 确认词匹配后的兜底注入 | 规则 `params.firstTurnWord/anchorWords/text` | 确认后一次 / 未确认两轮兜底 |

复用点：`guideComplexPattern` 冗余副本已移除——引导的复杂判定 fallback 复用锚定的
`complexPattern`。旧预设 params 残留的 `guideComplexPattern` 不再兼容（已从
PARAM_KEYS 移除），本项目也不提供迁移：请自行从 module.yml 删除该键。
锚定与引导**不合并**：锚定句（reasoning 开头句，首轮一次性）与引导句（路由引导，每轮）注入位不同。

### 旧参数投影与规则所有权

`resolveLegacyPromptConfigs` 是读取、物化和旧 API 保存共用的适配器：

- `near-anchor` 承接首轮开关、自定义文本与任务分类参数。
- `router-guide` 承接每轮引导开关、文本与分类参数；`guideEnabled` 独立且缺省关闭，不跟随首轮开关。
- `prompt-injector` 承接旧正文注入开关、确认词和正文来源；有正文才启用，空确认词按锚句派生。

保存规则时，将有效投影写入 `promptConfigs`，只清理已有规则承接的旧快捷键。没有承接配置的旧值保持原样并给出告警，不凭空创建规则或静默丢弃数据。普通内容只归规则自身，旧顶层 `params` 不恢复为参数事实源。

旧物化文件的 `fieldSources` 仍可经白名单读回，但其中旧快捷键不再是公开参数 owner，因此不锁定规则文本、启停或模型范围。保存时剥离 `fieldSources` 和只读 `sequence`，不把它们写成配置正文的一部分。

### 世界书条目结构归一（2026-08-25）

`host/worldbook.ts` 的 `buildWorldBookEntry(input)` 是世界书条目结构工厂（能力归一）：
`strategy/layer/position` 固定值与 params 键集（constant/keys/secondaryKeys/caseSensitive/
wholeWords/selectiveLogic）单一权威。两个写入端共用：
- **ST 导入**（`sillytavern.ts` convertStToPreset）：ST 字段别名收敛（keys/key、constant/add_always、
  disable/enabled、insertion_order/order、case_sensitive/caseSensitive 等）保留在转换层，结构构造下沉工厂；
- **模型工具**（`world-book-tools.ts` world_book_upsert）：模型参数直接经工厂构造——工具后续暴露
  wholeWords 等字段时两通道自动一致。
- **角色卡记忆**（`characters.ts` buildCharacterMemoryEntry）：角色卡导入/记忆同步的 world-book 记忆
  条目同源构造（id 由调用方加 chara-<卡>- 前缀，工厂 id 缺省不写）。

契约测试断言：ST 转换的通用字段与工厂同参数构造一致；ST 特有扫描、分组、概率和时序行为
保存在 `params.stWorldBook`，由选择器处理，原生 world-book 约定不变。位置或角色无法无损映射
时保留来源并通过 `meta.stWarnings` / 物化 warn 报告，不能声称完整 ST 等价。

### 旧参数的确认词投影

兼容适配器把旧锚句与确认词转换为规则局部参数。非空 `firstTurnWord` 优先；否则从锚句提取 `anchorWords`（`the exact sentence: X` 的首词，或文本首词，小写去重）。`anchor-match` 的 prefix 模式按任一确认词前缀匹配，新编辑器直接编辑规则字段。

### 人设与文本资产

人设独立保存在 `module.yml.persona`：`prefix`、`suffix`、`complete`、`includeRuntimeContext`。模块配装通道在该 Agent 的 scope 注册独立命名的前后缀；`complete` 的唯一性与运行上下文抑制仍由官方接口裁决，不覆盖宿主原有的同名段。

`/persona` 与 `/param-overrides` 在写入前拒绝顶层独占与启用配置独占并存；装配准备期再检查多条独占，覆盖手改定义和导入来源。普通官方委派的 per-child persona 归宿主配置，插件模块的行参数不会因此改写它。

`text` 表示单段正文，`texts` 表示一条配置的多段正文，引擎统一为内部文本数组。SillyTavern 导入与角色卡并入沿用各自转换规则，正文不进入部署设置。重物化由 `materializeModule` 读取模块自身定义和内容文件后交给 writer，生成目录仍不是可编辑事实源。

## 9. 子代理工具策略（subagentToolPolicy，2026-09-02）

`subagentToolPolicy` 是 module.yml 顶层领域段（非 params 键），声明子代理实例级工具授权：

| 字段 | 职责 |
|---|---|
| `ceiling.allow` / `ceiling.deny` | 用户授权上限与永久禁用；deny 永远优先，任何 selector / additional_tools 不能恢复 |
| `defaultProfile` | 未命中任何选择器时的工具档 |
| `profiles[]` | 工具档（id/name/allow/deny/modelSelectable）；allow ⊆ ceiling.allow |
| `characterBindings[]` | 角色卡 id → 工具档绑定（模型可选） |
| `taskRules[]` | 有序正则任务规则（order 升序，首个命中生效；modelSelectable） |
| `modelExpansion` | 模型扩权（enabled/allow/maxAdditionalTools/requireApproval） |

### 分流规则

- 策略未启用（段缺失）：子代理工具面按官方委派行为，不写 `toolFilter`；原先「参数桥把 `toolFilterAllow/Deny` 写入主代理 `tool-filter` 并下发子代理 `delegation.toolFilter`」的通道已随该能力一并删除。
- 策略启用（段非空）：子代理由 `subagent-tool-policy` 模块的 agent-local shadow 在创建窗口解析并冻结 toolFilter（不再热更新；需要更高权限时创建新实例）。
- `subagent-tools/policy.yml` 是生成物（writePreset 从 module.yml 顶层段物化）；module.yml 仍是单一来源。
- 保存链路：`/subagent-tool-policy` POST → `validateSubagentToolPolicy()` 校验 → 原子写盘并补齐模块声明；关闭开关只删策略段并保留模块声明，删除能力才同时移除两者。
- writer 读取手写/导入的策略段时同样先校验。历史“有段无模块”的定义保留策略装配，`effectiveModules` 反映有效能力，`declaredModules` 保持磁盘事实。已登记参数和行配置的依赖仍由 `impliedModulesForParams` 派生；移除能力同时清理其参数与行配置。官方组合行出现在物化产物中，不等于插件接管该官方工具的配置。
- `maxDepth` 仅在插件策略启用时约束其委派；普通官方委派深度归宿主。子模型 provider/name 与采样参数另经本地子代理请求规则生效，不改写普通官方 spawn 预检。策略文件确实不存在时回落官方委派；现存文件解析或校验失败必须报错，错误文案不能作为缺文件依据。
- 预览链路：`/subagent-tool-policy-preview` POST 与运行时 `resolveSubagentToolPolicy()` 同一 seam（不重复算法）；预览用 ceiling 工具宇宙。
- 工具面：`/tool-surface` POST 接受互斥的 `{ sessionId }` 或 `{ presetId }`。前者只读当前存活本地 Agent 的 name/description 摘要；后者经官方 `agentPresets.list()` 白名单与 `acquireScope()` 取得当前 revision lease，读取 `tools.schemas(lease.key)` 后在 finally 中释放。两者均不下发完整 Schema、大文本或 secrets；PTC 下预设工具能力不等于模型 wire 直连工具。

### 指令文件与逐文件过滤策略

指令文件（AGENTS.md / CLAUDE.md 等）不属于预设生命周期：正文在用户自己的文件里，显示名
与逐文件开关在独立策略文件里，两者都不写进 `module.yml`。官方负责注入，插件只过滤未来消息。

- **不再物化生成卡**：`writePreset` 不再探测指令文件、不再把 `agents-file-*` 卡写进生成
  目录；`module.yml#agentsHints` 已不是运行时开关（字段仅为兼容既有用户预设保留解析，不再
  生效）。文件集合、正文、版本与读取状态由 `/bootstrap`、`/prompt-configs` 按**本会话工作区**
  现场解析（优先 `agent.session.header.cwd`；无本地会话时回退部署进程 cwd，并以
  `context.source: deploy-cwd` 区分，不把该范围提示当作会话写授权）。
- **探测范围**：用户级 `$DSH_HOME/AGENTS.md` + 工作区 cwd→项目根链（`.git` 为根标记）每个
  目录的 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md`；只接受普通文件，
  候选文件与授权根均先解析真实路径，允许根目录本身是目录链接；越出获准范围（全局限
  DSH_HOME、项目限项目根）的文件不收录也不可写。这是本地文件卡的编辑范围，官方注入
  仍使用自身发现规则与配置。普通预设卡的 `params.file` 不是指令文件身份，不能因此被
  逐文件开关过滤或改走指令文件保存通道。
- **编辑框**：`/bootstrap` 与 `/prompt-configs` 读时把同一份快照（正文 + 文件身份 + 字节
  SHA-256 + 读取状态）附到文件卡；改后经 `/agents-file` 写回真实文件（`fileId` + `contextId`
  必须命中服务端当次探测白名单，`expectedRevision` 做乐观并发，未知 id / 类型错误 400、越界
  403、缺失 404、版本或上下文过期 409、超限 413，tmp + rename 原子写且保留原权限），写盘不
  触发预设重建。
- **独立策略**：`$DSH_HOME/.prompt-tool/instructions.yml`（`src/host/instructions-policy.ts`）
  形状为 `{ files: { [fileId]: { enabled?, name? } } }`；同一 DSH_HOME 下所有预设共享，
  缺省放行，只有文件级 `enabled: false` 过滤后续官方注入。显示名仅改变 UI 标题；没有总
  开关、默认行为段或文件级位置／顺序／晋升／受众／模型范围。旧顶层 `enabled` / `defaults`
  及文件级 `order` / `position` / `promotion` / `audience` / `modelScope` 读取时忽略，下一次
  成功保存时清理；旧顶层关闭不迁移为文件关闭。其他未知字段与注释由 Document API 保留，
  写入继续使用原始字节 SHA-256 乐观并发及严格字段白名单。
  非法 UTF-8、YAML 解析/转换失败均作为不可读状态拒绝写入；未被 alias 引用的 null 文件
  覆盖可被后续局部保存替换为有效覆盖。被引用的 null 锚点须先解除共享引用；局部更新拒写
  且保留原字节，避免连带改变其他字段。策略缺失或不可读时不阻断官方内容，不可读时报告诊断。
- **过滤**：宿主侧 pre-step 协调器（`src/runtime/pre-step-coordinator.ts`）只处理官方待注入
  消息；以 `source.changes` 路径对应本地文件身份及模板段落，删除关闭文件的正文与变更
  元数据。未知身份原样保留；无法可靠分段时原样放行并诊断。官方预算、增量更新与压缩恢复
  不由插件重做，不补回已省略内容，不撤回历史或因重新开启而强制重放。`instructionHint`
  在过滤之后转换剩余官方消息。运行时语义见
  [engine-reuse.md](engine-reuse.md#pre-step-协调器与官方指令过滤)。
- **装配状态**：`instructions.owner.officialInstructions` 把 `true/false/null(未知)` 发给
  工作台，分别表示官方负责、未装配、尚未观察到；不证明某个文件已经注入。预设保留官方
  指令行，未装配时插件不补建文件注入。边界与旧决策替代关系见
  [ADR-0004](adr/0004-official-instruction-filter.md)。

### 模块事实与能力卡（2026-09-05）

- `/bootstrap` 附带 `moduleFacts`：`declaredModules`（缺失为 `null`）、`effectiveModules`、递归 `rowIds`、`sourceMode`、`editable` 及 `subagentToolPolicyEnabled`；不展开默认骨架，保留有效策略兼容装配。官方组合行不伪装成插件拥有的工具配置。
- 能力卡存在性来自显式 `modules`，以及实际仍在运行的历史子代理策略兼容装配；不能由其它 params 或官方组合 `rowIds` 推断。创建能力按磁盘声明检查，允许补齐历史策略的声明；`moduleConfigs` 回显优先级保持 `params > moduleConfigs > 行默认`。
- 每个公开参数各有唯一 UI owner；`maxDepth` 仅在 `subagentToolPolicyEnabled` 为真时作为插件策略深度呈现，普通官方委派仍提示由宿主控制。
- `engineCapability` bridge 只接受服务端白名单能力/recipe；recipe 不作为持久化实体，但展开结果一次写入目标 module.yml，候选组合校验通过后才重建。

### 边界

- provider 不支持 toolFilter / agentOptions / depthLimit 时启动前 fail loud（不做 prompt-only 假过滤）。
- `modelExpansion.requireApproval: true` 且无 approval 通道时 fail closed（拒绝创建）。
- 扩权严格限制在 ceiling.allow ∩ modelExpansion.allow 内，`maxAdditionalTools` 上限数量。
- 模型不能修改 ceiling、profile、角色绑定或任务规则；UI 保存走受控端点。

### 纯模块接口（engine/subagent-tool-policy-core.mjs，单一 seam）

```
validateSubagentToolPolicy(raw)   → string[]（空 = 合法）
compileSubagentToolPolicy(raw)    → Compiled（正则/Set/分类器）
resolveSubagentToolPolicy(c, r)   → { selectedProfileId, toolFilter, ... }
buildSubagentToolParameters(c)     → 模型可见扩展参数 Schema
```

## 10. 契约测试

完整预设导入复用 writer 的 `sourceDir` 与 `materializeOnly` 模式：从隔离来源物化到独立候选目录，最终 ID 与暂存位置分离，不写目标，也不再同步共享引擎（引擎由插件包提供）。安装方先完成工具／配置／附件校验，再版本复检和 rename 交换；普通保存与重建继续复用 writer。预设自有正文及本地 engine 保留，禁止遍历清理兄弟预设。详见 [资产交换](asset-transfer.md)。

- `test/host/write-preset.test.mjs`：模型参数 patch 生成/留空跳过；空值删键（''/[]）；变量文件只读顶层 variables，保留空串与同名键，清空后不回退旧 params。
- `test/host/module-config-order.test.mjs` 与 bridge 契约：尾部追加、身份排序、版本拒绝与正文不变；引擎装配回归验证跨模块交错次序。
