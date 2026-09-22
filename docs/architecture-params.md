# 后端参数框架（架构说明）

> 适用范围：dsh-plugin-prompt-tool 的引擎行为参数（按预设存储、随预设走）全链路。
> 相关代码：`src/shared/engine-params.ts`、`src/shared/param-keys.ts`、`src/host/manifest.ts`、
> `src/host/write-preset.ts`、`src/index.ts`（reloadPresetParams / rebuildPreset）、
> `src/runtime/settings-bridge.ts`（/param-overrides）、`src/client/data/use-prompt-tool-store.ts`（fields / persist）。

## 磁盘格式：按插入点组织共享参数

共享引擎参数唯一存于 `layerSettings.<层名>.<参数键>`，例如 `layerSettings.subagent-start.maxDepth: 2`。归属由 `ENGINE_PARAM_DEFINITIONS.card` → `ENGINE_EDITOR_GROUP_MAP.displayLayer` 派生；该段不创建提示词实例，也不生成空 UI 卡。

`promptConfigs[].params` 仍属于单条规则。persona、variables、customTools、subagentToolPolicy 和 moduleConfigs 保留独立所有者。`loadPresetSpec().params` 是读取新格式后得到的**内部平铺适配面**，本文下文的参数桥 `params` 均指该内部对象，不再表示旧磁盘位置。

共享只限于同一预设内的配置卡。预设主模型的 provider/model 与采样参数通过该预设的 `agent-request` 规则生效；预设加载、保存和能力操作不再调用 `agentDefaultModel.saveSelection` 改写宿主全局默认。模型未配置时继承该会话选择。用户在官方“当前会话模型”控件中的显式选择仍遵循官方接口语义。

显式模块预设存在 `promptConfigs` 或可生成的模型请求规则时，生成组合自动补齐 `prompt-config-engine`；`effectiveModules` 同步反映此依赖，`declaredModules` 保持磁盘声明。模型规则由 `host/prompt-configs.ts#modelRequestConfigs` 同时服务生成和依赖判定，避免“规则文件已生成但无消费者”。没有规则或请求参数的空预设仍为空，手写 composition 不被改写。

正常读写不兼容旧位置中的登记参数：`params.<已登记键>`、`model`/`subagentModel` 已登记字段返回 `preset-migration-required`；未知字段保持原样，且不进入运行参数。`layerSettings` 中登记键放错层、层名或形态错误返回 `preset-layer-settings-invalid`。bridge 对迁移要求返回 409，不静默回落成空值。

一次性离线脚本为 `scripts/migrate-layer-settings.mjs`，不注册日常产品工具或 package script，也不在启动、读取、保存时自动迁移。由已授权的维护操作执行：

```powershell
Set-Location 'D:\AI\workspase\_temp'
$PresetRoot = Join-Path $env:DSH_HOME '.agent-presets'
$PresetFiles = Get-ChildItem -LiteralPath $PresetRoot -Directory |
  Where-Object { -not $_.Name.StartsWith('.') } |
  ForEach-Object { Join-Path $_.FullName 'preset.yml' } |
  Where-Object { Test-Path -LiteralPath $_ }
node D:/AI/GitHub/dsh-plugin-prompt-tool/scripts/migrate-layer-settings.mjs @PresetFiles
node D:/AI/GitHub/dsh-plugin-prompt-tool/scripts/migrate-layer-settings.mjs @PresetFiles --write
```

上例要求 DSH_HOME 已设置；未设置时使用操作系统用户目录下的 `.dsh`。默认只预览；`--write` 才原子替换指定文件。脚本通过 YAML Document 移动节点，保留注释、未知字段、规则参数、false/0；冲突和并发改动拒绝覆盖。备份 `.layer-settings-backup.json` 保存原始字节及前后摘要，被预设导出排除。`--rollback --write` 对同一预设恢复，当前摘要必须仍等于迁移后或迁移前摘要；用户已有新改动时拒绝恢复。空预设保持为空，包内预设和导入产物直接使用新格式。

九层 UI、官方参数与插件参数的对照见 [九层契约](injection-point-contracts.md)。

根目录 [preset.yml](../preset.yml) 是可复制的全参数参考：九层真实模板与 30 个共享登记参数自动生成，所有规则示例默认关闭，共享参数以注释参考提供，避免复制模板即默认启用可选能力。`pnpm rebuild:preset-template` 使用 YAML Document 从权威目录重建，`-- --check` 检查漂移；模板自身的参数值、层归属和规则合法性由行为测试验证。

## 1. 分层与职责

| 层 | 文件 | 职责 |
|---|---|---|
| 契约层 | `shared/engine-params.ts` | `EngineParams` + 完整覆盖其键的 `ENGINE_PARAM_DEFINITIONS`（类型规则、卡片归属、标签、默认草稿、枚举、组合行映射）；`ENGINE_PARAM_KEYS` 与 `WRITER_PARAM_KEYS` 从目录派生 |
| 键集合 | `shared/param-keys.ts` | `PARAM_KEYS` = `ENGINE_PARAM_KEYS` 派生 + 锚定内容键 + `promptConfigs`；参数写入白名单 / mutate 拦截 / 读回遍历共用，不推断模板变量 |
| 存储层 | `host/manifest.ts`、`host/preset-layer-settings.ts` | `loadPresetSpec`（layerSettings → 内部平铺值）、`savePresetParams`（平铺值 → 所属层；空值删键）、`buildModuleConfigsFromParams`（参数桥）、`renderComposition`（参数桥 > moduleConfigs > 行默认） |
| 物化层 | `host/write-preset.ts` | `writePreset`：参数 + 内容资产 → 官方预设目录（agent.cordis.yml / prompt-configs / variables.yml）；`runtimeOf` 透传、`modelRequestConfigs` 模型 patch |
| 装配层 | `index.ts` | `reloadPresetParams`（preset.yml → runtime）、`rebuildPreset`（写入触发） |
| 接线层 | `runtime/settings-bridge.ts` | `/param-overrides` GET（读回）/ POST（保存到激活预设 preset.yml） |
| 消费端 | `client/data/param-overrides.ts`、`prompt-tool-fields.ts`、`dirty-state.ts` | 从共享定义派生 Fields、默认值、读回、序列化及全参数保存快照；store 保留保存队列和宿主适配 |

