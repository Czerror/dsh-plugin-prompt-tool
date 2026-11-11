# 后端参数框架

系统段与消息形状容错归普通 host-control/message-shape-guards 动作，唯一参数为 value: true，默认关闭。它不接受次数预算或 outermost 排序；启停、受众、嵌套分支、规则版本、复制导出和显式依赖诊断沿原规则事务。已有用户模块不追加或覆盖内置卡，作用范围见[引擎指南](engine-reuse.md)。

每步当前系统正文归普通 `host-control/current-system-snapshot` 动作，唯一参数为 `value: true`，默认关闭，不接受投递次数预算或 outermost 排序。正文仍归既有 inject-text / persona 声明，动作不复制或持久化第二份正文；启停、受众、分支、保存版本沿普通规则路径。已有用户模块不追加或覆盖内置卡。

process 规则另支持 `command-confine-passthrough: true`：每模块发布一次，仅影响后续命令 confine 调用，与构造软默认独立；不接受 Agent 私有条件。内置卡默认关闭，已有用户模块不追加或覆盖。

规则正文包含可选 `executionScope: agent | process`，省略时为 agent；该字段沿既有完整规则正文、切片与模块复制导出保存，启停仍归原 `_settings.yml`。process 规则仅保存支持的无条件构造软默认，不接受 Agent 私有条件。内置三个软默认卡初始关闭，只补缺失模块，已有用户定义不追加或覆盖；作用时机与原生新会话继承见[引擎指南](engine-reuse.md)。

委派额度归普通 `host-control/delegation-limits` 的 `value`：可选 `maxDepth`（非负安全整数）与 `askTimeout`（1–2147483秒），至少一项。复用规则数字原文、错误草稿与版本保存，清空撤销该字段，空对象与非法数字拒绝发布；内置10/300只是可编辑初值。

本页说明模块定义、持久变量、人设、版本事务与保存边界。规则语义以 `engine/rule-spec.mjs` 为准，共享参数以 `src/shared/engine-params.ts` 为准，bridge 以 `src/shared/bridge-contract.ts` 为准；文档不建立第二份字段校验器。

## 原生格式与持久状态

| 数据或行为 | 唯一所有者 | 派生面 |
|---|---|---|
| 规则、条件、动作、启停与互斥 | module.yml.rules | 经校验的规则切片 |
| 共享引擎参数 | module.yml.layerSettings | `loadModuleSpec().params` 内部平铺适配 |
| 模块变量 | module.yml.variables | rules/variables.yml 与运行快照 |
| 全局变量 | `$DSH_HOME/.prompt-tool/variables.yml` 的 variables 映射 | 两级有效值快照，不随模块导出 |
| 会话变量 | 官方 storageDomain 的 `prompt_tool_session_variables` 域 | 按来源模块目录与真实会话隔离，运行有效值优先覆盖模块与全局 |
| 模块记忆 | 当前受控模块 memory.md | 显式工具读取，不自动注入 |
| 模块私有数据 | 当前受控模块 data/（账本、SELF、AGENTS.md 等） | 显式工具读取/追加；不导出，覆盖安装保留 |
| 人设正文与选项 | module.yml.rules 中的 persona 动作 | 按真实受众聚合的官方有效声明 |
| 自定义工具 | customTools | 经验证的内联运行输入 |
| 外部来源事实 | 注入动作 params.source | 导入报告与导出元数据 |
| 模块显示名称 | module.yml.name | 模块卡与编辑目标选择；不改变模块 ID 或目录 |

核心破限模块的 `customTools` 当前包含一个 `http_fetch` 行，默认 `enabled: false`。模块总开关关闭时整组贡献撤回；模块开启后仍须把该工具行显式设为 `true` 才注册，关闭工具行会撤回注册并保留定义。它固定发起 GET，返回状态、成功标志和原始响应正文；这不是官方 `web_fetch` 的网页提取、来源引用或 provider 能力，不能按两者语义等价使用。`unrestricted` 的来源定义仍保持 `fetch: false`，核心模块不会隐式修改或打开它。

当前格式的决策见 [ADR-0013](adr/0013-native-context-module-state.md)。模块不注册为官方会话预设、不保存会话绑定，不通过 settings 携带规则正文或大文本。

`/module-name` 通过显式 `x-module-id` 读取 `{ name, revision }`；保存仅接受 `name`、`expectedModuleId`、`expectedRevision`，名称修剪后为 1–128 个字符。写入先校验用户可写目录、身份和完整定义版本，再用 YAML Document 与既有原子提交只修改 `name`，保留注释、未知字段与规则。过期版本返回 409；普通保存只确认 `persisted` 并登记后台发布，切片发布失败仍返回 `publicationPending` 与 `publicationError`，不伪报未写盘。模块显示名称不代表默认主语，空白创建名为“默认模块”也不会建立隐式写入目标。

## 部署设置与编辑目标

唯一部署开关 `modulesEnabled` 控制模块运行总闸。关闭只撤回贡献，定义、资产与持久变量保留。规则启用成员来自插件存储根 config.yml.enabled，人设动作与其他规则共同参与；排序归模块 configOrder。

