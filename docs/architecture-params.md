# 后端参数框架

本页说明模块定义、持久变量、人设、版本事务与保存边界。规则语义以 `engine/rule-spec.mjs` 为准，共享参数以 `src/shared/engine-params.ts` 为准，bridge 以 `src/shared/bridge-contract.ts` 为准。

内容模块已移出本仓库，具体卡片和初值由内容来源决定。模块停用再启用保留逐条启停选择；补种只处理缺失目录，包升级不重置已有副本。

回退待办使用 `host-control/session-rewind-todos`，仅接受 `value: true` 且无次数预算。它不隐式启用会话回退；按当前目标 Agent 规则条件生效，复用 rewind bridge 的逐目标失败与重试载荷。待办正文仍归官方 Session 的 `todo/write`，不进入 module.yml 或 settings。

会话回退使用 `host-control/session-rewind`，仅接受 `value: true` 且无次数预算。资格沿当前 Agent 规则受众和条件求值；关闭只阻止后续回退，已提交标记仍有效。bridge `rewind` 的 phase 为 `preview` / `commit` / `retry`，只接会话身份、模式、去重身份、页面凭据及固定边界，不接受模块主语、任意事件范围或子目标列表。

Messages 当前系统正文使用 `host-control/messages-current-system`，仅接受 `value: true`，不接受次数预算或非默认时机。不保存正文副本，不隐式开启 `current-system-snapshot`；依赖诊断为 `host:messages-current-system`。实际接入范围见[引擎指南](engine-reuse.md)。

请求身份首段与系统角色分别使用 `host-control/oauth-identity-prefix`、`host-control/provider-system-role`，唯一值为 `value: true`。两卡独立启停与受众判定，不接受次数预算或 outermost 排序。不保存正文、认证或请求头副本，运行身份只来自已接受工具步骤与实际 prepared adapter call；缺目标诊断分别为 `host:oauth-identity-prefix`、`host:provider-system-role`。

系统段与消息形状容错使用 `host-control/message-shape-guards`，唯一值为 `value: true`，不接受次数预算或 outermost 排序。它与上述动作共用规则启停、受众、分支、版本、复制导出与依赖诊断，不另建保存通道。

每步当前系统正文使用 `host-control/current-system-snapshot`，唯一值为 `value: true`，不接受次数预算或 outermost 排序。正文仍归 inject-text / persona 声明，不复制或持久化第二份正文。

process 规则另支持 `command-confine-passthrough: true`：每模块发布一次，仅影响后续命令 confine 调用，与构造软默认独立；不接受 Agent 私有条件。

规则正文的 `executionScope: agent | process` 省略时为 agent，沿完整定义、切片与复制导出保存，启停投影在 `_settings.yml`。process 规则只接受支持的无条件构造软默认及上述命令穿透，不接受 Agent 私有条件；作用时机与新会话继承见[引擎指南](engine-reuse.md)。

委派额度归 `host-control/delegation-limits` 的 `value`：可选 `maxDepth`（非负安全整数）与 `askTimeout`（1–2147483 秒），至少一项。复用规则数字草稿与版本保存；清空撤销该字段，空对象与非法数字拒绝发布。

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

`customTools` 是模块自定义工具模板行：模块总开关关闭时整组贡献撤回；模块开启后仍须把工具行显式设为 `true` 才注册，关闭工具行撤回注册并保留定义。自定义 HTTP 工具返回原始响应时，不等价于官方 `web_fetch` 的网页提取、来源引用或 provider 能力；工具行不隐式打开 `fetch` 来源开关，该开关默认关闭。

当前格式的决策见 [ADR-0013](adr/0013-native-context-module-state.md)。模块不注册为官方会话预设、不保存会话绑定，不通过 settings 携带规则正文或大文本。