`buildEngineModuleParams()` 与 `moduleParamFallbacks()` 使用同一字段映射正向装配、反向回显；仅投影白名单参数，不把任意 `moduleConfigs` 或内部路径发送到浏览器。复杂的子代理模型路由／授权关系仍由 `buildModuleConfigsFromParams()` 处理，不伪装成简单字段映射。

`EngineParamFields` 按定义渲染现有能力配置卡；全部公开引擎配置键（受众、晋升信号、开关、文本等）由覆盖测试约束。模型路由、子代理策略、自定义工具保留专用编辑器；不将它们塞进 `promptConfigs`。

## 2. 参数流链路（保存 → 生效）

```
UI fields
  → persistParamOverrides（只发送已存键或用户已改动键；含需清除的 '' / [] 与合法的 false / 0）
    → /param-overrides POST（settings-bridge）
      → savePresetParams（写 preset.yml：layerSettings 的所属层；空值删键）
        → reloadPresetParams（runtime 态）
          → rebuildPreset → writePreset
            → runtimeOf（透传 WRITER_PARAM_KEYS）
            → resolvePresetParams（spec.params + runtime 合并）
            → buildModuleConfigsFromParams（参数桥 → 行级 config）
            → renderComposition（参数桥 > moduleConfigs > 行默认）
              → agent.cordis.yml（宿主挂载生效）
```

本插件的种子化、预设列表、参数与内容读取、保存、物化及导入／导出／复制／删除，
均使用本插件的预设根 `$DSH_HOME/.agent-presets`（`host/paths.ts#DEFAULT_PRESET_DIR`，不可配置）。DSH 0.1.7 起不再自动扫描此目录；插件在物化后向官方 `agentPresets` 注册定义，并随删除、更新和卸载释放注册。已有会话保留其已绑定的 revision。

注册包含仍存在的 `prompt-tool` 历史快照，供旧会话恢复；普通工作台列表继续隐藏该兼容项。注册元数据允许省略名称，排序读取 `preset.yml` 顶层 `order`，不从 `meta.order` 推断。
该目录不只是输出位置，也是预设定义的读取根；不存在对应定义时回退包内模板，
不读取其他部署根中的同名用户副本。

### 注册锚点与本地引用（2026-09-23）

官方 `agentPresets.register()` 用**调用方 Context 的 `baseUrl`** 建立预设的 Loader 树
（`vendor/loader/lib/types/config/tree.js`：相对说明符按 baseUrl 解析，包名说明符走 baseUrl 的
node_modules 链）。因此插件**不得**改写 baseUrl：一旦把锚点换到预设目录，组合内的包名行
（`@deepseek-ai/dsh-*`）就会从预设目录起向上找不到 node_modules，整份预设注册被拒
（表现为 `pt-*` 在预设选择器里全部缺失、默认预设指向不存在的 id）。

锚点归于宿主后，组合内的本地引用由插件在**装配期**统一换算——只改内存里的注册定义，正本
`agent.cordis.yml` 一字不改，因此用户改 `DSH_HOME` 或复制整个预设根后按新位置重新换算：

- **共享引擎行**由生成侧写**包名说明符** `dsh-plugin-prompt-tool/engine/<module>.mjs`：引擎是
  插件包资产，不再物化到 `<预设根>/.engine/`，预设根只承载用户数据。
- **其它本地模块说明符**（`name` 以 `.` 开头）按预设目录换算为绝对 `file://`。
- **受管配置字段**（`configsDir` / `strategyDir` / `policyFile` / `triggersFile`）按历史语义相对
  `<预设根>/.engine/` 解析为绝对 `file://`。引擎由包内加载后其 `import.meta.url` 不再位于该目录，
  而实测只有 `file://` 形态对全部受管字段一致有效（写成 Windows 盘符路径会被 `new URL()` 当成
  URL scheme，报 `is not readable: The URL must be of scheme file`）。
- 需要 `templateFile` 越界校验的引擎行（`prompt-config-engine`、`tool-config-engine`）额外注入
  `presetRoot`；相对 `templateFile` 仍按历史引擎位置解析，用户预设与提示词配置无需改写。

**旧布局不再兼容**：仍写 `./engine/`、`../.engine/` 的预设不再被特殊处理，需重建后重新物化。

该取向与官方一致：`editing-cordis-compositions` 技能要求「Resolve assets from installed
packages rather than a preset directory」，并把 `!!js` 限制在插件配置与 `disabled` 上（行 `name`
不做表达式求值，见 `vendor/loader/lib/types/config/entry.js`）。

### 预设目录与独立补建（2026-09-18）

宿主内置根会遮蔽同名用户预设，因此插件包内目录和 `preset.yml.id` 直接使用
`pt-standard`、`pt-ptc`、`pt-minimal`、`pt-cordis`、`pt-custom`。默认值为 `pt-standard`。
官方原始预设名只在构建脚本读取上游时映射到这些目标，不参与运行时探测、转换或重命名。