读端点与写端点都由请求头 `x-module-id` **定位**目录（服务端只用它解析 `deps.moduleDirectory`；未声明即无目标，`required` 端点 400 `module-dir-unavailable`）。写端点另在本体里带 `expectedModuleId`／`expectedRevisions`，其中 `expectedModuleId` 只作**一致性校验**、不参与定位：与请求头声明不一致即 400 `module-subject-conflict`，与当次解析目录不符即 409 `module-changed`（处理期间目标被换掉）——载荷永远不能替请求头选路径。两条身份判据在任何端点、任何豁免下都执行（见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)）。声明只决定这次读写作用在哪个模块，不改变启用集合或官方预设。官方工具预览的 presetId 保留官方含义。

模型工具的主语由这次调用显式声明的 `moduleId` 参数决定——该 Agent 这次启用了哪几层只作拒绝时的候选提示，绝不作为目标，缺声明即拒绝；工具主语约定见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)。模板按自身 sourceModuleId 访问变量，与模型工具目标和 UI 卡片归属分开。

## 磁盘格式：规则与共享参数各有所有者

module.yml 是完整定义、唯一提交点和恢复依据，支持直接手改。rules/ 是物化投影：

- `<ruleId>.yml`：id/name/layer/if/then/else 正文。
- `_settings.yml`：规则启停、group、groupScope、exclusive、order、模块变量开关与完整性元数据；人设正文留在对应规则切片。
- `variables.yml`：模块变量投影。

读取只认清单内切片，名单外备份、同步副本等由用户拥有，不读、不改、不删。清单内缺失或失配从有效完整定义单向恢复；完整定义非法则报错，不能用切片反向修复。规则文件名拒绝保留名、大小写冲突、设备名和路径字符。

普通重建在原目录恢复切片，保留记忆和未知资产；导入才在隔离候选中完整生成并交换目录。模块生产路径不生成 configs/、rules.yml、agent.cordis.yml 或第二套工具/策略目录。

规则顶层 layer 是注入动作缺省层及展示归属，不建立跨层总顺序。正文和内容策略属于动作，变量属于持久存储。读取叶子可投影稳定身份；映射写入覆盖 then、else、嵌套分支，保持原始条件、未改参数与注释，不写回编译展开或默认值。

`persona.stripDefaultIdentity` 的可选值为 `preset` 或 `harness`；它是普通动作字段，沿完整定义、切片、保存版本及模块包往返保留，非法目标在候选校验阶段拒绝。内置 `limit-breaker` 仅补缺失定义，初始模块及两条身份规则不自动启用，已有目录不追加或覆盖。

## 规则与变量事务

工具模板继续由tools-editor整组草稿、既有customTools保存与原发布链持有；此通道沿现有契约不增加逐工具CAS。工具说明的显式依赖使用普通tool条件，工具编辑与规则正文仍各自保存，不扫描正文自动登记依赖。

人设动作预算 `instructionsMaxBytes` 仍归module.yml普通规则，合法值为正安全整数。工作台直接复用RuleParameterFields数字原文、fields错误草稿、hasRuleFields保存阻断和原rule-drafts/CAS；切回继承清除此字段的原草稿，不创建独立预算保存。参考初值65536不限制用户采用其他合法值。

委派参数同样保存在普通规则动作 `subagent-params`，当前只接受 `provider: spawn`、合法工具名 `tool` 与必填非负安全整数 `maxDepth`。0 表示明确禁止委派；空值、负数、小数与非数值均拒绝，撤回贡献通过关闭规则或删除动作表达。数字沿原 RuleParameterFields、fields/hasRuleFields、规则 CAS 与发布，不新增深度草稿或保存端点。`assembly.target.sections.replace` 的名称与完整正文沿原装配表单及规则事务编辑。内置 unrestricted 只补缺失定义，模块及所有规则初始关闭，复制导出保留完整规则与所选文本许可，已有用户副本不覆盖。

显式瞬时额度 `request-params.maxTokens` 与 `phase.maxPromoteSteps` 同样沿原数字原文草稿和规则事务保存，合法范围均为正安全整数。非法或未完成原文不发保存请求，折叠保留草稿。该额度与同动作的patch/unset.maxTokens及replace互斥；原有patch组合不迁移。`pre-step-filter.instructionHint` 是普通规则中的可编辑完整模板。内置redteam只补缺失定义，七规则全部初始关闭；复制导出保留已保存数值、条件、正文和适用许可，不覆盖用户副本。请求额度运行接缝和指令字节预算分别取资格，详见[引擎指南](engine-reuse.md)。

### 规则事务与互斥

`readModuleRules` 返回完整原始规则和 `revisions: { rules, settings, variables }`。`editModuleRules`、`/rules`、TUI 与模型工具统一携带 `expectedRevisions`，规则接口不再接受整文档 expectedRevision。其它领域的字节版本不因此删除。

| 操作 | 版本与载荷 |
|---|---|
| 编辑正文 | 目标规则 revision；提交完整 rule，保留未改字段 |
| 修改启停/group/groupScope/exclusive | `settingsChanged: true` 并校验 settings |
| 新增/删除/改名 | 同时校验 settings；改名/删除同步 configOrder |
| 启用互斥卡 | `activateRuleId`，同一次事务关闭参与组内其他卡 |
| 删除整规则 | `rule: null`；工具不会根据删除叶子推断删除父规则 |
| 仅校验 | `validateOnly: true`，完整候选编译且不写盘 |

