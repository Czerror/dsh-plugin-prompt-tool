# 后端参数框架（架构说明）

> 适用范围：模块规则、独立共享参数、版本事务、离线迁移与配置排序。
> 规则契约：`src/shared/rules.ts`、`engine/rule-spec.mjs`、`engine/rule-runtime.mjs`。
> 存储与迁移：`src/host/module-storage.ts`、`src/host/module-rules.ts`、`src/host/rules-migration.ts`。
> 接线与物化：`src/runtime/settings-bridge.ts`、`src/host/write-preset.ts`、`src/runtime/agent-assembly.ts`。

## 部署设置与编辑目标

Config 的规范键是 `modulesEnabled`，表示模块运行总闸。旧 `writePreset` 仅在输入边界兼容；同时提供且值不同时拒绝。关闭只卸载模块贡献，不删除定义、规则切片或用户资产；总闸关闭时仍可调整排序。

编辑选择由请求头 `x-module-id` 声明，不改写 settings，也不切换或跟随官方会话预设。写请求使用 `expectedModuleId` 检查目标一致性；兼容入口归一旧身份键，冲突值拒绝。宿主官方预设的 `presetId` 仍表达其真实身份，例如官方工具预览。

## 磁盘格式：规则与共享参数各有所有者

共享引擎参数唯一存于 `layerSettings.<层名>.<参数键>`，例如 `layerSettings.subagent-start.maxDepth: 2`。归属由 `ENGINE_PARAM_DEFINITIONS.storageLayer` 固定；`card` 与编辑组 `displayLayer` 只管理展示，不改变磁盘路径。该段不创建提示词实例，也不生成空 UI 卡。

`module.yml` 保存完整定义，是唯一持久化提交点和恢复依据，支持直接手工修改完整文件。初始化或发现有效定义变化时，将规则分解为 `rules/<ruleId>.yml`，状态放 `rules/_settings.yml` 的 `rules` 映射，模板变量放 `rules/variables.yml`。`rules/` 是物化目录：读取只认 `_settings.yml` 名单内的切片，名单外文件（编辑器备份、Explorer 副本、同步冲突等）归用户，引擎不读、不校验、不写、不删。UI 和运行时使用校验通过的切片快照；名单内切片不接受直接手改，缺失、失配或摘要失配均从完整定义单向重切。完整定义无效则报错，不以切片反向修复。

每条规则正文只有 `id/name/layer/if/then[]`；`enabled/group/exclusive/order` 由状态清单拥有，模块级 `variablesEnabled` 与校验元数据也在清单中。完整定义仍包含合并后的规则与 `configOrder`。传给引擎时 `order` 拆为独立映射，不向规则对象添加未知字段。规则 id 使用可读名字和后缀去重，拒绝下划线前缀、保留名 `variables`、大小写冲突及 Windows 设备名。

`if` 组合条件，`then[]` 声明有稳定 id 的动作；注入正文、策略、模板和局部变量属于 `inject-text.config`。`layer` 只标记展示归属，不建立跨插入点的全局运行顺序。

共享只限于同一模块内的配置卡。`persona`、`variables`、`customTools`、`subagentToolPolicy` 和能力行的 `moduleConfigs` 保留独立所有者。`loadModuleSpec().params` 是 `layerSettings` 的内部平铺适配面，不是第二个磁盘参数源，也不承载规则正文。

模型路由与采样参数写入 `request-params` 动作；主会话、子代理和模型范围统一由规则级 `if.scope` 约束，不再在动作中另放动态门。模型未配置时继承宿主会话，不调用 `agentDefaultModel.saveSelection` 改写全局默认。十个旧 `model*` / `subagentModel*` 键由 `RULE_OWNED_MODEL_PARAMS` 标记为迁移输入，不再从 `layerSettings` 隐式生成请求规则。

插件管理路径直接使用 `compileRules → mountRuleSources`，工具和策略走内联输入。模块不再生成 `rules.yml`、`configs/`、`agent.cordis.yml`、`custom-tools/` 或 `subagent-tools/`；普通重建只恢复切片并清理已知旧产物，不交换整个用户目录。空模块不自动增加规则。

运行时、正常保存与物化拒绝 `promptConfigs`、`triggers`、旧规则引擎声明、旧快捷参数及旧模型键，返回迁移诊断，不双读、不自动改盘。其他未知字段及不参与执行的旧内容元数据保留。已登记共享键放错层、层名或形态错误仍返回 `module-layer-settings-invalid`。旧格式只经本文的显式离线迁移入口转换。

九层 UI、官方参数与插件参数的对照见 [九层契约](injection-point-contracts.md)。

根目录 [module.yml](../module.yml) 是可复制的参考：九层规则示例默认关闭，只列四个公开共享参数。`pnpm --dir $Repo rebuild:preset-template` 使用 YAML Document 从权威目录重建，追加 `-- --check` 检查漂移；`$Repo` 为仓库绝对路径。

| 公开参数组 | 字段 | 实际作用面 |
|---|---|---|
| 策略深度 | `maxDepth` | 已启用的插件子代理工具策略；普通官方委派由宿主管理 |
| 指令提示 | `instructionHint` | 官方指令消息过滤后的可选转换 |
| 工具 | `toolGitBashEnabled`、`customToolRequireApproval` | 插件 Git Bash 开关与自定义执行器批准要求 |

旧快捷键与模型键的类型目录仅服务旧数据校验、显式导入转换和离线迁移；目录中仍能识别一个键，不代表新模块允许写入该键。新 `/param-overrides` 拒绝规则、模型和旧快捷参数载荷，规则只走 `/rules`。`strReplaceEditorMaxOutputChars` 已退出插件参数面，编辑器输出限制归宿主工具所有。