- **初始化**：`ensurePresetSeed` 按包内同名目录检查，缺哪个只复制哪个；已有目录的定义、组合与资源保持原样。
  初次复制的定义由现有 writer 物化。删除单个 `pt-*` 目录后，下次启动只补回该目录，无需删除其他预设。
- **保存**：当前预设以自身目录为唯一来源生成，模块、人设、变量、工具和子代理策略都从该目录读取。
  保存当前预设不会为了更新渲染版本而重铺其他预设；全局生成开关恢复时，会恢复先前被该开关清空的组合。
- **新建**：直接复制包内同名目录；显式要求递增副本时仍沿用现有目录后缀规则。
- **默认同步**：启动时若宿主默认不在插件可管理的预设中，则同步到当前有效用户预设；官方模式选择关闭时不写无效默认值。
  宿主后续选择已管理预设仍反向同步，已存在的用户目录不自动改名。

## 3. 空值语义（统一规则）

`savePresetParams` 对空值统一处理（2026-08-25 起）：

| 值 | 处理 | 原因 |
|---|---|---|
| `''`（字符串清空） | **删键** | 回落模板/引擎默认（如 reasoningEffort 留空 = 继承宿主） |
| `[]`（列表清空） | **删键** | 恢复该参数的默认行为 |
| `0`（其余数字） | **写 0，按字段语义消费** | 如 `maxDepth: 0` = 禁止委派 |
| `false`（布尔） | **写 false** | 引擎 `=== true` 归一，false = 显式关闭（与默认等价或明确） |


**保存前全量参数校验（2026-09-01）**：`/param-overrides` 写分支在落盘前调用
`validateEngineParamValues()`（契约层与渲染消费同源）——覆盖全部 `ENGINE_PARAM_KEYS`：
布尔键必须是 boolean；数值键（temperature/maxTokens/字符数）按各自约束（有限数 /
正整数 / 非负整数）；字符串键必须是 string；列表键必须是 string 或
string[]；`maxDepth` 接受 `''`/`provider-managed`/非负安全整数及其数字字符串，
保存校验与普通委派、实例工具策略的参数桥共用归一化规则（`"0"` 与 `0` 同义）。
未知键（旧内容别名等不兼容键）在保存期响亮失败
（`400 overrides-unknown-key` / `400 overrides-invalid-value`），不做运行时自动兼容。
UI 字符串与 preset.yml 手写 number 两通道统一；空字符串仍是合法删键值。
渲染层保持宽容（never-brick），配置错误只在保存期响亮失败。

Bridge 读取器区分空请求体与畸形 JSON；非对象 `overrides`、非数组 `promptConfigs`、
非字符串值的 `variables` 均返回 `400`，不会退化为读取或空操作。所有依赖当前预设的
写端点共用 system 预设只读守卫，只有官方预设根内的当前预设目录可写。

UI 侧 `persistParamOverrides` **条件发送**：

- `load` 时记录 preset.yml 已存在的参数键；
- 已有键即使被改成 `''` / `[]` / `false` / `0` 也发送；保存层只删除空字符串与空列表，合法的 `false` / `0` 照常保留；
- 未改动且 preset.yml 未声明的值不发送；比较基线是最近读回／保存的有效草稿，避免把组合行默认值固化进 params；
- 用户把值改到与已加载基线不同即发送，包括从行级 true 改为 false；
- `guideEnabled` 可恢复继承：发送空字符串删除显式开关；`false` 仍是显式关闭，不当作空值；
- YAML 数值模型参数转换成编辑器字符串，列表完整投影，不再因为草稿类型不同而漏回显。

> 这里的「空值删键」只适用于引擎行为参数，不适用于内容占位变量。`variables` 的空字符串占位键是有意设计，必须继续写入 `variables.yml`，供世界书条目正文以 `{{key}}` 引用：登记发生在 ST 导入期（`src/host/sillytavern.ts:785` 把卡内无源宏登记为空占位）与工作台「模板变量」编辑（`VariablesEditor`，`src/client/features/prompts/PromptConfigFields.tsx:509`），交付时按既有插值替换，空值替换为空串、不留字面量（`engine/executor.mjs:237`、`engine/interpolate.mjs:119`）；占位键不参与引擎参数校验。`world_book_upsert` 只写世界书条目与 note 记忆（`src/runtime/world-book-tools.ts:134-151`），不登记也不调整变量。

### 物化缺省语义：未提供 ≠ 显式空值（2026-09-20）

`writePreset` 的 `runtimeOf` 只投影调用方**真正提供**的引擎参数：

- **未提供（`undefined`）= 不覆盖**：`resolvePresetParams` 跳过 `undefined` 键，缺省值来自
  预设 `preset.yml` 的 `layerSettings` 段。导入
  （`installPresetPackage`）、离线物化、补建其他预设等调用方只给部署字段，不再被 writer
  补上的 `false` / `''` / `true` 覆盖作者定义（锚定被关、自定义文本被清空、关闭的注入器被
  启用、子代理模型路由消失）。
- **显式 `false` / `0` / `''` = 显式语义**：布尔的 `false` 是显式关闭；字符串的 `''` 是
  「不设置该值」（路由与模型参数因此不产生行配置或 patch），不回落到预设定义值。
- 参数桥 `buildEngineModuleParams` 的 `editor-default` 绑定（`strReplaceEditorMaxOutputChars`）
  同样只投影已提供的正值：缺参不再补 16000 覆盖 `moduleConfigs` / 组合行的 `maxOutputChars`；
  非法值不写行配置（渲染层宽容，回落行默认），保存期仍由 `validateEngineParamValues` 响亮拒绝。