同模块同名非空 group 中任一卡 exclusive:true，整组最多一条启用。`groupScope` 缺省为 `module`；显式 `cross-module` 时，规则事务只在已启用模块和本次目标之间联动关闭同组成员，停用模块草稿不参与。多启用候选拒绝，不按排序挑赢家。正文保存不覆盖并发状态。非法条件、重复动作身份、越权目录、失效版本都在提交前拒绝。

确认条件的 `after: { action: seed }` 保存相对动作 id，编译与挂载时补全模块/规则身份；模板复制与规则自动改名不重写内部引用。完整候选在写盘前校验目标存在、独立投递能力、身份唯一和依赖无环。工作台可添加/清除 `after` 与 `fallbackAfter`，清除即删键；示例默认值不因展示而写入，省略兜底表示持续等待。旧专用锚定策略和参数不作兼容或自动迁移。

每次事务使用 YAML Document 保留注释和未知元数据，提交前复核版本与目录。模块锁序列化保存和恢复；正文/变量切片先准备，module.yml 原子替换为提交点，再发布清单。多文件替换不宣称物理同时原子。提交前失败恢复旧投影；提交后切片发布失败返回 `persisted`、新版本、`publicationPending` 和 `publicationError`，保留最后有效运行贡献。切片验证完成后，普通保存登记后台运行发布，不等待 Agent 重挂。

跨模块选择逐模块提交；后续成员写入失败时，已保存的目标不回滚，响应仍返回目标当前规则和版本，以及 `persisted:true`、`publicationPending:true`、`publicationError` 和 `activationPending`（本次选择的规则 id）。此时重试须用返回的新版本再次提交该 `activateRuleId`，不重放已保存的正文；目标已经启用也仍完成成员关闭。客户端保留此选择并优先重试保存，成功后才走正常发布；纯运行发布失败才用 `refreshOnly`。不保存恢复日志或选择栈，不承诺跨文件崩溃原子性。

**共享引用守卫（`shared-alias`）**：YAML 的 anchor/alias 会让一次「只改 A」的编辑连带改掉 B，因此每次写事务都必须自证「只改了自己声明的字段」——声明完整候选的路径（规则编辑、存储配置）走 `module-write.ts#serializeWithoutSharedAlias`（序列化失败与候选不一致同判），改-后-比对的路径走 `assertUnownedUnchanged`，`withModuleDefinition` 的调用方必须用必填的 `{ owns }` 声明本次编辑拥有的顶层键。判定不通过一律 400 `shared-alias` 且零写盘，拒绝文案点名被连带改动的键。

### 持久变量事务

变量是扁平字符串。module 覆盖 global；模块值 `''` 是有效覆盖，删除模块键才回落全局。global 只在同一 DSH_HOME 共享；不同安装隔离。`variables` 与共享参数允许同名但互不清理。

运行时新增 session 域：裸引用与 `effective` 条件按 session→module→global 取值，空串保留、删除才回落；显式 module/global 仍保持原范围。session 按模块规范目录与真实 sessionId 隔离，主子与不同会话不共享。工作台和 bridge 仍只编辑 module/global，不接受任意会话 ID。

session 的唯一 owner 使用官方 `storageDomain`（`@deepseek-ai/dsh-storage-domain`），同步读已校验快照，异步写等待持久化。一条记录拥有完整变量表、CAS revision 与逐键更新时间；首次写复用目标队列，跨域依赖仍按全局→模块锁顺序持锁至写入完成。同步 module/global 提交也校验实际读取的 session 版本。域不随模块导出或 Session 日志导出，不自动从父会话继承；官方后端不承诺多进程同时写同一域。

宿主须提供 storageDomain 及其后端；插件通过可选注入等待，不自行更改 profile。缺失时 session 写入明确拒绝，旧 module/global 继续工作。卸载拒绝新写并等待已开始的持久写；提交开始后取消不能回滚已持久结果，不重放已提交赋值。

模板缓存复用与异步提交完成后均重核变量总闸和原owner身份；成功凭据保留，撤权只抑制正文。变量／mark工具已持久但失去发布资格时返回 `persisted: true, publicationSuppressed: true` 与版本，不附变量或mark正文，也不伪报未写入。

`readModuleVariables` 返回 `{ module, global, effective, revisions, enabled }`；版本域是 global、module、settings。全局文件缺失为空且 revision:null，损坏 YAML、非法 UTF-8、链接或读取错误必须报告，不能当成空表覆盖。模块值仍通过完整定义事务提交。

`editModuleVariables` 每次只写一个 scope，支持完整 values 或局部 changes，二者不混用。changes 中 null 删除，字符串（包括空串）写入。更新内容要求目标域 revision，开关要求 settings；模板额外校验所有实际读取域。锁顺序固定全局→模块，单域原子提交，不创建跨文件 journal。

例如 module.inc 从 global=10 回落计算11，提交前也须核对 global revision；不能仅校验模块版本。变量名拒绝原型键、保留名及非法空白，值/总量有界；具体上限由存储校验器拥有。

`/module-variables` 接受 scope、完整 variables、enabled、expectedModuleId、expectedRevisions。工具 `module_variables` 提供 list/get/set/delete；set 必须显式字符串 value，delete 只删除指定域键。全局写同样需要实际装配工具权限和受控目标。