## 1. 分层与职责

| 层 | 文件 | 职责 |
|---|---|---|
| 规则契约 | `shared/rules.ts`、`engine/rule-spec.mjs` | 规则、动作、条件树、身份及互斥校验；宿主与客户端不各写一套语义 |
| 共享参数 | `shared/engine-params.ts` | 四个公开共享键的校验、storageLayer、UI 归属与能力行映射；旧类型只供迁移识别 |
| 离线转换 | `host/rules-migration.ts`、`host/legacy-prompt-params.ts` | 明确转换旧来源；无法无损转换时拒绝，不作为运行时适配器 |
| 规则事务 | `host/module-rules.ts` | 按操作校验正文／状态版本、局部 edits、显式启用互斥、改名与删除同步 configOrder |
| 参数守卫 | `shared/param-keys.ts`、`shared/rules.ts`、bridge | 先拒绝已归规则的旧键，再校验共享参数；不靠键名推断模板变量 |
| 存储层 | `host/manifest.ts`、`host/module-layer-settings.ts` | `loadModuleSpec`（layerSettings → 内部平铺值）、`saveModuleParams`（平铺值 → 所属层；空值删键）、`buildModuleConfigsFromParams`（参数桥）、`renderComposition`（参数桥 > moduleConfigs > 行默认） |
| 切片与候选 | `host/module-storage.ts`、`host/write-preset.ts` | `ensureModuleSlices` 校验恢复；`commitModuleDefinition` 提交完整定义；`writeModule` 为导入建立隔离候选，普通重建原地保留资产 |
| 排序层 | `host/module-config-order.ts` | 读配置身份和版本、启用时尾部追加、按身份重排并写回各模块 `configOrder` |
| 装配层 | `index.ts`、`runtime/agent-assembly.ts` | 运行总闸、按启用集合挂载贡献、按配置序号排序与释放 |
| 接线层 | `runtime/settings-bridge.ts` | `/rules` 规则事务、`/param-overrides` 共享参数与独立变量、`/module-config-order` 身份顺序 |
| 消费端 | `client/data/param-overrides.ts`、`prompt-tool-fields.ts`、`dirty-state.ts` | 从共享定义派生 Fields、默认值、读回、序列化及全参数保存快照；store 保留保存队列和宿主适配 |

`buildEngineModuleParams()` 与 `moduleParamFallbacks()` 使用同一字段映射正向装配、反向回显；仅投影可公开参数，不把任意 `moduleConfigs` 或内部路径发送到浏览器。模型行为归规则动作；子代理授权仍归独立策略，不因 UI 归组改变所有者。

`EngineParamFields` 只渲染仍属共享能力的字段。模型路由通过规则编辑，子代理策略与自定义工具保留专用编辑器；条件、动作和内容直接归当前规则卡。

## 2. 参数流链路（保存 → 生效）

```
UI fields
  → persistParamOverrides（只发送已存键或用户已改动键；含需清除的 '' / [] 与合法的 false / 0）
    → /param-overrides POST（settings-bridge）
      → saveModuleParams（写 module.yml：layerSettings 的所属层；空值删键）
        → commitModuleDefinition（完整定义原子提交并校验发布切片）
          → materializeModule → assembly.refresh（刷新受影响 Agent 的贡献）
```

规则卡另走同一模块保存队列中的局部事务：

```
当前规则草稿快照 + expectedRevisions
  → /rules（edits / activateRuleId）
    → editModuleRules（全量候选 compileRules → 按操作 CAS → 完整定义提交）
      → materializeModule → assembly.refresh
        → 重读规则并复核版本，再确认请求快照
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

本地引用在装配期按实际模块目录换算，复制模块或改变 `DSH_HOME` 后使用新位置：

- **共享引擎**直接从插件包加载，模块目录只承载用户定义和资产。
- **受管配置字段**（`configsDir` / `strategyDir` / `policyFile` / `rulesFile`）按历史语义相对
  `<预设根>/.engine/` 解析为绝对 `file://`。引擎由包内加载后其 `import.meta.url` 不再位于该目录，
  而实测只有 `file://` 形态对全部受管字段一致有效（写成 Windows 盘符路径会被 `new URL()` 当成
  URL scheme，报 `is not readable: The URL must be of scheme file`）。
- 规则注入动作的 `templateFile` 与策略基准由 `rulePromptConfigOptions` 明确提供：以本模块
  `module.yml` 为相对基准、以本模块目录为允许根。离线迁移负责把已知旧基准改成等价相对路径，
  无法证明来源或越界时拒绝；运行时不猜旧路径，也不读取兄弟模块的资产。
- `tool-config-engine` 的 `resourceRoot` 仍是模块集合允许根，旧 `presetRoot` 只作输入别名；冲突拒绝，路径权限不因更名改变。独立引擎的文件入口继续可用，不要求插件生成对应文件。

规则的模板基准使用 `templateModuleRoot`，独立规则入口使用 `moduleRoot`；旧参数名仅在兼容边界归一。

该取向与官方一致：`editing-cordis-compositions` 技能要求「Resolve assets from installed
packages rather than a preset directory」，并把 `!!js` 限制在插件配置与 `disabled` 上（行 `name`
不做表达式求值，见 `vendor/loader/lib/types/config/entry.js`）。

### 模块目录与独立补建

包内 `modules/` 是复制与补建来源，不注册到官方预设目录，不探测或重命名用户已有模块。

- **初始化**：`ensurePresetSeed` 按包内同名目录检查，缺哪个只复制哪个；已有目录的定义、组合与资源保持原样。
  初次复制后由统一入口分解 rules/，不覆盖其他模块。