- 验收入口：`test/host/write-preset.test.mjs`（未提供 vs 显式值两组对照）、
  `test/host/preset-render-variants.test.mjs` 与 `test/shared/engine-param-schema.test.mjs`（编辑器上限三态）。


## 4. variables 双通道（两套体系，不互串）

1. **引擎行为参数**：`PARAM_KEYS`（派生自 `ENGINE_PARAM_KEYS`）——UI 有编辑入口；`params` 整段不参与预设模板变量的读取与生成。
2. **内容占位变量**：`spec.variables` 段（preset.yml 顶层 variables）→ `variables.yml`——空值占位键也写入：
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

1. `shared/engine-params.ts`：`EngineParams` 加字段，并在 `ENGINE_PARAM_DEFINITIONS` 登记规则、默认草稿、卡片和组合映射；键集、默认值、普通字段渲染、读写和保存快照自动派生。
2. 若需 writePreset 透传：`PresetWriterParams` Pick 加键 + `WRITER_PARAM_KEYS` 加键（断言强制）。
3. 只有跨字段的模型／授权关系才修改 `host/manifest.ts`；普通模块参数不再额外手写双向映射。
4. 存储：参数定义的 card 必须在编辑组目录登记主归属层，存储路径随目录派生；MODEL_SEGMENT_MAP 仅用于一次性旧格式迁移，不能新增运行时双读。
5. UI：现有模块普通字段自动渲染；新增特殊交互才扩展专用编辑器，禁止增加第二份参数清单。
6. 测试：`test/host/engine-params-bridge.test.mjs` 的 BRIDGE_SAMPLES 加样本值（若为参数桥消费键）。
7. `docs/architecture-params.md` 如有语义变更同步；CHANGELOG 记条目。

### 锚定/引导内容键并入共享参数目录（2026-09-20）

`buildPattern`、`complexPattern`、`firstTurnBuild`、`firstTurnInspect`、`firstTurnDeep`、`guideWeak`、
`guideDeep` 七个键此前只在 `shared/param-keys.ts` 的旁路清单里：bridge 白名单放行，
`validateEngineParamValues` 却按未知键拒绝，形成「白名单通过、写盘前报未知键」的断层。现在它们并入
`EngineParams` 与 `ENGINE_PARAM_DEFINITIONS`（`card: 'prompt-defaults'`，默认草稿空串），旁路清单只剩
settings 载荷键 `promptConfigs`；读回、序列化、脏检测、保存快照与中英词条随现有派生链自动生效，页面不再
维护键数组。

前两个键是正则：值类型为新增的 `pattern`，按 `new RegExp(value, 'i')` 在写盘前编译校验——与
`engine/classify-task.mjs` 消费时的编译规则同源，非法正则返回逐字段错误，而不是先存下再让锚定/引导静默
失效。空串仍是删键语义：只移除该键，不动其它内容键。

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

参数、提示词资产、模板变量、自定义工具、子代理策略及能力变更请求携带可选 `expectedPresetId`。服务端只用该 ID 校验当前预设一致性，不据此构造目录；旧草稿或请求体读取期间切换返回 `409 preset-changed`，不写盘。客户端切换先等待参数队列，排队草稿和保存响应均检查预设身份。

`SwitchSnapshot` 的参数键从目录派生，使用结构化克隆隔离数组和对象；全部参数自动参与脏检测。客户端 `Fields` 从 `EngineParams` 派生草稿类型；bridge transport 保留响应 shape guard。

## 自定义模型工具

`customTools` 仍是预设顶层资产，不进入扁平参数。`host/custom-tools.ts` 的 `compileCustomTool()` 使用官方 DSL 转换函数，随后调用与运行时共用的 `engine/tool-definition.mjs` 校验。`validateCustomTools()` 先检查 ID／工具名称冲突，再完整编译每条定义；失败在 bridge 返回 `400 custom-tools-invalid`，不写盘、不重建。

合法保存保留原始 DSL，通过现有 `withPresetDoc`、自动补齐依赖模块、`rebuildPreset()` 和 `writePreset()` 物化；运行时仍由 `ctx.effect` 注册和清理。手写／导入预设中的单条坏定义仍告警跳过，避免破坏恢复路径。自定义工具支持 shell、HTTP、已有工具委托、文件操作和用户询问；本功能不管理外部 MCP 或插件安装。

工具卡同时提供参数行编辑与高级 JSON，修改名称／描述／必填不丢弃嵌套 `properties/items/oneOf/enum`。文件写入／追加显式编辑内容；超时为 `1–2147483647` 毫秒，单工具定义上限 1 MiB，执行器字段在保存前按类型校验。

`customToolRequireApproval` 映射到 `tool-config-engine.requireApproval`，仅允许现有五种执行器名称；内部 `configsDir` 仍由生成器管理，不向配置卡开放。

## 7. 合并优先级（组合行 config）

组合模块目录分工：`engine/compositions/source/local/` 是本项目自有模块的唯一源，
`engine/compositions/library/` 只保存 `pnpm rebuild:composition` 从官方预设切出的行与
确有语义差异的变体；`renderComposition` 跨目录发现同名模块时直接失败，避免源文件与
生成产物漂移。


`renderComposition`：**参数桥（params/UI）> moduleConfigs（模板/ST 行级直写）> 行默认**。
moduleConfigs 仅补充参数桥未覆盖的键（如 ST 导入 tool-web.fetch），不再锁定覆盖 UI 可管理参数（2026-08-25 翻转）。

## 8. 内容策略三功能与参数归属