值更新发布新快照，不重挂 Agent；新增键和不同模块同名键按来源动态读取。变量开关只控制该模块求值和模板写入，不关闭其它模块，也不删除持久值；开关变化登记后台运行发布。切片失败或显式发布重试失败时保留 `publicationPending`，重试只发 `refreshOnly`，不重放内容写入。

bridge 的变量保存与重试由 `BridgeRuntime` 统一组织，开关变化进入装配通道的同一后台调度器；路由只负责授权、载荷校验与响应。普通读取和 bootstrap 共享变量视图，读取不触发开关重试，也不新增 `persisted`；仅值更新不顺带重试此前失败的开关发布。后台运行失败归入 `/meta` 的 `publicationFailures`，不写入变量草稿的待发布状态。

## 动态人设规则与继承

```yaml
rules:
  - id: project-persona
    if: { variable: { key: mode, value: coding } }
    then:
      - id: identity
        kind: persona
        audience: main
        prefix: 你是项目助手。
        complete: false
```

persona 动作复用规则 if/then/else、嵌套分支、enabled、configOrder 与稳定动作 id；可声明 audience:main/subagent，省略覆盖两类。所有启用模块按既有规则顺序和动作声明顺序参与，主子按真实 Agent 分别判定。prefix/suffix 各自拼接非空片段，以两个换行分隔；空片段不增加分隔符，但仍是显式声明。

某字段全省略才继承官方，显式空串阻止该字段继承而不清除其他规则正文。complete/includeRuntimeContext 的显式值须一致，同值幂等、省略继承；冲突拒绝整组，不部分替换。complete:false 解除人设 prefix 独占。includeRuntimeContext:false 增加本插件抑制，true 只撤本插件抑制，祖先 scope 的抑制仍生效。

规则是唯一正文所有者；人设卡编辑具体规则动作，读写共用 `/rules` 的逐规则 CAS、保存队列、草稿保留与发布重试。没有独立正文端点、来源下拉或 settings 正文投影。旧顶层 persona（含 main/subagent）及 config.yml.personaSources 在读取根明确拒绝，用户手工重建规则并移除旧键；插件不双读、不迁移、不自动改用户文件。

统一 ruleRuntime 在原官方 assemble 之前求值、聚合、预检并事务化替换本 Agent 的完整人设贡献；同时预检同受众普通 complete 与 sections.append。全部失配或必要事实不可用撤回插件贡献并恢复官方；配置、解析、注册错误报告并保留最后有效组。自定义正文按来源模块读取会话→模块→全局变量和只读 runtime，继承官方正文原样保留，不重新求模板。同步人设出口拒绝 session setter。