`/module-name` 通过显式 `x-module-id` 读取 `{ name, revision }`；保存仅接受 `name`、`expectedModuleId`、`expectedRevision`，名称修剪后为 1–128 个字符。写入先校验用户可写目录、身份和完整定义版本，再用 YAML Document 与既有原子提交只修改 `name`，保留注释、未知字段与规则。过期版本返回 409；普通保存只确认 `persisted` 并登记后台发布，切片发布失败仍返回 `publicationPending` 与 `publicationError`，不伪报未写盘。模块显示名称不代表默认主语，空白创建名为“默认模块”也不会建立隐式写入目标。

## 部署设置与编辑目标

唯一部署开关 `modulesEnabled` 控制模块运行总闸。关闭只撤回贡献，定义、资产与持久变量保留。规则启用成员来自插件存储根 config.yml.enabled，人设动作与其他规则共同参与；排序归模块 configOrder。

启用模块时，以配置锁内读到的最新启用集合为准完成路径及跨模块互斥校验；若另一提交使候选集合冲突，本次启用拒绝且不改写已有合法集合。停用与重复启用保持幂等，配置中的注释及未知字段保留。

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

`persona.stripDefaultIdentity` 可选 `preset` 或 `harness`，选择要移除的默认身份来源；它是普通动作字段，沿完整定义、切片、保存版本及模块包往返保留，非法目标在候选校验阶段拒绝。

## 规则与变量事务

工具模板继续由tools-editor整组草稿、既有customTools保存与原发布链持有；此通道沿现有契约不增加逐工具CAS。工具说明的显式依赖使用普通tool条件，工具编辑与规则正文仍各自保存，不扫描正文自动登记依赖。

人设动作预算 `instructionsMaxBytes` 仍归module.yml普通规则，合法值为正安全整数。工作台直接复用RuleParameterFields数字原文、fields错误草稿、hasRuleFields保存阻断和原rule-drafts/CAS；切回继承清除此字段的原草稿，不创建独立预算保存。参考初值65536不限制用户采用其他合法值。

委派参数保存在普通规则动作 `subagent-params`，当前只接受 `provider: spawn`、合法工具名 `tool` 与必填非负安全整数 `maxDepth`。0 表示明确禁止委派；空值、负数、小数与非数值均拒绝，撤回贡献通过关闭规则或删除动作表达。数字沿原 RuleParameterFields、fields/hasRuleFields、规则 CAS 与发布，不新增深度草稿或保存端点。`assembly.target.sections.replace` 的名称与完整正文沿原装配表单及规则事务编辑。

显式瞬时额度 `request-params.maxTokens` 与 `phase.maxPromoteSteps` 沿数字原文草稿和规则事务保存，合法范围均为正安全整数。非法或未完成原文不发保存请求，折叠保留草稿。该额度与同动作的patch/unset.maxTokens及replace互斥；原有patch组合不迁移。`pre-step-filter.instructionHint` 是普通规则中的可编辑完整模板。请求额度运行接缝和指令字节预算分别取资格，详见[引擎指南](engine-reuse.md)。

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