`engine/instruction-hint.mjs` 是通用内置能力：`strategy: instruction-hint`、
`placeholder + fill: instruction-hint` 与 `params.instructionHint`（原 `context-gate.instructionHint`，
现由 `instruction-hint` 模块行承接）共用同一组
文件探测、提示文本与转换函数；它不属于任何预设专属模块。

`engine/strategies.mjs` 三个内容策略是**独立功能**，仅分类器在 fallback 层共用：

| 策略 | 功能 | 消费参数 | 注入时机 |
|---|---|---|---|
| `first-turn-anchor`（near-anchor） | 锚定：首轮任务分类 → 一次性锚句 | `buildPattern` `complexPattern` `firstTurnBuild/Inspect/Deep` `firstTurnCustom` `firstTurnText` | 首条用户消息后一次 |
| `guide-auto`（router-guide） | 引导：每轮路由强弱引导 | `guideWeak` `guideDeep` `guideCustom` `guideText` + **fallback 复用 `complexPattern`** | 晋升后每轮 |
| `custom-fallback`（prompt-injector） | 兜底注入：锚定词确认后注入 preset.md | `firstTurnWord`（锚定确认词）+ `promptText` | 确认后一次 / 未确认两轮兜底 |

复用点：`guideComplexPattern` 冗余副本已移除——引导的复杂判定 fallback 复用锚定的
`complexPattern`。旧预设 params 残留的 `guideComplexPattern` 不再兼容（已从
PARAM_KEYS 移除），本项目也不提供迁移：请自行从 preset.yml 删除该键。
锚定与引导**不合并**：锚定句（reasoning 开头句，首轮一次性）与引导句（路由引导，每轮）注入位不同。

### 受管配置字段的真实来源（2026-09-21）

`near-anchor` 与 `router-guide` 的预设参数投影只是 writer 合并链的一层，不能仅凭 ID
认定为唯一来源。`mergePromptConfigs` 按同 ID **整条配置替换**：模型参数默认配置 < 模板
配置（含参数投影）< `options.promptConfigs`。最高层覆盖存在时，该条目未声明的字段使用
配置/引擎缺省，不会逐键继承下层投影。此优先级保持不变。

在线 `rebuildPreset` 把原始 `spec.promptConfigs` 作为最高覆盖层；导入候选、离线物化和
补建其他预设传空覆盖数组。因此同一份定义在这些入口可能分别产生 LOCAL 与 GLOBAL，
来源不能按 ID、值相等或下一次重建将采用的分支猜测。

writer 在每条受管生成配置里附 `fieldSources`（`configId` 与固定字段路径的来源枚举
`preset-param` / `prompt-config`），由最终胜出的对象身份生成；不改变配置值、不写入
`preset.yml`。共享 `MANAGED_CONFIG_FIELDS` 只登记投影字段与参数键白名单。
`/bootstrap` 和 `/prompt-configs` 从同一生成配置读取该事实，剔除未知字段、路径和附加
属性后下发。运行时配置归一不消费此元数据，客户端与 bridge 保存端均剥离它。

实例卡按字段事实锁定：预设投影显示当前值与来源参数；显式局部覆盖保留本地输入、模型
范围与启用开关（包括批量启停）。局部文本空串照常保存。普通同策略配置不因策略相同被
锁定；旧产物缺少来源时不宣称全局来源。保存后的重新读取同步来源，同时保留用户草稿。
生成配置经过下一次重建后才具备本版本来源元数据。

| 配置 id | 受管字段 | 来源参数 | 语义 |
|---|---|---|---|
| `near-anchor` | `enabled` / `params.useCustom` / `params.text` / `params.buildPattern` / `params.complexPattern` / `params.firstTurnBuild` / `params.firstTurnInspect` / `params.firstTurnDeep` | `firstTurnAnchor` / `firstTurnCustom` / `firstTurnText` / `buildPattern` / `complexPattern` / `firstTurnBuild` / `firstTurnInspect` / `firstTurnDeep` | 逐字映射 |
| `router-guide` | `enabled` | `guideEnabled` | 显式值优先，缺省跟随 `firstTurnAnchor` |
| `router-guide` | `modelScope` | `guideCustom`（计算结果） | 自定义引导 `all`，自动引导 `flash` |
| `router-guide` | `params.useCustom` | `guideCustom`（计算结果） | 引导启用且自定义开启时为 true |
| `router-guide` | `params.text` / `params.complexPattern` / `params.guideWeak` / `params.guideDeep` | `guideText` / `complexPattern` / `guideWeak` / `guideDeep` | 逐字映射 |

契约与真实物化的一致性由 `test/host/managed-config-fields.test.mjs` 锁定：A/B 来源参数
投影、空 options 与真实 spec 的 GLOBAL/LOCAL 对照、空串与整条替换均有断言。
`test/host/engine-params-bridge.test.mjs` 覆盖表单回调到 bridge、writer 和重读，以及只读、
旧预设身份拒写和元数据不入定义；`test/client/prompt-config-form-layout.test.mjs` 覆盖逐字段
锁定、局部输入及启用/模型范围控件。

### 模块化视图（2026-08-25）

- **任务分类器单一能力**：`engine/classify-task.mjs` 的 `createTaskClassifier({ buildPattern, complexPattern })`
  提供 `ready` / `classify`（complex > build > fix）/ `isComplex`——锚定三档判定与引导复杂判定共用，
  正则构建与判定逻辑不再双处内联。
- **引导开关独立**：`guideEnabled?: boolean`——显式声明优先；`undefined` = 兼容旧行为（跟随
  `firstTurnAnchor`，关锚定 = 关引导）。TUI `/prompt-tool toggle guideEnabled` 可独立控制。