同一 Agent 的准备与原 assemble 串行，每次固定候选；不同 Agent 可并发，全局刷新事务等待各 Agent 锁。AgentSetup 捕获的同层官方声明只暂撤，失配或卸载恢复；原 owner 已释放时不复活其声明。边界见 [引擎接线](engine-reuse.md#执行状态与接入)。代码更新仍须用户重启 DSH。

## 共享参数与保存链路

`layerSettings.<层>.<键>` 是共享参数唯一磁盘路径。storageLayer 由参数目录固定，UI displayLayer/card 只影响展示。公开目录覆盖主/子模型、PTC 呈现、Git Bash 配置、指令提示和自定义工具审批。完整表与类型直接查 `ENGINE_PARAM_DEFINITIONS`，根 [module.yml](../module.yml) 由脚本生成参考。运行时注入的资源根和规则/工具文件路径不进入通用编辑字段；规则与工具定义继续使用专用编辑器。

同名键在两处存在：模块自己的 `module.yml`（模块层）与存储根 `config.yml` 的 `layerSettings`（**全局层**，固定卡指令卡的设置区写它）。有效值优先级是**模块显式键 ＞ 全局键 ＞ 引擎/行默认**——存在即覆盖，`false`/`0` 也算显式；判据与合并只在 `module-params.ts#resolveModuleParams` 一处，客户端与端点都不重复判。模块没有该键时回退全局值，因此全局开关对未声明它的模块同样生效。

模型卡的路由/采样在 prepareAssembly 转成两条受众限定的 request-params 合成规则，不写回规则文件。也可显式写 request-params 动作。未配置模型参数继承宿主，不修改全局默认模型。子代理递归深度归宿主官方委派管理（`subagent.maxDepth`），插件不再提供逐模块深度配置。

```text
共享参数草稿 → /param-overrides → saveModuleParams → 完整定义提交
规则草稿 → /rules → editModuleRules → 完整候选校验与提交
两级变量草稿 → /module-variables → editModuleVariables → 单域提交
规则/参数保存 → 验证规则切片 → 登记后台发布 → 更新受影响 Agent
变量内容更新 → 发布快照 → 下一求值读取，不重新配装
```

共享参数的空字符串/空列表表示删键，false/0 保留。这个规则不适用于模板变量或规则正文；具名空变量和空正文都合法。只发送已存在或用户修改的参数，不把下拉默认项和能力行默认值固化进定义。

`/param-overrides` 的 `overrides` 只返回模块显式持久键，`effective` 返回白名单内有效参数，包含全局回退及能力组合默认。客户端用有效读数作显示与比较基线，用显式键记录删除语义；未编辑默认值不写盘。声明 `modules` 或 `moduleConfigs` 的模块即使没有 `layerSettings`，也可读取能力默认参数。

PTC 的 `ptcMainMode` 与 `ptcSubagentMode` 分别映射到 `present-as.mainMode/subagentMode`，两页各编辑对应字段；缺省继承该行原有 `mode`。`presentAsEnabled` 是该能力的模块级共享开关；执行器挂载、等待和释放遵循[工具呈现契约](engine-reuse.md#工具呈现present-as)。

组合配置优先级为已声明共享参数桥 > moduleConfigs > 行默认。模块目录仅 source/local，官方工具、规划和压缩来自会话原有预设。自定义能力的新增/删除都经服务端白名单与候选验证，不由客户端猜目录或递归清理用户文件。

内容填充的安全边界：`env-facts` 只允许 `env-safety` 的安全环境白名单，白名单外的键在构造期 fail loud；`instruction-hint` 的 `params.file` 只允许指令文件候选名，realpath 必须落在会话 cwd→最近项目根或 DSH_HOME；custom `fs` 执行器用 realpath containment 限定 cwd，symlink/junction 越界拒绝。

## 配置序号与跨模块排序

module.yml.configOrder 保存规则id→非负安全整数，身份仍是模块id+规则id。同执行点按序排列，启用没有序号的规则追加到尾部；碰号时保留该模块内部相对顺序整体追加。规则事务新建卡时也读其他启用模块的序号，直接接在全局尾部；尾部算法只在 `src/shared/module-config-order.ts#nextConfigSequence` 一份（切片恢复只传本模块）。重复启用无冲突不改顺序。

排序接口提交完整身份集合与版本，包含 UI 过滤隐藏项。排序只改轻量映射，不复制正文、不改变互斥开关。官方 system/context 的 order 与 waterfall 注册顺序保持各自语义，见 [引擎顺序](engine-reuse.md#提示词配置插入点与顺序)。

## 4. 持久变量与模板求值

普通规则只引用作者已建立的变量，不自动扫描创建；工作台变量卡手动添加空占位。ST 导入是自动登记的独立入口：正文/触发键的缺失裸引用登记为 `''`，不猜测业务值。原动作 config.variables 已退役，无冲突值可在显式转换时提升到模块 variables；同名不同值必须先解决。

`params.templateEvaluation: true` 启用原生 module/global/session 的 set/get/add/inc/dec。set/add 不输出，inc/dec 输出结果；裸引用与 session.get 按会话→模块→全局，module.get 按模块→全局，global.get 只访问全局。带非空默认值的 get 保留缺值写回扩展。session 值作为字面数据读取，不递归执行值中的模板；旧 module/global 的递归展开保持。

求值先得到正文和变更集，同卡读取看到暂存写入。一张模板可读多个域但只写一个持久域；双域赋值、非法解析、循环、保留名、原型键或展开预算错误整卡零提交。扫描/预览/SELF只读，不能执行赋值。session 赋值仅用于可等待持久化的规则执行和模型工具；官方同步人设 provider 支持读取新域，但拒绝 session 赋值，旧 module/global 赋值不变。输入/输出和嵌套工作量有界。

真实执行先判规则及动作资格。执行帧按运行 Agent、取消信号、turn/step 边界识别，assembly→pre-step→同执行重挂只提交一次；版本改变不触发同执行重放。成功前可有界重试当前卡且保留随机样本；提交后发布失败只重试发布。跨卡不承诺原子，跨进程任意崩溃不承诺 exactly-once。

同模块的主/子会话共享 module/global，session 独立；结束会话、压缩、卸载或重挂不清空。普通前后缀不改变 pick 的稳定选择。`runtime.get` 只读同源运行事实，不回落用户同名值，不接受赋值或写回默认值；不可用不冒充空串或零。未知普通引用的出口清洗不创建变量，具名空值则直接替换为空。

## 保存状态机

本地内容编辑采用失焦自动保存：规则、变量与指令正文离开编辑卡片时提交，引擎参数文本离开控件时提交；输入或停顿只更新草稿，开关与选项立即提交。卡内移焦与输入法确认不触发文本保存，组合输入跨失焦结束后再提交最终值。不合法的数字、JSON、空变量名或未完成的新规则保留为草稿，不自动删除或隐藏；具名空字符串是合法变量值。发送消息不等待草稿提交，运行只读取磁盘已保存的有效内容。各官方入口的注册与更新时机见 [引擎接线](engine-reuse.md)。

1. 参数、规则和能力操作进入模块保存队列，队列内完成写入与读回。
2. 参数保存的快照时机分别保留：模块参数在共享队列任务开始执行时取值，全局参数在入队前取值；成功只确认实际提交的快照，请求期间的新输入继续保持 dirty。模块参数的跨域刷新资格仍在入队前捕获，等待期间的新编辑也会阻止该次保存触发整轮刷新。
3. 切模块先处理未存草稿并等待队列，迟到响应只能更新原目标草稿。
4. 变量草稿按模块+scope 隔离，内容和开关分别保留版本；CAS 失败保留编辑。
5. 普通模块写端点在写盘与切片验证后回 200 + `persisted:true`，不等待 Agent 发布，也不提前返回 `publicationPending:false`。装配通道统一合并同模块 300ms 内的连续保存；启用先提交排序和启用表，再登记一次发布。端点覆盖 params、rules、moduleVariables 的开关、customTools、moduleName、moduleCapability、importModulePackage、moduleClone、moduleDuplicate、moduleEnable、moduleConfigOrder、moduleDelete。
6. 后台运行失败只写日志与 `/meta.publicationFailures`，不进入 `moduleWarnings`，任何工作台 UI 都不显示它。切片提交后失败仍回 200 + `persisted` + `publicationPending` + `publicationError`，客户端保留草稿与恢复入口；未提交失败按原错误返回，不把已提交修改伪报为未写盘。
7. `refreshOnly` 提前执行对应待发布更改并同步等待真实结果，成功才返回 `publicationPending:false`；同版本已生效时不重复重挂。重试不重复导入、改名、自增、安装、创建或删除。`refreshOnly` 与同端点的写载荷（name/customTools/overrides/action/entries/enabled 等）混用一律 400；定位身份（id/targetId/expectedModuleId/主语头）仍按端点保留。发送请求前的 freshness 检查也可提前发布磁盘定义，不等待尚未提交的草稿。

空键行属于 UI 草稿，保存载荷不发空键；保存或后台读取不因空行清理用户输入。UI 只在对应草稿版本仍一致时刷新。客户端使用共享 request/value map，服务端仍完整复检类型、大小、目标与版本。

文件读取额度归普通 `host-control/file-read-limits` 动作的 `value`，不进入部署settings或独立参数表。三个可选正安全整数复用原 `RuleParameterFields` 数字原文、错误草稿、版本保存和完整候选校验；清空只撤销该字段，三项全空仍由编译拒绝，不发布为0。标签保持简短，单位及继承说明使用原hint。实际接入边界见[文件读取上限](engine-reuse.md#文件读取上限)。

结果片段配置归 `module.yml.rules` 的普通 `tool-result/action: edit-text` 动作，`edits` 保存非空数组及每项的 `region/match/text`；空替文为有效删除，空匹配由完整候选校验拒绝。装配替句的 `match` 可为非空字面候选数组，候选仍按明确原文匹配，不转换为正则或逗号拼接。两者沿原规则CAS、YAML Document、切片、导入导出与发布链保存，没有独立结果配置文件或保存端点。limit-breaker新增结果/Web/交付规则全部默认关闭，只补缺失定义，已有用户模块不追加或覆盖；运行支持边界见[工具结果与Web功能段](engine-reuse.md#工具结果与web功能段)。
## 自定义模型工具

customTools 独立于规则/变量。`compileCustomTool` 使用官方 DSL 转换再交 `tool-definition.mjs` 校验；身份、Schema、执行器和输出都在保存/装配前检查。保存保留作者 DSL，运行内联编译工具，不另写工具产物目录。

支持 shell/http/delegate/fs/ask-user；delegate 通过官方工具调度保留批准与拒绝。customToolRequireApproval 只接受实际执行器名称。大文本、秘密与 token 不放 settings；shell 环境沿白名单处理，超时与输出上限有可诊断原因；fs 执行器按 realpath containment 限定 cwd，symlink/junction 不得越界。工具卡的参数行编辑不得丢嵌套 properties/items/oneOf/enum。

已存在工具的说明不通过同名delegate或复制完整schema接管；普通规则的 `assembly.target.toolDescriptions` 只保存实际工具名、可选顶层参数名、精确匹配与替文。它沿原规则编辑、CAS、YAML Document、切片、导入导出和运行发布链保存，非法类型/空匹配在写盘前拒绝，空替文仍是有效删除意图；无独立工具说明文件或版本owner。工作台沿原装配卡编辑这些字段，工具执行与约束仍由原定义拥有。

技能摘要配置同样归普通规则的 `assembly.target.skillDescriptions`，只保存技能名、精确原文与替文；不复制技能正文、不改身份或调用定义，也没有独立保存/版本owner。工作台沿原装配卡、原文和正文编辑链保存，匹配必填、替文可空，不提供工具参数字段。规则诊断只读取当前保存版本的观测，旧版本或编辑中的草稿不显示成功。

## 指令文件与逐文件过滤策略

AGENTS.md/CLAUDE.md 及 local 变体属于用户文件。正文就地保存；显示名和后续注入开关属于独立 `$DSH_HOME/.prompt-tool/instructions.yml`。两者不写入 module.yml、settings、生成目录或模板变量。

- 文件卡探测 `$DSH_HOME/AGENTS.md` 与当前会话 cwd 到项目根链的候选。真实路径命中授权范围且为普通文件才可编辑；部署 cwd 回退只是范围提示，不等于会话写授权。
- 保存要求 fileId/contextId 白名单及 expectedRevision 字节版本。不存在、越界、过期、超限或读取失败明确拒绝；临时文件+rename 替换目标本身并保留权限。
- 正文保存不重建模块。策略局部写保留注释、未知字段及另一端最新状态；共享 alias 可能改变未编辑内容时拒绝。
- 过滤只作用于可识别的未来官方消息。关闭不撤回历史，不阻止官方读取，不补预算删掉的正文；未知身份/不可分段保留并诊断。
- instructionHint 在过滤后且有有效模板时转换；空模板保持原文。owner 只报告已观察事实，未观察不捏造“未装配”。

细节与理由见 [ADR-0003](adr/0003-instruction-files-independent.md)、[ADR-0004](adr/0004-official-instruction-filter.md)、[引擎过滤](engine-reuse.md#pre-step-协调器与官方指令过滤)。

## 旧格式与显式转换
新内部上下文、变量、工具和人设字段不双读：world-book/stWorldBook/stWorldBookRecursive/stMacros/stSource、动作局部变量、旧工具能力以及全部顶层 persona、config.yml.personaSources 均在读取根拒绝，需用户手工重建人设规则并移除旧字段。外部 ST 标准别名仍由 adapter 识别。

其它历史快捷参数按共享白名单读取，未登记值不参与执行；旧快捷键写入拒绝。不能因此推断任意旧模块可运行，更不能把被拒绝的本次退役字段当普通未知元数据略过。完整边界以 load/compile/save 的实际错误为准。

旧私有记忆/角色来源标记阻止原生分享与导入；不能删掉标记后发出潜在记忆。先备份并明确拆分私有 memory.md 和可分享规则，再由用户授权转换。未知附件保留，不清理旧用户目录。

## 书房数据预览与导入

用户在 Web 或 TUI 的命令入口直接执行 `/prompt-tool data-import <JSON>`。目标必须是已安装的用户模块，`moduleId` 在每次请求中显式给出；来源为用户选择的书房根目录，`paths` 逐个指定该根下的普通文件，不递归扫描来源。

```text
/prompt-tool data-import {"moduleId":"soul","sourceDirectory":"D:/my-study","paths":["02-墨.jsonl","10-宪章/rules.md"]}
```

预览返回 `revision` 和 `entries`，每项有目标路径与 `create`、`skip` 或 `conflict` 状态，预览不写盘。确认后保持原请求不变，加上 `"expectedRevision":"<预览返回的 revision>"` 再执行。只创建缺失项；同内容项跳过，冲突项报告并保留目标，不提供隐式覆盖。来源内容、选择范围或整个目标目录在预览后发生变化均拒绝应用，须重新预览。

目标统一落在模块的 `data/`。来源根下的旧名 `02-墨.jsonl` 集中映射为 `data/02-soul.jsonl`；目标已存在旧账本时拒绝生成第二份账本，须先明确处理旧数据。原始来源始终保留。路径越界、链接、非普通文件、非法 UTF-8、单文件超过 8 MiB、总量超过 64 MiB 或条目超过 2048 个均拒绝。

新建书房使用 `{"moduleId":"soul","initialize":true}` 选择该模块 `assets/manifest.yml` 的目录与模板文件，同样先预览再带 `expectedRevision` 应用，不能同时给外部来源。初始化只补缺失，不覆盖已修改模板；它不凭空创建清单 `checks` 中的账本，也不把检查通过等同于初始化完成。这里的 `data/AGENTS.md` 是模块私有资产，不是工作区指令文件。

`host/module-data-import.ts` 统一拥有预览与应用；完整候选在现有模块目录事务中生成，锁内复核版本后交换，准备失败保留原目录。默认模块导出仍排除整个 `data/`。这条显式命令不会改变 `module_manifest` 既有的 next/check/apply 语义。check 本身保持只读且实时检查；规则条件 `manifest: { ok: boolean }` 通过 `src/host/module-manifest-check.ts` 单独缓存结果 1000ms，manifest 的 mtime/size 变化提前失效，到期后首次求值完整重检。显式 check 不刷新规则缓存，也不写变量。独立 rule-engine 入口不提供该读取器；三值与入口契约见 [引擎复用](engine-reuse.md#规则条件与动作边界)。

## 模块归属与验证

### Soul账本与派生快照

`soul-ledger` 提供正式工具 `soul_ledger`，每次显式传 `moduleId`；`action: list` 可按 `type` 和 `limit` 读取，`action: append` 接收 `type` 与 `概要` 或旧 `text` 之一，以及可选 `ref`／`feel`。支持 lead、promise、fact、shelved、gain、loss、persona、container；作者和时间由真实执行会话与宿主生成，不接受调用方覆盖。lead 通过官方 `tools/pre-execute` 请求审批；promise 必须由最后一条 lead 的署名会话追加。读旧 text 时投影为概要，不重写原行。

追加沿模块锁串行，账本总量 8 MiB、单字段 8 KiB；读取默认30条、最多100条和64 KiB输出。坏历史、链接、取消和超限都拒绝，不重置为新账本。通用 `module_file_append` 对 `data/02-soul.jsonl` 与旧名 `data/02-墨.jsonl`（含大小写变体）拒绝追加；显式用户数据导入仍按预览权限保留原件与目标冲突。

用户骨架在 `data/SELF.src.md`，诊断快照在 `data/.soul/SELF.md`。每步 SELF 直接读取当前骨架、账本投影、真实会话身份/时钟和索引最近观测；维护关闭或快照缺失/陈旧不阻断当前事实。读取内容版本及历史分界最多重验三次，持续变动报告不可用。快照仅作诊断或明确带来源时间与安全原因的降级，不作为当前事实；权限、路径或身份拒绝不允许借旧快照绕过。

派生与快照复用同一正文实现，屏蔽已识别的凭据格式后按 UTF-8 字节预算（默认12288）；骨架与身份不静默截断，事项只给有界摘要、精确总数和未展示数。快照使用 CAS、临时文件和 rename，最终发布前重验来源，失败保留旧版。`rule-engine` 内置 `strategy: placeholder, fill: soul-self` 负责实际异步装配，模块无需策略 JS；候选渲染和真实投递分开观测。

`soul_ledger list` 增加 `view: pending/open/pending-review` 和 `cursor`，游标绑定内容版本及过滤条件。条目 `id` 由模块规范路径、元数据固化的逻辑身份和原行内容链派生，追加及同路径正式导入复制不改变旧引用；inode不是持久身份。模块改名或部署根迁移不保证旧引用，不能把跨模块复制当同一账本。首次合法写入前在锁内建立 `data/.soul-ledger-v2.json` 历史分界与身份；读取不初始化，历史 promise/shelved 明确待核对。`close` 接受 `targetId/outcome/reason/ref?`，outcome 为 completed/cancelled，reason 非空；promise 仅当前 lead，shelved 原作者或当前 lead 可关闭，同结果重复幂等、冲突结果拒绝。收口只追加，旧行不改，暂时搁置仍未结。

`soul-ledger` 同时挂载 `soul_state`。status 读取真实当前会话；mark 写 1–512 字符、最多2048字节的短状态，携 `expectedRevision`（首次 null），按模块与真实会话隔离并原子保存，卸载不删除。check 只读报告文件、账本、SELF 候选/投递、索引、维护/恢复证据；unknown/not-observed 不冒充全绿。标记时刻、系统活动时刻和快照时刻分别呈现。check 显式 `includeUpgrade: true` 才展开 upgrade：完整规则与新增能力配置、近义资产、现有可交换文件；内部注释/未知字段保持，共享alias连带变化或用户不同配置明确拒绝。完整files须交 `module_import` 模型工具预览确认（保留data/memory/skills），携新凭据应用并重建，不用普通覆盖导入替代。

新 close 数据需要账本 v2 读取器；旧 `9007bf28` 仍会累计原 promise 且允许写入，兼容标记不能保护旧二进制。回滚先撤 `soul-ledger` 写能力及旧 SELF/提醒贡献，确认后再退代码；保留全部 close 行。内置种子只补缺失，不自动改用户副本、活变量或私有数据。

mark 现在是通用会话键 `soul.mark`，`soul_state` 保留兼容接口并复用同一 owner；通过 module_variables 或模板写该键也执行同一限长。recordedAt 来自该键的宿主更新时间，同值写不刷新，其他键变化不改变 mark 时刻，但会使整个会话表的旧 revision 失效。旧 `data/.soul/state-<hash>.json` 仅读取兼容，首次合法会话写将旧 mark 与本次变更一次提交到官方域并保留原件；新记录存在后不再读取旧值。旧文件损坏或版本变化拒绝迁移，不以空表覆盖。

Soul 运行时与状态工具必须显式接入会话变量 owner 的 getter；依赖不可用时拒绝读取当前状态，不直接回读旧文件。旧文件兼容读取仅由会话变量 owner 在新记录不存在时执行。

注入预算从模块事实读取，mtime/size 变化提前更新，最长缓存1000ms；读取或校验失败沿用最近有效值，无历史值回默认。这只缓存预算，不缓存当前骨架/账本事实。定义内容暂时损坏不阻断安全只读来源，但路径、文件种类和可读声明 ID 仍逐次校验，最终输出仍受预算限制。维护与注入共用预算校验，回退与刷新口径见 [SELF动态内容与维护心跳](engine-reuse.md#self动态内容与维护心跳)。

`generation-recovery` 额度保存在插件存储根的 `generation-recovery/<会话ID摘要>.json`，保存已消费 turn/step 身份及累计 used；锁内去重后原子替换，重挂与重启不清零，损坏文件拒绝重置。它不进入模块导出，也不修改会话日志。索引是可重建的派生内存状态，原账本与宿主日志仍为权威来源。

| 所有者 | 文件 |
|---|---|
| 完整定义/切片 | host/module-slices.ts、module-rules.ts |
| 安装事务 | host/module-install-transaction.ts |
| 两级变量 | host/module-variables.ts、shared/module-variables.ts |
| 模块私有文件 | host/module-files.ts、module-file-path.ts；装配清单 host/module-manifest.ts |
| 导入/导出 | host/import-source.ts、module-package.ts、module-install.ts |
| 装配/人设 | engine/rule-runtime.mjs；runtime/agent-assembly.ts、persona-registration.ts 官方适配 |
| 请求/草稿 | shared/bridge-contract.ts、client/data/、settings-bridge.ts |

随包内置模块只在用户模块根缺失同名目录时补建；已有副本（含用户修改）不覆盖，也不比较内容。见 [ADR-0015](adr/0015-builtin-module-seed-missing-only.md)。

长期测试只进入注入行为、写盘语义、bridge 载荷、安全拒绝 seam，期望来自独立规格/字面样例，断言公共接口。提交前跑完整 package gates，涉及宿主/包接入补对应验证；一次性探针放隔离临时目录，不能用仅检查旧符号消失的测试替代行为验收。