结果片段配置归 `module.yml.rules` 的普通 `tool-result/action: edit-text` 动作，`edits` 保存非空数组及每项的 `region/match/text`；空替文为有效删除，空匹配由完整候选校验拒绝。装配替句的 `match` 可为非空字面候选数组，候选仍按明确原文匹配，不转换为正则或逗号拼接。两者沿原规则CAS、YAML Document、切片、导入导出与发布链保存，没有独立结果配置文件或保存端点；运行支持边界见[工具结果与Web功能段](engine-reuse.md#工具结果与web功能段)。
## 自定义模型工具

customTools 独立于规则/变量。`compileCustomTool` 使用官方 DSL 转换再交 `tool-definition.mjs` 校验；身份、Schema、执行器和输出都在保存/装配前检查。保存保留作者 DSL，运行内联编译工具，不另写工具产物目录。

支持 shell/http/delegate/fs/ask-user；delegate 通过官方工具调度保留批准与拒绝。customToolRequireApproval 只接受实际执行器名称。大文本、秘密与 token 不放 settings；shell 环境沿白名单处理，超时与输出上限有可诊断原因；fs 执行器按 realpath containment 限定 cwd，symlink/junction 不得越界。工具卡的参数行编辑不得丢嵌套 properties/items/oneOf/enum。

已存在工具的说明不通过同名delegate或复制完整schema接管；普通规则的 `assembly.target.toolDescriptions` 只保存实际工具名、可选顶层参数名、精确匹配与替文。它沿原规则编辑、CAS、YAML Document、切片、导入导出和运行发布链保存，非法类型/空匹配在写盘前拒绝，空替文仍是有效删除意图；无独立工具说明文件或版本owner。工作台沿原装配卡编辑这些字段，工具执行与约束仍由原定义拥有。

技能摘要配置同样归普通规则的 `assembly.target.skillDescriptions`，只保存技能名、精确原文与替文；不复制技能正文、不改身份或调用定义，也没有独立保存/版本owner。工作台沿原装配卡、原文和正文编辑链保存，匹配必填、替文可空，不提供工具参数字段。规则诊断只读取当前保存版本的观测，旧版本或编辑中的草稿不显示成功。

## 指令文件与逐文件过滤策略

AGENTS.md/CLAUDE.md 及 local 变体属于用户文件。正文就地保存；显示名和后续注入开关属于独立 `$DSH_HOME/.prompt-tool/instructions.yml`。两者不写入 module.yml、settings、生成目录或模板变量。

- 文件卡探测 `$DSH_HOME/AGENTS.md` 与当前会话 cwd 到项目根链的候选。真实路径命中授权范围且为普通文件才可编辑；部署 cwd 回退只是范围提示，不等于会话写授权。
- 保存要求 fileId/contextId 白名单及 expectedRevision 字节版本。不存在、越界、过期、超限或读取失败明确拒绝；临时文件+rename 替换目标本身并保留权限。
- 同一 DSH_HOME 的插件写入按规范真实路径（大小写不敏感平台归一）在插件存储根持跨进程锁，覆盖读取、版本检查、暂存、最终复核和 rename；锁忙立即返回 409 `agents-file-conflict`，不自动重试正文，未知或活进程锁不强夺。此协调不跨 DSH_HOME；外部编辑器仍由最终版本与身份复核保护，但复核到 rename 间存在窗口，不承诺任意写入者的原子 CAS。
- 正文保存不重建模块。策略局部写保留注释、未知字段及另一端最新状态；共享 alias 可能改变未编辑内容时拒绝。
- 过滤只作用于可识别的未来官方消息。关闭不撤回历史，不阻止官方读取，不补预算删掉的正文；未知身份/不可分段保留并诊断。
- instructionHint 在过滤后且有有效模板时转换；空模板保持原文。owner 只报告已观察事实，未观察不捏造“未装配”。

细节与理由见 [ADR-0003](adr/0003-instruction-files-independent.md)、[ADR-0004](adr/0004-official-instruction-filter.md)、[引擎过滤](engine-reuse.md#pre-step-协调器与官方指令过滤)。

## 旧格式与显式转换
新内部上下文、变量、工具和人设字段不双读：world-book/stWorldBook/stWorldBookRecursive/stMacros/stSource、动作局部变量、旧工具能力以及全部顶层 persona、config.yml.personaSources 均在读取根拒绝，需用户手工重建人设规则并移除旧字段。外部 ST 标准别名仍由 adapter 识别。

其它历史快捷参数按共享白名单读取，未登记值不参与执行；旧快捷键写入拒绝。不能因此推断任意旧模块可运行，更不能把被拒绝的本次退役字段当普通未知元数据略过。完整边界以 load/compile/save 的实际错误为准。

旧私有记忆/角色来源标记阻止原生分享与导入；不能删掉标记后发出潜在记忆。先备份并明确拆分私有 memory.md 和可分享规则，再由用户授权转换。未知附件保留，不清理旧用户目录。

<a id="书房数据预览与导入"></a>

## 模块私有数据预览与导入

用户在 Web 或 TUI 执行 `/prompt-tool data-import <JSON>`。目标必须是已安装的用户模块，每次显式传 `moduleId`；来源根由用户选择，`paths` 逐个指定根下普通文件，不递归扫描。以下示例的 `your_module_id` 均替换为实际目标模块 ID。

```text
/prompt-tool data-import {"moduleId":"your_module_id","sourceDirectory":"D:/my-data","paths":["notes.jsonl","rules.md"]}
```

预览返回 `revision` 和 `entries`，每项有目标路径与 `create`、`skip` 或 `conflict` 状态，预览不写盘。确认后保持原请求不变，加上 `"expectedRevision":"<预览返回的 revision>"` 再执行。只创建缺失项；同内容项跳过，冲突项报告并保留目标，不提供隐式覆盖。来源内容、选择范围或整个目标目录在预览后发生变化均拒绝应用，须重新预览。

目标统一落在模块的 `data/`。来源根下的旧名 `02-墨.jsonl` 集中映射为 `data/02-soul.jsonl`；目标已存在旧账本时拒绝生成第二份账本，须先明确处理旧数据。原始来源始终保留。路径越界、链接、非普通文件、非法 UTF-8、单文件超过 8 MiB、总量超过 64 MiB 或条目超过 2048 个均拒绝。

初始化使用 `{"moduleId":"your_module_id","initialize":true}` 选择目标模块 `assets/manifest.yml` 的目录与模板文件，同样先预览再带 `expectedRevision` 应用，不能同时给外部来源。只补缺失，不覆盖已修改模板；不凭空创建清单 `checks` 中的文件，检查通过也不等于初始化完成。`data/AGENTS.md` 是模块私有资产，不是工作区指令文件。

`host/module-data-import.ts` 统一拥有预览与应用；完整候选在现有模块目录事务中生成，锁内复核版本后交换，准备失败保留原目录。默认模块导出仍排除整个 `data/`。这条显式命令不会改变 `module_manifest` 既有的 next/check/apply 语义。check 本身保持只读且实时检查；规则条件 `manifest: { ok: boolean }` 通过 `src/host/module-manifest-check.ts` 单独缓存结果 1000ms，manifest 的 mtime/size 变化提前失效，到期后首次求值完整重检。显式 check 不刷新规则缓存，也不写变量。独立 rule-engine 入口不提供该读取器；三值与入口契约见 [引擎复用](engine-reuse.md#规则条件与动作边界)。

<a id="模块归属与验证"></a>

## 模块数据与能力接口

<a id="soul账本与派生快照"></a>

### 账本、授权与动态上下文

以下接口按目标模块复用，不要求模块 ID 为 `soul`。`soul-ledger`、`soul-maintenance`、`soul_ledger`、`soul_state`、`soul-self` 等是现有能力、工具或内容源标识，保留真实名称。模块声明相应能力后，工具仍须显式定位 `moduleId`；示例 ID 不授予读写权限。

#### 账本读写与收口

`soul-ledger` 提供 `soul_ledger`，每次显式传 `moduleId`。作者和时间由真实会话与宿主生成，不接受覆盖。工具操作如下：

| action | 输入与权限 | 结果与限制 |
|---|---|---|
| `list` | `type`、`limit`；可选 `view: pending/open/pending-review`、`cursor` | 默认 30 条，最多 100 条、64 KiB；游标绑定内容版本与过滤条件；旧 `text` 投影为概要，不改原行 |
| `append` | `type`，`概要` 或旧 `text` 二选一，可选 `ref`／`feel` | lead 经官方 `tools/pre-execute` 审批；promise 仅最后一条 lead 的署名会话可追加 |
| `close` | `targetId/outcome/reason/ref?`；outcome 为 completed/cancelled，reason 非空 | promise 仅当前 lead 可关闭；shelved 原作者或当前 lead 可关闭；同结果幂等，冲突拒绝 |

条目类型为 lead、promise、fact、shelved、gain、loss、persona、container。收口只追加，不改旧行；暂时搁置仍未结。写入按模块锁串行，账本上限 8 MiB、单字段 8 KiB；坏历史、链接、取消或超限均拒绝，不重置账本。

首次合法写入前，在锁内建立 `data/.soul-ledger-v2.json` 的历史分界与逻辑身份；读取不初始化，历史 promise/shelved 标为待核对。条目 `id` 由模块规范路径、逻辑身份和原行内容链派生，追加及同路径正式导入复制不改变旧引用；inode 不作持久身份。模块改名、部署根迁移不保证旧引用，跨模块复制不是同一账本。

通用 `module_file_append` 拒绝向 `data/02-soul.jsonl` 和旧名 `data/02-墨.jsonl` 追加，包括大小写变体。显式数据导入仍须预览，保留来源并报告目标冲突。

close 数据需要账本 v2 读取器；旧版会忽略收口且仍可写入，兼容标记不能保护旧二进制。回滚先撤账本写能力及旧动态上下文、提醒贡献，再退代码；保留全部 close 行，不自动改用户副本、活变量或私有数据。

#### 会话状态与升级

`soul-ledger` 同时挂载 `soul_state`，分别呈现标记、系统活动与快照时刻。操作如下：

| 操作 | 行为与边界 |
|---|---|
| `status` | 读取真实当前会话 |
| `mark` | 写 1–512 字符、最多 2048 字节的短状态；须带 `expectedRevision`，首次为 null；按模块与会话隔离，原子保存，卸载不删除 |
| `check` | 只读报告文件、账本、SELF 候选/投递、索引与维护/恢复证据；unknown/not-observed 不表示通过 |
| `check` + `includeUpgrade: true` | 仅知识库未绑定时可展开完整升级正文；已绑定或授权不可用时拒绝，须走下述真实用户入口 |

受控升级由真实用户执行 `/prompt-tool upgrade {"moduleId":"your_module_id","action":"preview"}`，审阅规则、能力参数和有效正文变化。此入口只处理匹配受支持规则基线的候选，不是任意自定义模块的自动迁移器。确认时改为 `action: "confirm"`，原样带回 `expectedRevision`、`expectedSourceDigest`、`expectedPreviewRevision`。目标、资产或知识库控制状态变化使预览失效；用户修改的正文或不同参数报告冲突，不强覆盖。模型不能代替确认，绑定后的完整升级包也不能经模型工具读取。

确认复用正式安装与重建，保留私有数据、账本、骨架、未知资产，以及知识库授权、项目、记录、学习、持续记忆开关和已消费辅助额度。模块内知识根随受控升级交接目录身份，普通目录替换仍拒绝。状态保存失败恢复原模块与绑定，可重新预览；存储结果或目录恢复无法确认时保留现场及备份，按错误中的路径核对，不重新接入覆盖状态。已持久化但重建失败返回 `publicationPending:true`，修复后重新装配。升级不替代接入、项目选择或持续记忆启用，也不自动更新已有副本或重启 DSH。

mark 的唯一所有者是通用会话键 `soul.mark`，`soul_state` 兼容接口、`module_variables` 与模板共用限长。`recordedAt` 来自该键的宿主更新时间：同值写不刷新，其他键变化不改变 mark 时刻，但会使整表旧 revision 失效。

旧 `data/.soul/state-<hash>.json` 仅由会话变量 owner 在新记录不存在时兼容读取。首次合法会话写将旧 mark 与本次变更一次提交到官方域，保留原件；新记录存在后不再读旧值。旧文件损坏或版本变化则拒绝迁移，不以空表覆盖。运行时与状态工具须接入 owner getter；依赖不可用时拒绝读取，不自行回读旧文件。

#### 知识库授权与持续记忆

知识库默认未接入。以下管理操作只由真实用户执行 `/prompt-tool knowledge <JSON>`，每次显式传 `moduleId`；模型不能代替授权或学习确认。首次预览示例：

```text
/prompt-tool knowledge {"moduleId":"your_module_id","action":"preview","read":[],"write":["general","projects"]}
```

| 用户操作 | 请求与版本 | 行为与失败边界 |
|---|---|---|
| 接入预览、确认 | `preview`；保持请求改为 `confirm`，携预览返回的 `expectedRevision` | 默认目标模块的数据根，可用绝对 `root` 选其他目录或已存在父目录下的新根；`read` 显式列旧文件，`write` 只选 general/projects。预览只读元数据，最多 2000 项、8 层；内容、模块或根身份变化须重预览。仅补缺失目录，不搬迁、覆盖账本、SELF、状态或未知文件 |
| 查询、选择项目 | `status` / `sources`；`project` 携绝对 `projectDirectory` 与当前绑定 `expectedRevision` | status 区分未接入、已绑定、不可用；sources 返回来源、待归类资料和版本。项目绑定实际会话：Git 按真实 common-dir，同仓 worktree 共享，独立克隆不共享；非 Git 按所选目录。后续 cwd 变化不改归属，已绑定会话不静默换项目 |
| 登记旧资料或历史 | `source-preview` 携 read 内 `path`，或 `sessionId` + 明确 `seqs`；指定 `scope: general/project`。保持请求改为 `source-confirm`，携预览的 `expectedRevision` | 旧材料须手选，不自动纳入；版本或来源变化须重预览 |
| 撤销来源授权 | `revoke` 携 `sourceId`、当前绑定版本 | 立即撤权，保留原文；受影响的摘要和学习停止注入 |
| 启停持续记忆 | 先绑定项目，再以 `enable` / `disable` 携当前绑定版本 | enable 从当前会话及新挂载能力的事件界线开始，只处理之后的新材料；disable 停新处理及新闭环学习、自动整理贡献，保留原文、合法查询与审计；重启用只恢复来源仍有效的贡献 |
| 查询、确认学习 | `learning-list`；`learning-confirm` 携学习条目 id 作为 `sourceId`、当前绑定版本 | 显示来源、范围、变更；仅有效候选可确认，core/locked 始终须用户确认，子任务不能确认或管理用户学习 |
| 撤回、忘记学习 | `learning-withdraw` / `learning-forget`，携条目 `sourceId`、当前绑定版本 | 撤回仅恢复此前仍有效的学习；忘记停用目标及后续依赖。保留原始证据和无关学习，不收回已投递文本 |

绑定由官方持久域按来源模块保存，不随导出、复制或导入转移；不可用时不切其他根。接入不自动启动整理、学习或跨项目授权。根重绑须重新选来源，旧引用不复活；搜索与回取都复核本机根、路径、版本及范围，普通文件工具不能绕过授权。

`module_search` 搜索已授权模块资料和历史，支持 `mode: timeline`；`module_open` 按返回的引用重验并回取原文。检索可做全半角、大小写、千分位归一化及模块声明的有界近义匹配，命中标明方式；会话索引仅含公开正文，排除插件注入、推理、流式片段与本插件工具回执，当前回合自动来源的助手/工具输出不参与即时召回，原日志不改写。

持续记忆中，正式账本写入关联真实来源、项目、根用户 MessageId 和稳定条目，原文成功后登记待整理；重试不重复追加。登记失败单独返回 `persisted:true`、`derived.state:"failed"`，恢复只补登记。`soul_state.recording` 分别报告原始成功、待整理和派生失败。子代理只继承派发时的任务范围与根用户输入，父会话后续材料不自动扩权；工具和自动 followup 不成为新用户根。

#### 整理、学习与辅助调用

模型工具使用专用版本，不能拿整理或学习版本代替上述用户授权的绑定版本：

| `soul_state` 操作 | 输入与条件 | 提交边界 |
|---|---|---|
| `consolidate` | `text`、已登记来源或条目的 `refs`，生成前 `knowledge.consolidationRevision` 作为 `expectedRevision` | 至少含一条待整理条目，否则 `no-work`；不额外调用模型。只向授权区域保存不可变正文，关联引用与去重证据根；缺来源、未发布候选、跨项目引用拒绝 |
| `learn` | `text`、`layer: experience/judgment/expression/core/locked`、正式记录 `ref`、当前 `knowledge.learningRevision` 作为 `expectedRevision`；可用 `previous` 替换同层同范围学习 | 工具回执与观察游标不使稳定版本失效，新用户输入、来源、授权或学习变化会失效；短状态不转长期学习 |
| `assist` | 持续记忆已启用且有待整理材料；手动请求立即返回状态，与阶段结束自动请求共用预算；自动请求还要求 `soul-maintenance.enabled: true` | 通过当前会话路由无工具整理，发布仍走版本校验与不可变正文提交；成功与否不阻断普通对话或已授权直接记录 |

整理只在 `published` 后推进 pending。候选已保存而状态提交失败返回 `candidate`，保留原正文和 pending；同正文、引用及预期版本可重验恢复，冲突不覆盖新提交。成功重试不重复写正文或事实。候选不自动检索，也不能借普通来源登记绕过发布；撤权或来源变更立即停用整个受影响正文。

学习用 `basis:"explicit-long-term"` 表达明确长期反馈，宿主核实真实用户、事件版本与长期范围；临时要求、推断或层级不明保留候选，子任务不能冒充用户反馈。推断用 `basis:"inference"`，附 `refs` 与 `assessment:{decision:"adopt"|"candidate",reason,unresolved,counterRefs:[]}`。只有同范围至少两次独立真实用户经历、模型明确采纳且无未解反证才可生效；同源摘要不重复计数，项目经历不晋升通用偏好，core/locked 仍须确认。记录保留引用、证据根与依据，证据撤权或版本变化后停用，审计隐藏失效正文与理由，不自动按时间衰减或删除。

辅助调用保留完整账本结果、原始事件、作者与引用，不混淆用户请求和完成结果。预算参数在 `soul-maintenance.assisted*`，默认限制如下：

| 额度 | 默认与失败行为 |
|---|---|
| 次数 | 每个真实根用户 MessageId，主子合计最多一次；调用前持久预留，失败、取消、重放或恢复不返次数 |
| `assistedInputTarget` / `assistedOutputTokens` | 4096 tokens 是选材目标，不截断完整材料或引用；输入明确标识为估算，预留估算输入与最多 1024 输出 |
| `assistedSessionTokens` / `assistedSessionMs` / `assistedTimeoutMs` | 根会话累计 32768 tokens / 120 秒，单次生成最多 20 秒；可靠 usage 含缓存读写，缺失或失败保留预留，实际超限停后续辅助，估算可能低估 |
| 取消与 `assistedBacklogTurns` | 不占长维护锁；新输入、原生取消、模块释放、授权或来源变化请求取消并拒绝迟到候选，已消费资源不能收回。默认连续三个新用户回合积压集中提示，清空后重置 |

`soul_state` 和用户 `knowledge status` 的 `assistedConsolidation` 分别显示候选/发布、失败原因、预留/实际用量和积压。待整理不代表已生成摘要或已学会。

恢复旧版本前，用户先在绑定项目的会话执行 `disable` 并带当前绑定版本，确认停止新处理；再撤新写能力、SELF 和提醒贡献，等待辅助请求取消后切换版本。保留历史，不静默迁移或回滚新控制格式；账本 v2 的旧二进制风险见前文，不能删除 close 行迁就旧版。

<a id="self-装配与预算"></a>

#### 动态上下文装配与预算

SELF 按知识库绑定状态取材。绑定后，旧资料待归类时暂停旧自动 SELF/提醒，保留骨架并显示待归类；账本 list 仅返回当前获授权的新记录。SELF 使用骨架、当前授权有效学习与真实身份；持续记忆启用时再加最多三条本项目有效未结事项及最近交接，已收口不重开，关闭或撤权立即停贡献，旧账本与快照不复活。启用模板求值的 persona 可用 `{{runtime.get::soul.learning}}` 读取同一投影。

绑定后的默认总预算为 12288 UTF-8 字节，骨架、已确认核心/锁定偏好与真实身份优先，其后按剩余预算放普通学习、当前状态、交接，省略说明也计入预算；受保护核心本身超限则明确失败，原文仍可按授权引用回取。

用户骨架为 `data/SELF.src.md`，诊断快照为 `data/.soul/SELF.md`。未绑定时沿用原 SELF：每步读取当前骨架、账本投影、真实会话身份/时钟和索引最近观测，维护关闭或快照缺失、陈旧不阻断读取。内容版本与历史分界最多重验三次，持续变动则报告不可用。

快照只作诊断或降级，降级须标明来源时间与安全原因，不能冒充当前事实；权限、路径或身份拒绝不能借旧快照绕过。派生与快照复用正文实现，屏蔽已识别凭据后按 UTF-8 字节预算输出，默认 12288 字节；骨架与身份不静默截断，事项提供有界摘要、精确总数和未展示数。

快照经 CAS、临时文件和 rename 保存，发布前重验来源，失败保留旧版。`rule-engine` 内置 `strategy: placeholder, fill: soul-self` 异步装配，模块无需策略 JS；候选渲染和真实投递分别观测。

预算取自模块事实，缓存最长 1000 ms，mtime/size 变化提前更新；读取或校验失败沿用最近有效值，无历史值则回默认。缓存不包含骨架或账本事实。定义暂时损坏不阻断安全只读来源，但仍逐次校验路径、文件种类和可读声明 ID，并限制最终输出。维护与注入共用预算校验，详见 [SELF动态内容与维护心跳](engine-reuse.md#self动态内容与维护心跳)。

#### 恢复额度与索引

`generation-recovery` 额度保存在插件存储根的 `generation-recovery/<会话ID摘要>.json`，保存已消费 turn/step 身份及累计 used；锁内去重后原子替换，重挂与重启不清零，损坏文件拒绝重置。它不进入模块导出，也不修改会话日志。索引是可重建的派生内存状态，原账本与宿主日志仍为权威来源。

#### 实现归属与验证

| 所有者 | 文件 |
|---|---|
| 完整定义/切片 | host/module-slices.ts、module-rules.ts |
| 安装事务 | host/module-install-transaction.ts |
| 模块/全局变量与会话域 | host/module-variables.ts、shared/module-variables.ts；host/session-variables.ts、runtime/module-variable-adapter.ts |
| 模块私有文件 | host/module-files.ts、module-file-path.ts；装配清单 host/module-manifest.ts |
| 导入/导出 | host/import-source.ts、module-package.ts、module-install.ts |
| 装配/人设 | engine/rule-runtime.mjs；runtime/agent-assembly.ts、persona-registration.ts 官方适配 |
| 请求/草稿 | shared/bridge-contract.ts、client/data/、settings-bridge.ts |

随包内置模块只在用户模块根缺失同名目录时补建；已有副本（含用户修改）不覆盖，也不比较内容。见 [ADR-0015](adr/0015-builtin-module-seed-missing-only.md)。

验证以公共接口的注入、写盘、bridge 载荷和安全拒绝行为为准；测试准入与交付检查见仓库规则。