- **自定义文本契约统一**：锚定/引导策略统一读 `config.params.text`（`useCustom + text` 契约形态），
  `firstTurnText` 仅作存储键保留（writePreset 映射 `text: params.firstTurnText`，引擎兼容回退读旧键）。

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

### 锚定确认词归一（2026-08-25）

`firstTurnText`（锚定句）与 `firstTurnWord`（确认词）本质同功能——确认词是锚句的派生属性
（模型按锚句要求以某词开头，确认机制就该匹配该开头）：
- **自动派生**：writePreset 渲染 prompt-injector 时从锚句文本提取信号词集合 `anchorWords`
  （内置格式 `the exact sentence: X` → X 首词；无格式 → 文本首词；小写去重）——deep 档
  （Let…）与自定义锚句不再因固定确认词 we 而确认失败（旧缺陷）；
- **多词确认**：`anchor-match` prefix 模式从「仅首词」改为「任一确认词前缀命中」（any 语义）；
- **显式覆盖**：`firstTurnWord` 非空时优先（旧预设 `we` 行为不变）；空 = 自动派生（模板默认）。

### persona 全量迁移到官方 dsh-persona 行（2026-09-09）

- 单一数据源：`preset.yml` 顶层 `persona` 段，与官方 `@deepseek-ai/dsh-persona`
  行 config 同构（`prefix` 必填；`suffix` 默认 `''`；`complete` 默认 `false`；
  `includeRuntimeContext` 默认 `true`）：

  ```yaml
  persona:
    prefix: You are a coding agent powered by the {{model}} model.
    suffix: Your working directory is {{cwd}}.
    # complete: true               # prefix 独占 system prompt（抑制 suffix 与其余段）
    # includeRuntimeContext: false # 抑制该 scope 的动态 runtime-context 快照
  ```

- 渲染：`renderComposition` 直接从顶层字段生成官方 `@deepseek-ai/dsh-persona` 行，
  不读取模块库、不向 `modules` 补入人设模块，也不继承标准预设文本。`persona` 不是
  可引用的模块名；`composition:` 组合预设不自动插行，需自带 persona 行。
- 运行时不再有 persona 专属分支：`engine/layers.mjs` 把
  `deployment:persona-prefix` / `deployment:persona-suffix` 当普通 system-section
  段名处理，`complete` / `includeRuntimeContext` 由官方行承担；子代理独立人设走
  `moduleConfigs.tool-subagent.persona`（官方 per-child persona shadow，不继承主会话）。
- 互斥：顶层 `persona.complete: true` 与 `promptConfigs` 中 `enabled + params.complete`
  互斥，bridge 写盘前返回 400（`preset-persona-complete-conflict` /
  `overrides-invalid-value`），避免官方「一个 scope 只能有一个 complete 段」装配失败。
- UI：工作台「预设人设」卡（`src/client/features/persona/PresetPersonaCard.tsx`）
  经 bridge 端点 `/persona` 读写顶层 persona 段；提示词配置卡不再有「人设」开关
  （「动态抑制」仍是普通 system-section 参数，保留在段配置卡）。
- SillyTavern：`convertStToPreset` 在含 system-section 时声明
  `persona: { prefix: '', complete: false }`（空 prefix 只做 scope shadow，允许导入段
  生效）；`applyCharacterToPreset` 对含 system-section 的卡自动把顶层
  `persona.complete` 置 `false`（幂等，返回 `personaOpened`）。
- 旧 persona 卡（`persona-main` / 子代理 persona 卡）无兼容层也不迁移：请手工改写为
  顶层 `persona` 段——`deployment:persona-suffix` 卡归 `suffix`，其余
  （`deployment:persona-prefix` / `deployment:persona` / 裸 `persona`）归 `prefix`，
  子代理卡写 `moduleConfigs.tool-subagent.persona`。
- 离线重物化：`pnpm rematerialize:presets`（`scripts/rematerialize-presets.mjs`）
  对每个插件格式预设（preset.yml 含 `modules` / `params`）重跑 `writePreset`：重刷
  `agent.cordis.yml`（带 `# prompt-tool:render vN` 戳）、`prompt-configs/`、`custom-tools/`、
  `subagent-tools/`。共享引擎不再物化（引擎由插件包提供，组合行引用包名说明符），
  预设根下不会产生 `.engine/` 与指纹文件。
  手写/官方格式预设（无 `modules` / `params`，如
  `liangshen`）整体跳过，不覆盖手写组合。参数：`--dsh-home <dir>`、`--dry-run`。
  宿主运行时会锁住预设内 `skills/` 目录（技能监听器持有句柄），
  `writePreset` 整目录改名失败时退回原地合并写（同名项覆盖、多余项删除），
  不再因占用而中止。

### 提示词配置文本字段：单段 `text` / 多段 `texts`（2026-09-09）

- 对外契约（preset.yml `promptConfigs`、UI 编辑、ST 导入、生成产物
  `prompt-configs/*.yml`）以 `text` 单字符串为准，对齐官方
  `PromptSection.text: string | ((context: AssembleContext) => string)`
  （`deepseek-harness/packages/core/system-prompt/src/index.ts`）；单段渲染输出
  `text: |-` block scalar。
- `texts: string[]` 只承载「一条配置多段文本」（pre-step 多 content block、
  `mergeMode=merged` 多块拼接），多段时渲染保留 `texts: [...]`；引擎
  `engine/schema.mjs` 把 `text` + `texts` 归一为内部 `texts[]` 消费，运行时只见
  归一结果。