- **保存**：当前预设以自身目录为唯一来源生成，模块、人设、变量、工具和子代理策略都从该目录读取。
  保存只重建目标模块；关闭运行总闸不清空组合、正文或配置切片。
- **新建**：直接复制包内同名目录；显式要求递增副本时仍沿用现有目录后缀规则。
- **不与官方预设联动**：模块不进入官方注册表；工作台的编辑选择不保存为部署默认值，不切换或跟随官方会话预设。官方预设继续拥有原有工具与委派创建配置。

### 操作目标与生效结果

工作台编辑目标、宿主默认预设和执行 Agent 的运行时配装是三种身份。角色卡和世界书模型工具**不查询官方预设绑定**：装配期把「这个 Agent 装了哪几层提示词」记进运行时配装记录（启用表 ∩ 磁盘，顺序即启用表顺序），工具执行时按 `ToolExecution.agent.id` 取该记录的第一层作为写入目标，再用**存储根目录事实**判定落点（模块目录含 `module.yml` 的即本插件管理的模块，`moduleDirExists`），最后经 `assertModuleDirectory` 校验存在性、链接与身份。未配装、目录已消失和身份不匹配一律拒绝。写入目标只来自宿主 `agent/created` 建立的装配记录，**不取自工具参数或模型输出**；主会话与子代理各按自己的配装记录解析，工作台切换到另一模块不改变工具写入目标。

保存按实际模块 ID 读取其自身定义并完成物化，再更新当前运行时贡献。启用表改变时，
刷新官方 `agents.list()` 中全部存活 Agent，包括此前没有启用模块的 Agent；配置保存则
刷新受影响的运行实例。bridge、TUI 和模型工具等待刷新完成后才报告成功。定义已保存
而切片或运行发布失败时，共享参数端点返回 `module-activation-failed`；规则与变量端点明确返回
`persisted` 和 `publicationError`，客户端只确认已提交快照，保留在途输入。重试只刷新运行贡献，
不重放新增、改名或删除。准备失败不撤旧贡献，挂载失败尝试恢复旧贡献。

### 官方运行时接线

`runtime/agent-assembly.ts` 只从模块定义编译 rules，并装配独立能力资产，不向官方预设注册表发布模块，
也不持久化模块与会话的绑定。启用表是所有主会话与子代理的共同装配来源；Agent 身份
仅用于官方 scope 的注册、串行更新和释放，不决定加载哪一套配置。

- 官方 `agent/created` 是串行初始化边界：返回装配 Promise，首条请求等待完成；首次
  失败只报告诊断，不中止宿主创建会话。恢复、清空和压缩后的新 Agent 同样走此边界。
- 规则统一经 `compileRules → mountRuleSources`。条件编译一次，在同一执行点的同一调用帧
  判断一次，再按动作相对顺序执行；不同执行点由宿主生命周期驱动。`inject-text` 复用文本
  编译、注册及 pre-step 批处理原语，不独立重复挂载整套执行器。
- pre-step 注入与本地点控制动作共用协调器的 `configs + ruleActions`，保留官方指令过滤、
  变量帧、合并与投递去重；条件读取下游判定，过滤器需要的原始已领取消息另从 `payload` 保留。
- 模块人设通过 `systemPrompt.section()` 注册独立命名的前缀与后缀；`complete`
  由官方组装器执行，`includeRuntimeContext: false` 调用官方
  `suppressRuntimeContext()`。不覆盖宿主或子代理创建期注册的同名段。
- 内置工具复用 `pt-*` 服务适配器，自定义工具复用现有引擎并调用官方工具注册表；
  不再挂载第二条 `declared-triggers` 规则通道。路径在装配期换算到实际模块资产，
  不依赖宿主 Loader 的预设目录或包解析锚点。
- 注册都由运行时 fiber 拥有；关闭、重装、Agent 释放或插件卸载时撤回贡献。
  子代理策略工具同时受模块和 Agent 生命周期约束，注册通知不能重入重复安装。

关闭只影响后续注入及工具可见面，不删除已经进入会话历史的消息。更新插件代码后
需要用户重启 DSH 服务以加载新版；加载后模块开关和配置保存走上述运行时更新链。

### 配置序号与跨模块排序

`module.yml.configOrder` 保存 `{ 规则ID: 非负安全整数 }`，完整身份仍是模块 ID＋规则 ID，正文留在原动作。导入保留来源局部顺序；启用时，未编号规则按步长 10 接在尾部；若已有序号与其他启用模块碰号，按已保存的相对顺序将该模块整体接到尾部。重复启用不改无冲突顺序。动作的显式 `channelOrder` 独立声明通道内顺序，未指定时使用规则序号；排序不替互斥组选赢家。

规则文件名固定为 `<ruleId>.yml`，顺序由 `_settings.yml.rules[ruleId].order` 承载并回写完整定义 `configOrder`。排序写入不接受任意序号、正文或路径。

全局排序读取已启用配置的身份列表、受众、策略与 `revision`；`/module-config-order` 的空请求体或空对象 `{}` 均表示全局读取，仅带 `moduleId` 时读取指定模块，读取不写定义或触发物化。写入提交完整身份列表和读取时的版本。服务端拒绝未知／重复身份及过期集合，按身份写回各模块，等待受影响模块物化与刷新后才返回成功。主会话与子代理统一展示启用模块的可编辑规则卡，按受众和策略过滤，在同一插入点、位置和官方档位内跨模块移动；提交包含隐藏条目的完整身份列表，不发送摘要元数据或正文，成功后刷新各模块规则版本。指定模块的排序 API 仍支持停用模块，但页面不另设范围切换。