- 旧 persona 卡的两种形态（`text` 单段 / `texts` 多段）不再由本项目处理：迁移脚本已移除，
  升级前请自行把正文整理进顶层 `persona` 段。

> 以下 2026-08 的「主会话人设参数化」「人设参数桥移除」「子代理 persona 恢复官方
> per-child shadow」「子代理 persona 配置卡替换方案」「角色卡导入的 persona 开放」
> 结论均已被上面的 2026-09-09 全量迁移取代，仅作历史记录。

### 主会话人设参数化（2026-08-25）

- 存储/契约：`ENGINE_PARAM_KEYS` + `WRITER_PARAM_KEYS` 完整透传（runtimeOf / index /
  preset-core / reloadPresetParams / initialRuntime）；
- 渲染：writePreset templateDefaults 对 persona-main 配置覆盖 `text`（非空时）；
  空值 = 模板默认（空值删键语义已有），模块卡仍为底层编辑入口；
- UI：模型路由卡（主对话）人设输入，persist 条件发送 + 读回。

### 人设参数桥移除（2026-08-26）

- `mainPersona` / `subagentPersona` 参数桥与 UI 输入框整体删除，人设一律由
  promptConfigs 配置卡承载：主会话 = persona-main 卡 text（唯一入口，无覆盖层）；
  子代理独立人设 = 新建配置卡（layer=pre-step + audience=subagent，继承主会话
  persona 并追加专属段；无子代理卡 = scope 链继承，行为不变）。
- 子代理 persona 语义变化：per-child shadow 整体替换 → 继承 + 追加。

### 子代理 persona 恢复官方 per-child shadow（2026-08-26，官方源码确认后修正）

- deepseek-harness 官方机制核实：`tool-subagent` 行 `config.persona` = per-child
  persona（子代理 scope 注册 `deployment:persona` 同名段 shadow 全局）；`PromptSection`
  无 audience 概念、同名段重复注册抛错、`AssembleContext` 仅不透明 ScopeKey——
  promptConfigs 配置卡无法做 per-scope persona shadow，上一条"pre-step 配置卡"
  结论作废。
- 修正：`subagentPersona` 参数桥恢复（写 delegation 行 config.persona），UI 在
  子代理模型卡自由编辑；主会话保持 persona-main 配置卡。`mainPersona` 删除有效。

### 子代理 persona 配置卡替换方案（2026-08-26，AssembleContext.agent 发现后定稿）

- 决定性源码发现：`assembleContextFor(agent)` 返回 `{ agent, scope: agent }`——
  `AssembleContext.agent` 运行时存在（官方类型仅声明 scope/signal），systemPrompt
  section 的 text 函数可判定当前装配 agent，`isDelegated(agent.session)` 可区分子代理。
- 定稿：子代理独立人设 = **配置卡**（system-section + `audience=subagent` +
  params.sectionName=deployment:persona），**不独立注册**（同名段冲突规避），作为
  persona-main 段的子代理分支：主会话 = 主 persona 文本；子代理 = 子卡文本（**替换，
  不继承**）；无子代理卡 = 继承（persona 段保持静态）。complete/suppressRuntimeContext
  透传不变。`subagentPersona` 参数桥再次删除（配置卡为唯一入口）。

### 角色卡导入的 persona 开放（2026-08-25）

ST 转换（convertStToPreset）通过顶层 `persona: { prefix: '', complete: false }`
允许 system-section 生效，不追加 persona 模块或依赖标准库人设。
角色卡导入激活预设（applyCharacterToPreset）时，若卡片含 system-section 且目标预设
顶层 `persona.complete: true`，则置为 false 并返回 `personaOpened: true`；已开放时
不重复修改，纯世界书卡不触碰人设。

## 9. 子代理工具策略（subagentToolPolicy，2026-09-02）

`subagentToolPolicy` 是 preset.yml 顶层领域段（非 params 键），声明子代理实例级工具授权：

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
- `subagent-tools/policy.yml` 是生成物（writePreset 从 preset.yml 顶层段物化）；preset.yml 仍是单一来源。
- 保存链路：`/subagent-tool-policy` POST → `validateSubagentToolPolicy()` 校验 → 原子写盘并补齐模块声明；关闭开关只删策略段并保留模块声明，删除能力才同时移除两者。
- writer 直接读取手写/导入的 `subagentToolPolicy` 时同样先校验。历史“有段无模块”预设继续装配策略以保留既有授权；`effectiveModules` 和能力卡如实显示该装配，`declaredModules` 保持磁盘事实。显式创建或保存可补齐声明且不覆盖已有策略，删除能力会连段移除。**参数在 ⇒ 装配在**：预设 `params` 里出现登记参数键、或 `moduleConfigs` 里出现该能力的行键时，装配入口（`loadCompositionText`）与模块事实（`resolvePresetModuleFacts`）用同一份派生 `impliedModulesForParams` 自动补齐对应模块——`effectiveModules` 如实反映、`declaredModules` 仍是磁盘事实，组合源自带默认值不算信号。因此不存在"写了参数却长期不生效"的休眠配置，编辑卡也不会因此消失；相应地"移除能力"必须同时删除该能力的显式参数与行配置，否则会被隐含装配立刻拉回。
- 策略启用后 `subagentModel` 路由、reasoningEffort、maxTokens 与 maxDepth 改写到策略模块，不再只落到被 shadow 的官方工具行。策略文件确实不存在时回落官方委派；现存文件解析或校验失败必须报错，错误文案不能作为缺文件依据。
- 预览链路：`/subagent-tool-policy-preview` POST 与运行时 `resolveSubagentToolPolicy()` 同一 seam（不重复算法）；预览用 ceiling 工具宇宙。
- 工具面：`/tool-surface` POST 接受互斥的 `{ sessionId }` 或 `{ presetId }`。前者只读当前存活本地 Agent 的 name/description 摘要；后者经官方 `agentPresets.list()` 白名单与 `acquireScope()` 取得当前 revision lease，读取 `tools.schemas(lease.key)` 后在 finally 中释放。两者均不下发完整 Schema、大文本或 secrets；PTC 下预设工具能力不等于模型 wire 直连工具。

### 独立指令文件来源与指令策略（2026-09-14）

指令文件（AGENTS.md / CLAUDE.md 等）不属于预设生命周期：正文在用户自己的文件里，行为在
独立策略文件里，两者都不写进 `preset.yml`。

- **不再物化生成卡**：`writePreset` 不再探测指令文件、不再把 `agents-file-*` 卡写进生成
  目录；`preset.yml#agentsHints` 已不是运行时开关（字段仅为兼容既有用户预设保留解析，不再
  生效）。文件集合、正文、版本与读取状态由 `/bootstrap`、`/prompt-configs` 按**本会话工作区**
  现场解析（`agent.session.header.cwd`；无本地会话时只保留 `$DSH_HOME/AGENTS.md`，不拿进程
  cwd 冒充工作区）。
- **探测范围**：用户级 `$DSH_HOME/AGENTS.md` + 工作区 cwd→项目根链（`.git` 为根标记）每个
  目录的 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md`；只接受普通文件，
  候选文件与授权根均先解析真实路径，允许根目录本身是目录链接；越出获准范围（全局限
  DSH_HOME、项目限项目根）的文件不收录也不可写。普通预设卡的 `params.file` 不是独立
  来源身份，不能因此被过滤或改走指令文件保存通道。
- **编辑框**：`/bootstrap` 与 `/prompt-configs` 读时把同一份快照（正文 + 文件身份 + 字节
  SHA-256 + 读取状态）附到文件卡；改后经 `/agents-file` 写回真实文件（`fileId` + `contextId`
  必须命中服务端当次探测白名单，`expectedRevision` 做乐观并发，未知 id / 类型错误 400、越界
  403、缺失 404、版本或上下文过期 409、超限 413，tmp + rename 原子写且保留原权限），写盘不
  触发预设重建。
- **独立策略**：`$DSH_HOME/.prompt-tool/instructions.yml`（`src/host/instructions-policy.ts`）
  承载启停、层内序号、位置、晋升、受众与模型范围；默认 `enabled: false`（安全缺省，需显式
  开启），用 Document API 保留注释与未知字段、原始字节 SHA-256 乐观并发及严格字段白名单。
  非法 UTF-8、YAML 解析/转换失败均作为不可读状态拒绝写入；未被 alias 引用的 null 文件
  覆盖可被后续局部保存替换为有效覆盖。被引用的 null 锚点须先解除共享引用；局部更新拒写
  且保留原字节，避免连带改变其他字段。策略只影响未来的注入，不撤回已进入会话历史的内容。
- **注入**：宿主侧 pre-step 协调器（`src/runtime/pre-step-coordinator.ts`）按会话工作区实时
  探测并编译文件卡，与预设卡共用 `engine/executor.mjs#runPreStepBatch`；文件正文 literal、
  身份含 `(fileId, revision, epoch)`、按可见面判定是否需要重发。运行时语义见
  [engine-reuse.md](engine-reuse.md#pre-step-协调器与独立指令文件来源2026-09-14)。
- **负责人冲突与未知装配**：该 mount 的组合仍挂着官方 `@deepseek-ai/dsh-agent-instructions`
  行时，独立来源不参战（同一正文只由一方注入）；该 Agent 的 scope 里没有任何已注册的 preset
  来源（mount 没有 `prompt-config-engine` 行或引擎未注册）按「未知」处理，同样不注入。
  `instructions.owner.officialInstructions` 把 `true/false/null(未知)` 发给工作台。切换到插件
  负责需要用户先在自己的预设里去掉官方指令行/模块，再显式开启独立策略。

### 模块事实与能力卡（2026-09-05）

- `/bootstrap` 附带 `moduleFacts`：`declaredModules`（缺失为 `null`）、`effectiveModules`（不展开默认骨架，但保留历史策略段的真实兼容装配）、递归 `rowIds`、`sourceMode` 和 `editable`；官方 `agent.cordis.yml` 行只作运行事实，不伪装成可编辑的插件能力。
- 能力卡存在性来自显式 `modules`，以及实际仍在运行的历史子代理策略兼容装配；不能由其它 params 或官方组合 `rowIds` 推断。创建能力按磁盘声明检查，允许补齐历史策略的声明；`moduleConfigs` 回显优先级保持 `params > moduleConfigs > 行默认`。
- 每个引擎参数各有唯一 UI owner；子代理委派卡只编辑 `maxDepth` 与 `subagentToolPolicy`，避免跨页失焦保存互相覆盖。
- `engineCapability` bridge 只接受服务端白名单能力/recipe；recipe 不作为持久化实体，但展开结果一次写入目标 preset.yml，候选组合校验通过后才重建。

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

- `test/host/engine-params-bridge.test.mjs`：PARAM_KEYS 派生一致性；每个 ENGINE_PARAM_KEYS 键有装配消费；MODEL_SEGMENT_MAP 段目标唯一。
- `test/host/write-preset.test.mjs`：模型参数 patch 生成/留空跳过；空值删键（''/[]）；变量文件只读顶层 variables，保留空串与同名键，清空后不回退旧 params。