`config.yml.enabled` 只决定参与装配的成员，不决定配置次序；模型工具仍沿用启用表首项的写入目标语义。官方 system/context 的 `order`、显式注册名的同序比较、无模块来源的引擎与触发器，以及 ST 世界书预算的顺序语义见[九层契约](injection-point-contracts.md#order-的作用面与刻度来源)。决策依据见 [ADR-0006](adr/0006-module-config-order.md)。

## 规则事务与互斥

`/rules` 返回规则及 `revisions: { rules: { [ruleId]: hash }, settings: hash, variables: hash }`，`meta` 来自同一动作／条件目录。纯源读取只读；UI／运行入口的协调读取可从有效完整定义恢复切片。只读包目录仅作内存投影。无效完整定义明确报错，不静默删成空规则。

修改携带 `expectedModuleId`、`expectedRevisions` 与 `edits: [{ previousId, rule, settingsChanged? }]` 或 `activateRuleId`。正文编辑校验目标正文版本且保留最新启停／互斥状态；状态编辑须显式标记 `settingsChanged` 并校验 settings。新增、删除、改名和互斥启用也校验 settings。变量内容校验 variables，变量开关校验 settings。新增用 `previousId: null`，删除用 `rule: null`；改名、删除同步 configOrder。旧整文档 revision 只供已有 API 调用兼容。

`validateOnly: true` 编译完整候选但不写盘。保存先校验候选规则、动作、互斥及独占约束，再使用 YAML Document 保留其他字段与注释，写临时文件并在替换前复核版本及目录身份。只有当前允许写入且具有可编辑 `modules` 清单的模块可保存。版本冲突返回 `409 rules-conflict`，不覆盖本地或磁盘未知修改。

同模块完全同名的非空 `group` 中，只要任一成员 `exclusive: true`，该组便互斥。显式 `activateRuleId` 先启用目标卡，再原子写入同组其他卡的 `enabled: false`；不会保留多个亮起开关再由排序决定生效项。没有显式激活目标时，多启用候选由编译器拒绝，运行时和离线迁移均不默选赢家。

同模块保存与恢复串行，先校验完整候选，再写正文／变量切片、原子替换 module.yml、更新清单并校验发布。完整定义替换是提交点，不宣称多文件同时原子替换。提交前失败从旧完整定义恢复；提交后发布持续失败响应带 `persisted: true` 和版本信息，明确告知定义已保存，保留最后已验证的运行贡献。手改完整定义使旧草稿 CAS 冲突；切片手改或伪造摘要只会触发单向重切。客户端保留未确认草稿。

### 旧格式的唯一离线入口

发布命令 `prompt-tool-migrate-rules`（入口 `src/migrate-rules.ts`，发布产物 `lib/migrate-rules.mjs`）只接受显式绝对路径：模块根用 `--root`，原生角色库用 `--characters-root`，可分别或同时指定。源码开发也可使用 `pnpm --dir $Repo migrate:rules`。先 `--check`，确认后 `--apply`；`--rollback` 使用同根备份，仍按内容版本拒绝覆盖迁移后的用户修改。命令不推断真实 DSH_HOME。

迁移先全量预检，再完整生成临时候选、复核源文件与资产树指纹、备份并以目录 rename 交换。保留未知字段、注释、规则身份、序号、正文与角色库原图／JSON／本地记忆。旧 `promptConfigs`、`triggers`、已承接快捷键和模型键只在此阶段归一到 `rules`；确认后的角色记忆证明同步更新，原证明已失配时保持未认领。

无法无损转换的来源明确拒绝，包括互斥组多启用、定义与旧实际物化内容不一致、来源身份冲突、未承接旧参数、不可证明顺序的混合声明、手写组合，以及需要先展开的动态填充器外部模板。原模块不会因预检失败被清空。旧 `/triggers`、旧整表规则及模型参数写入端点返回 `410 rules-route-retired`，不充当在线迁移器。

## 3. 空值语义（统一规则）

四个共享参数通过 `saveModuleParams` 保存；它们的删键语义与规则动作正文的空值语义分开：

| 值 | 处理 | 原因 |
|---|---|---|
| `''`（字符串清空） | **共享参数删键** | 不设置本插件覆盖，按该能力明确的缺省契约处理 |
| `[]`（列表清空） | **共享参数删键** | 不保留空的列表覆盖；不据此生成业务内容 |
| `0`（其余数字） | **写 0，按字段语义消费** | 如策略启用时 `maxDepth: 0` 禁止该策略委派 |
| `false`（布尔） | **写 false** | 引擎 `=== true` 归一，false = 显式关闭（与默认等价或明确） |


`/param-overrides` 先拒绝已退役的规则和模型载荷，再对可写共享字段调用
`validateEngineParamValues()`。布尔键必须是 boolean，列表必须是 string 或
string[]；`maxDepth` 接受 `''`/`provider-managed`/非负安全整数及其数字字符串，
保存校验与插件实例工具策略共用归一化规则（`"0"` 与 `0` 同义），不改写普通官方委派。
其他未知键在保存期返回
`400 overrides-unknown-key` 或 `400 overrides-invalid-value`。
UI 字符串与 module.yml 手写 number 两通道统一；空字符串仍是合法删键值。
规则动作的字段类型、条件正则及合法执行点由 `compileRules` 在保存与装配边界共同校验。

Bridge 读取器区分空请求体与畸形 JSON；非对象 `overrides`、非法规则 edits、
非字符串值的 `variables` 均返回 `400`，不会退化为读取或空操作。所有依赖当前预设的
写端点共用 system 预设只读守卫，只有插件预设存储根内的当前预设目录可写。

UI 侧 `persistParamOverrides` **条件发送**：

- `load` 时记录 module.yml 已存在的参数键；
- 已有键即使被改成 `''` / `[]` / `false` / `0` 也发送；保存层只删除空字符串与空列表，合法的 `false` / `0` 照常保留；
- 未改动且 module.yml 未声明的值不发送；比较基线是最近读回／保存的有效草稿，避免把组合行默认值固化进 params；
- 用户把值改到与已加载基线不同即发送，包括从行级 true 改为 false；
- YAML 数值与列表按各字段的草稿类型回显；模型字段在动作编辑器读写，不回流共享参数。

> 「空值删键」只适用于共享能力参数，不适用于内容占位变量或规则业务正文。`variables` 的具名空字符串是有意占位：ST 导入与模板变量编辑保存该值，`engine/interpolate.mjs` 将引用替换为空串。它不参与能力参数校验。`world_book_upsert` 只修改世界书规则与明确的 note 记忆，不登记或调整模块变量。

### 业务参数默认空，不由引擎补写

`writeModule` 读取已经持久化的 rules，不再接受旧业务开关或整表覆盖来重解释规则。未提交的共享值不覆盖作者定义，显式规则编辑只改变对应字段；清空正文、目录字段或业务模式，不触发隐藏文案、长度阈值或模型偏好。

- `inject-text` 的正文、环境事实模板、技能目录模板、目录字段与可选数量限制由动作或模块模板声明；缺少正文时不生成消息。
- `guide-auto` 只有显式 `params.complexMinChars` 才启用长度判据，空值不启用；没有内置 120 字业务阈值。
- `instruction-hint` 的项目／全局提示与官方消息转换文案分别由 `projectTemplate/globalTemplate/suffixTemplate/messageTemplate` 提供。缺少或渲染为空的消息模板必须保留原官方正文，即使已经发过 hint 也不能静默丢弃。`params.file` 的实时文件读取仍保留协议来源头，不变成探测提示。
- 相位门控只在显式开启 `promoteGate` 时使用调用方提供的 `reasoningPattern/reasoningNegativePattern/reasoningFlags`；缺模式不内建 we／let me 匹配。
- 模型范围缺省没有 Pro 偏好，空请求 patch 不覆盖宿主。旧行为需要的 Pro 范围、120 阈值和非空提示只在显式旧格式转换时写成数据。

旧默认的精确数据快照位于 `templates/policies/legacy-defaults.yml`，仅供模板生成与显式离线迁移读取，运行时不得读取。迁移只补缺失字段，保留既有显式值与空值；不能因为一条动作的旧条件而改变同卡其他动作的范围。无法证明等价时报告预检失败。


## 4. variables 双通道（两套体系，不互串）

1. **共享能力参数**：可写键与其存储层由参数目录及规则所有权守卫确定；旧键只在离线输入侧识别，`params` 整段不参与模块模板变量的读取与生成。
2. **内容占位变量**：完整定义顶层 `variables` ↔ 经校验的 `rules/variables.yml`；UI 保存通过完整定义事务回写，空值占位键也保留：
   - 引擎插值（`engine/interpolate.mjs`）`hasOwnProperty` 命中 → 替换（空串不留字面）；
   - 模块级停用插值（`variablesEnabled: false`）时，声明键的引用在编译期按**同一插值语法**
     剥离：`{{键}}`、`{{ 键 }}`、`{{键::参数}}` 都清空，未声明键与内置引用（`{{DSH_HOME}}` 等）
     原样保留（`engine/rule-spec.mjs` 经 `engine/interpolate.mjs#stripDeclaredRefs`）；
   - 用途：模型经 `world_book_upsert` 写世界书条目，内容引用 `{{key}}` 占位；ST 未定义宏登记；
   - UI 模板变量卡（VariablesEditor）可编辑默认值覆盖。

新增参数时必须明确归属：引擎行为参数 → `ENGINE_PARAM_KEYS`（自动进 PARAM_KEYS 参数集合）；内容占位 → `spec.variables` 段。二者不互串。

`variables` 与 `params` 是独立命名空间，允许同名键。保存或清空模板变量只更新
`variables` 段，不删除或覆盖 `params` 中的同名参数（包括显式 `false` 与 `0`）。

预设级变量的唯一来源是顶层 `variables`。`params` 中的旧内容键和嵌套
`params.variables` 不再作为变量读取、回显或生成，也不会自动迁移或删除；旧预设
需自行把所需内容变量改到顶层 `variables` 后重新物化。清空顶层变量后，旧键不再复活。
单条注入动作的 `rules[].then[].config.variables` 是局部覆盖，优先于同名模块级变量。编译与物化共用 `injectionConfigSpec` 合并及空值处理，生成叶子的展开不成为可编辑的第二来源。

内容变量进入官方插值两层（`system-section` / `runtime-context`）时按每次 assembly 求值：
被引用且已声明的名字注册为官方 `systemPrompt.variable()`，取值优先级＝会话变量覆盖 >
声明值 > 运行时事实（`lastusermessage`/`time` 等）。非法官方名（中文/大写/连字符）改写为
`sv_<slug>_<hash>` 别名并同步改写引用；未声明的引用在出口剥离（`warnOnce` 记录样本）。
同名但不同配置默认值分别绑定，运行时事实大小写变体只注册一次；变量值有界展开后也经过出口清洗。
`random`/`roll`/`chance` 内联求值，动态文本每次 assembly 重算；`pick` 的 seed 只含会话、
来源与该次插值正文里的出现序号（不含整段正文）——同一引用不随无关正文长度漂移，静态层按
位点仍确定。
ST 导入配置显式带 `params.stMacros: true`，赋值模板保留到运行期；变量帧只服务宏求值，不建立
跨插入点的全局注入顺序。local/global 分表但均不跨会话持久化，详见 [SillyTavern.md](SillyTavern.md)。

会话变量（`session_var` 工具）不得占用插值保留名：内建变量
（`DSH_HOME`/`WORKSPACE`/`CWD`，大小写敏感）与动态宏名（`time`/`pick` 等，大小写不敏感）。
判据只有一份——`engine/interpolate.mjs` 的 `isReservedInterpolationName`，从内建表与宏表
派生。命中的写入被拒并在工具结果里给出可读原因（不静默改名）；`sessionVarsSnapshot` 与
`getSessionVar` 同样跳过保留名，历史脏键自动失效。ST 变量宏（`setvar`/`addvar`/`getvar`/
`incvar`/`decvar` 及其 global 形式）写 local/global 时走同一判据：命中不写入 + 告警，表达式
求值为空，`{{CWD}}`/`{{time}}` 仍由内建与宏解析。

未填写变量名的空键行属于客户端草稿：保存载荷不携带空键，但保存成功不清理本地编辑行，同一预设的后台刷新也不覆盖该草稿。变量值为空字符串与变量名为空不是同一语义；具名空值仍正常持久化。

## 5. 新增字段的所有权检查

1. 先确定字段归规则条件、动作载荷、共享能力还是独立资产。模型、匹配与正文不能重新放回共享参数目录。
2. 规则字段在动作／条件目录和 `compileRules` 登记校验与执行点；客户端消费同一元数据，不新增旁路执行器。业务值留空不执行，只有作者模板可以显式提供默认内容。
3. 确属共享能力时，在 `ENGINE_PARAM_DEFINITIONS` 登记校验、`storageLayer`、UI 归属和能力行映射；`storageLayer` 不随展示位置移动。
4. 人设、模板变量、工具和子代理授权继续通过自身所有者读写。普通字段不增加重复参数清单或独立保存状态。
5. 新行为补公共接口的确定性回归；涉及存储时覆盖版本拒绝及原文保持，并同步本说明。

### 旧规则快捷参数的迁移边界

`shared/legacy-prompt-params.ts` 与 `host/legacy-prompt-params.ts` 仅供离线／外部导入转换识别旧数据，不参与正常加载、物化或旧 API 保存。迁移前旧来源被拒绝，迁移后不会再由快捷键覆盖规则。新功能不得追加第二条规则参数通道。

### 九层编辑归属契约（2026-09-20）

`engine/schema.mjs` 的 `LAYER_ORDER` 是九层顺序的唯一权威，`getEngineMeta()` 同源下发 `layerOrder`；
`src/shared/engine-capabilities.ts` 用 `EngineLayer` 表达同一组层，`ENGINE_EDITOR_GROUP_MAP` 把能力组
（id = 能力 id，通道即 `displayLayer`）与少量专用编辑组（`prompt-defaults` / `persona` / `variables` /
`main-model` / `subagent-model` / `custom-tools`）的主归属登记在一处，`relatedLayers` 只登记确有第二通道的
组。`/meta` 与 `/bootstrap` 只下发 `id` / `displayLayer` / `relatedLayers` / `hook` 白名单字段，不含路径、
行级配置或函数；前端对旧宿主缺字段退化到共享的 `ENGINE_LAYER_ORDER`。展示归属不改变运行时消费：hook、
注册顺序、作用域与 disposer 仍由引擎行自身决定。

## 6. 保存状态机（防保存期间编辑丢失）

共享参数与规则事务不直接把“当前 fields”当作保存结果：

1. 参数、规则与能力创建/组合创建/移除进入同一个模块保存队列，写入与读回在队列内完成；切换等待已入队操作，失败任务不阻断后续任务；
2. 入队时生成请求快照，载荷与成功后的已保存基线都来自该快照；
3. 请求成功后只确认该快照；若用户在请求期间继续编辑，当前 fields 与快照不等，仍保持 dirty；
4. 只有全局草稿版本未变化、其他保存通道无待存草稿，且对应草稿与请求快照一致时，才在队列内执行静默 `load()`；
5. 下拉展示及动作示例不固化业务默认；未显式填写的模型、正文或条件不额外写入覆盖。

规则请求必须携带 `expectedModuleId`；其他资产沿用自身端点的身份字段。目录由同一请求头解析，该字段只校验已解析目标；旧草稿或等待期间目标改变返回 `409 module-changed`，不写盘。客户端切换先处理未保存草稿并等待保存队列，再更新编辑目标请求头并重读，不修改部署设置或官方会话预设。

`SwitchSnapshot` 的参数键从目录派生，使用结构化克隆隔离数组和对象；全部参数自动参与脏检测。客户端 `Fields` 从 `EngineParams` 派生草稿类型；bridge transport 保留响应 shape guard。

## 自定义模型工具

`customTools` 仍是预设顶层资产，不进入扁平参数。`host/custom-tools.ts` 的 `compileCustomTool()` 使用官方 DSL 转换函数，随后调用与运行时共用的 `engine/tool-definition.mjs` 校验。`validateCustomTools()` 先检查 ID／工具名称冲突，再完整编译每条定义；失败在 bridge 返回 `400 custom-tools-invalid`，不写盘、不重建。

合法保存保留原始 DSL；保存和装配都完整校验身份及定义，非法工具拒绝整次操作。装配将 `compileCustomTool()` 的 JSON Schema 结果放入 `config.tools`，不写 custom-tools/。内联空数组明确代表无工具，缺字段才启用独立引擎旧目录模式；内联非法值不能回落。工具注册仍受 disposer 管理，支持 shell、HTTP、已有工具委托、文件操作和用户询问。

工具卡同时提供参数行编辑与高级 JSON，修改名称／描述／必填不丢弃嵌套 `properties/items/oneOf/enum`。文件写入／追加显式编辑内容；超时为 `1–2147483647` 毫秒，单工具定义上限 1 MiB，执行器字段在保存前按类型校验。

`customToolRequireApproval` 映射到 `tool-config-engine.requireApproval`，仅允许现有五种执行器名称；`configsDir` 仅保留给独立文件入口，不向配置卡开放。

## 7. 合并优先级（组合行 config）

组合模块目录：`engine/compositions/source/local/` 是本项目自有模块的唯一源；官方切块已随
「与预设彻底解耦」全部清理。`renderComposition` 按裸库名解析，找不到时装配期直接报错。


`renderComposition`：**参数桥（params/UI）> moduleConfigs（模板/ST 行级直写）> 行默认**。
moduleConfigs 仅补充参数桥未覆盖的键，不再锁定覆盖 UI 可管理参数（2026-08-25 翻转）。

## 8. 条件与内容策略的归属

`engine/instruction-hint.mjs` 是通用内置能力：`placeholder + fill: instruction-hint`
与共享参数 `instructionHint`（由 `instruction-hint` 模块行承接）共用同一组
文件探测与显式模板渲染函数；它不属于任何预设专属模块。`instructionHint` 是默认关闭的
模块级转换开关；对官方待注入消息先应用逐文件过滤，只有作者提供了有效消息模板时才转换，
不替换历史，也不因模板为空丢弃官方正文。

内容策略实现在 `engine/actions/content.mjs`；`engine/strategies.mjs` 只保留导出入口。
条件树属于 `if`，动作正文策略属于 `then[].config`，两者不互相复制：

| 策略 | 内容功能 | 显式参数 | 资格与投递 |
|---|---|---|---|
| `first-turn-anchor` | 按任务分类选择作者锚句，或直接使用作者文本 | 动作 `params.useCustom/text/buildPattern/complexPattern/firstTurnBuild/firstTurnInspect/firstTurnDeep` | 条件与去重由规则／投递配置声明，正文为空不生成 |
| `guide-auto` | 选择作者的弱／深度引导文本 | 动作 `params.useCustom/text/guideWeak/guideDeep/complexPattern/complexMinChars` | 晋升等资格由规则 `if` 声明，长度门没有隐式阈值 |
| `anchor-notice` | 生成作者正文和确认／兜底来源说明 | 动作 `params.firstTurnWord/anchorWords/text` | `if.anchor` 负责确认条件及显式 `fallbackAfter`；内容策略不再藏第二套资格状态 |

`custom-fallback` 已退出运行时可执行策略与编辑目录；旧数据只能在离线阶段拆为
`when.anchor + anchor-notice`。确认词、兜底次数与正文都成为显式定义，没有内置两轮业务值。
锚句和引导文本仍是独立内容，不因共用分类原语而合并成全局调度器。

### 离线参数投影与规则所有权

`resolveLegacyPromptConfigs` 仅在离线／导入转换期间处理旧格式：

- `near-anchor` 承接首轮开关、自定义文本与任务分类参数。
- `router-guide` 承接每轮引导开关、文本与分类参数；`guideEnabled` 独立且缺省关闭，不跟随首轮开关。
- `prompt-injector` 承接旧正文注入开关、确认词和正文来源；有正文才启用，空确认词按锚句派生。

离线候选最终写入 `rules` 并移除已承接旧段。没有承接配置的旧值使预检失败，原字节保留；
不凭空创建规则或静默丢弃数据。正常规则保存不再执行这条投影，旧顶层 `params` 不恢复为规则来源。

旧 `fieldSources` 和文件序号只用于迁移核对，不能锁定新规则文本、启停或模型范围。
规则排序写入 `configOrder`；动作身份独立且稳定，不以动作数组的新位置重建投递身份。

### 世界书条目结构归一（2026-08-25）

`host/worldbook.ts` 的 `buildWorldBookEntry(input)` 是世界书条目结构工厂（能力归一）：
`strategy/layer/position` 固定值与 params 键集（constant/keys/secondaryKeys/caseSensitive/
wholeWords/selectiveLogic）单一权威。以下写入端共用：
- **ST 导入**（`sillytavern.ts` convertStToPreset）：ST 字段别名收敛（keys/key、constant/add_always、
  disable/enabled、insertion_order/order、case_sensitive/caseSensitive 等）保留在转换层，结构构造下沉工厂；
- **模型工具**（`world-book-tools.ts` world_book_upsert）：模型参数直接经工厂构造——工具后续暴露
  wholeWords 等字段时两通道自动一致。
- 模块记忆独立存于 `<模块根>/memory.md`。`world_book_upsert/delete` 的 note 追加记忆，`world_book_read_memory` 每次读取最新文件；缺失返回空文本，读取失败报错。记忆不自动转换为规则或注入。

各写入端把条目包装为 `inject-text` 规则动作，最终只修改 `rules`；世界书条件、扫描
和预算语义仍由该内容领域处理，不恢复 `promptConfigs` 存储所有者。

契约测试断言：ST 转换的通用字段与工厂同参数构造一致；ST 特有扫描、分组、概率和时序行为
保存在 `params.stWorldBook`，由选择器处理，原生 world-book 约定不变。位置或角色无法无损映射
时保留来源并通过 `meta.stWarnings` / 物化 warn 报告，不能声称完整 ST 等价。

### 旧参数的确认词投影

离线适配器先按旧规则从锚句派生确认词，再写入显式 `when.anchor.keys`。已有非空
`anchorWords` 集合优先，否则使用非空 `firstTurnWord`；内容侧保留这些字段仅生成来源说明。
确认条件复用 `anchor-match` 的 prefix 语义，新编辑器直接编辑条件树，不再通过旧快捷参数改正文。

### 人设与文本资产

人设独立保存在 `module.yml.persona`：`prefix`、`suffix`、`complete`、`includeRuntimeContext`。模块配装通道在该 Agent 的 scope 注册独立命名的前后缀；`complete` 的唯一性与运行上下文抑制仍由官方接口裁决，不覆盖宿主原有的同名段。

`/persona` 与 `/rules` 在写入前拒绝顶层独占与启用规则的独占注入并存；装配准备期再检查，覆盖手改定义和导入来源。`complete` 与 `suppressRuntimeContext` 属注册期能力，不能用动态 `if` 假装成每轮开关；字段的宿主语义和 disposer 保持。普通官方委派的 per-child persona 归宿主配置，插件模块的行参数不会因此改写它。

注入动作的 `config.text` 表示单段正文，`config.texts` 表示多段正文，引擎统一为内部文本数组。SillyTavern 导入与角色卡并入沿用各自领域转换，正文不进入部署设置。重物化由 `materializeModule` 读取模块自身定义和内容文件后交给 writer，生成目录仍不是可编辑事实源。

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
- 装配把完整定义的 `subagentToolPolicy` 放入 `config.policy`。段缺失或 null 时跳过该能力；独立引擎仅在 policy 字段缺失时读取 policyFile，显式非法内联一律拒绝。
- 保存链路：`/subagent-tool-policy` POST → `validateSubagentToolPolicy()` 校验 → 原子写盘并补齐模块声明；关闭开关只删策略段并保留模块声明，删除能力才同时移除两者。
- writer 读取手写/导入的策略段时同样先校验。历史“有段无模块”的定义保留策略装配，`effectiveModules` 反映有效能力，`declaredModules` 保持磁盘事实。已登记参数和行配置的依赖仍由 `impliedModulesForParams` 派生；移除能力同时清理其参数与行配置。官方组合行出现在物化产物中，不等于插件接管该官方工具的配置。
- `maxDepth` 仅在插件策略启用时约束其委派；普通官方委派深度归宿主。子模型 provider/name 与采样参数另经本地子代理请求规则生效，不改写普通官方 spawn 预检。策略文件确实不存在时回落官方委派；现存文件解析或校验失败必须报错，错误文案不能作为缺文件依据。
- 预览链路：`/subagent-tool-policy-preview` POST 与运行时 `resolveSubagentToolPolicy()` 同一 seam（不重复算法）；预览用 ceiling 工具宇宙。
- 工具面：`/tool-surface` POST 接受互斥的 `{ sessionId }` 或 `{ presetId }`。前者只读当前存活本地 Agent 的 name/description 摘要；后者经官方 `agentPresets.list()` 白名单与 `acquireScope()` 取得当前 revision lease，读取 `tools.schemas(lease.key)` 后在 finally 中释放。两者均不下发完整 Schema、大文本或 secrets；PTC 下预设工具能力不等于模型 wire 直连工具。

### 指令文件与逐文件过滤策略

指令文件（AGENTS.md / CLAUDE.md 等）不属于预设生命周期：正文在用户自己的文件里，显示名
与逐文件开关在独立策略文件里，两者都不写进 `module.yml`。官方负责注入，插件只过滤未来消息。

- **不再物化生成卡**：`writeModule` 不再探测指令文件、不再把 `agents-file-*` 卡写进生成
  目录；`module.yml#agentsHints` 已不是运行时开关（字段仅为兼容既有用户预设保留解析，不再
  生效）。文件集合、正文、版本与读取状态由 `/bootstrap`、`/prompt-configs` 按**本会话工作区**
  现场解析（优先 `agent.session.header.cwd`；无本地会话时回退部署进程 cwd，并以
  `context.source: deploy-cwd` 区分，不把该范围提示当作会话写授权）。
- **探测范围**：用户级 `$DSH_HOME/AGENTS.md` + 工作区 cwd→项目根链（`.git` 为根标记）每个
  目录的 `AGENTS.md` / `CLAUDE.md` / `AGENTS.local.md` / `CLAUDE.local.md`；只接受普通文件，
  候选文件与授权根均先解析真实路径，允许根目录本身是目录链接；越出获准范围（全局限
  DSH_HOME、项目限项目根）的文件不收录也不可写。这是本地文件卡的编辑范围，官方注入
  仍使用自身发现规则与配置。普通注入动作的 `config.params.file` 不是指令文件身份，不能因此被
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
  在过滤之后、且具有显式有效消息模板时转换剩余官方消息；空模板保持原正文。运行时语义见
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

完整模块导入使用 `writeModule` 的 `sourceDir + stageOnly`：隔离暂存根下使用合法目标 id，完成定义、工具和附件校验，再复检目标版本并 rename 交换。普通 `materializeModule` 原地恢复切片，不重建整个用户目录；记忆、未知资产、技能及正文保留。详见 [资产交换](asset-transfer.md) 与 [ADR-0008](adr/0008-module-slices-memory-assembly.md)。

- `test/host/write-preset.test.mjs`：规则物化与模型请求动作保持；旧源拒绝与显式离线转换；变量只读顶层 variables，保留空串与同名键，清空后不回退旧 params。
- `test/host/module-rules.test.mjs` 与 `rules-migration.test.mjs`：局部事务、改名／删除保序、显式互斥、CAS、坏结构、离线原字节回滚及业务空值行为。
- `test/host/module-config-order.test.mjs` 与 bridge 契约：尾部追加、身份排序、版本拒绝与正文不变；引擎装配回归验证跨模块交错次序。
