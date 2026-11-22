# 规则与共享参数保存

规则正文、共享参数、模块名称和排序均写入完整定义。先按[编辑目标](../architecture-params.md#部署设置与编辑目标)确定本次模块，再按下文对应版本域提交。变量写入见[持久变量事务](variables.md#持久变量事务)。

## 规则动作的持久化约束

回退待办使用 `host-control/session-rewind-todos`，仅接受 `value: true` 且无次数预算。它不隐式启用会话回退；按当前目标 Agent 规则条件生效，复用 rewind bridge 的逐目标失败与重试载荷。待办正文仍归官方 Session 的 `todo/write`，不进入 module.yml 或 settings。

会话回退使用 `host-control/session-rewind`，仅接受 `value: true` 且无次数预算。资格沿当前 Agent 规则受众和条件求值；关闭只阻止后续回退，已提交标记仍有效。bridge `rewind` 的 phase 为 `preview` / `commit` / `retry`，只接会话身份、模式、去重身份、页面凭据及固定边界，不接受模块主语、任意事件范围或子目标列表。

Messages 当前系统正文使用 `host-control/messages-current-system`，仅接受 `value: true`，不接受次数预算或非默认时机。不保存正文副本，不隐式开启 `current-system-snapshot`；依赖诊断为 `host:messages-current-system`。实际接入范围见[宿主控制动作](engine-host-controls.md)。

请求身份首段与系统角色分别使用 `host-control/oauth-identity-prefix`、`host-control/provider-system-role`，唯一值为 `value: true`。两卡独立启停与受众判定，不接受次数预算或 outermost 排序。不保存正文、认证或请求头副本，运行身份只来自已接受工具步骤与实际 prepared adapter call；缺目标诊断分别为 `host:oauth-identity-prefix`、`host:provider-system-role`。

系统段与消息形状容错使用 `host-control/message-shape-guards`，唯一值为 `value: true`，不接受次数预算或 outermost 排序。它与上述动作共用规则启停、受众、分支、版本、复制导出与依赖诊断，不另建保存通道。

每步当前系统正文使用 `host-control/current-system-snapshot`，唯一值为 `value: true`，不接受次数预算或 outermost 排序。正文仍归 inject-text / persona 声明，不复制或持久化第二份正文。

process 规则另支持 `command-confine-passthrough: true`：每模块发布一次，仅影响后续命令 confine 调用，与构造软默认独立；不接受 Agent 私有条件。

规则正文的 `executionScope: agent | process` 省略时为 agent，沿完整定义、切片与复制导出保存，启停投影在 `_settings.yml`。process 规则只接受支持的无条件构造软默认及上述命令穿透，不接受 Agent 私有条件；作用时机与新会话继承见[宿主控制动作](engine-host-controls.md)。

委派额度归 `host-control/delegation-limits` 的 `value`：可选 `maxDepth`（非负安全整数）与 `askTimeout`（1–2147483 秒），至少一项。复用规则数字草稿与版本保存；清空撤销该字段，空对象与非法数字拒绝发布。

### 动作字段与候选校验

人设动作预算 `instructionsMaxBytes` 仍归module.yml普通规则，合法值为正安全整数。工作台直接复用RuleParameterFields数字原文、fields错误草稿、hasRuleFields保存阻断和原rule-drafts/CAS；切回继承清除此字段的原草稿，不创建独立预算保存。参考初值65536不限制用户采用其他合法值。

委派参数保存在普通规则动作 `subagent-params`，当前只接受 `provider: spawn`、合法工具名 `tool` 与必填非负安全整数 `maxDepth`。0 表示明确禁止委派；空值、负数、小数与非数值均拒绝，撤回贡献通过关闭规则或删除动作表达。数字沿原 RuleParameterFields、fields/hasRuleFields、规则 CAS 与发布，不新增深度草稿或保存端点。`assembly.target.sections.replace` 的名称与完整正文沿原装配表单及规则事务编辑。

显式瞬时额度 `request-params.maxTokens` 与 `phase.maxPromoteSteps` 沿数字原文草稿和规则事务保存，合法范围均为正安全整数。非法或未完成原文不发保存请求，折叠保留草稿。该额度与同动作的patch/unset.maxTokens及replace互斥；原有patch组合不迁移。`pre-step-filter.instructionHint` 是普通规则中的可编辑完整模板。请求额度运行接缝和指令字节预算分别取资格，详见[宿主控制动作](engine-host-controls.md)。

文件读取额度归普通 `host-control/file-read-limits` 动作的 `value`，不进入部署settings或独立参数表。三个可选正安全整数复用原 `RuleParameterFields` 数字原文、错误草稿、版本保存和完整候选校验；清空只撤销该字段，三项全空仍由编译拒绝，不发布为0。标签保持简短，单位及继承说明使用原hint。实际接入边界见[文件读取上限](engine-host-controls.md#文件读取上限)。

结果片段配置归 `module.yml.rules` 的普通 `tool-result/action: edit-text` 动作，`edits` 保存非空数组及每项的 `region/match/text`；空替文为有效删除，空匹配由完整候选校验拒绝。装配替句的 `match` 可为非空字面候选数组，候选仍按明确原文匹配，不转换为正则或逗号拼接。两者沿原规则CAS、YAML Document、切片、导入导出与发布链保存，没有独立结果配置文件或保存端点；运行支持边界见[工具结果与Web功能段](engine-tools.md#工具结果与web功能段)。

## 规则事务与互斥

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

## 共享参数与保存链路

`layerSettings.<层>.<键>` 是共享参数唯一磁盘路径。storageLayer 由参数目录固定，UI displayLayer/card 只影响展示。公开目录覆盖主/子模型、PTC 呈现、Git Bash 配置、指令提示和自定义工具审批。完整表与类型直接查 `ENGINE_PARAM_DEFINITIONS`，根 [module.yml](../../module.yml) 由脚本生成参考。运行时注入的资源根和规则/工具文件路径不进入通用编辑字段；规则与工具定义继续使用专用编辑器。

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

PTC 的 `ptcMainMode` 与 `ptcSubagentMode` 分别映射到 `present-as.mainMode/subagentMode`，两页各编辑对应字段；缺省继承该行原有 `mode`。`presentAsEnabled` 是该能力的模块级共享开关；执行器挂载、等待和释放遵循[工具呈现契约](engine-tools.md#工具呈现present-as)。

组合配置优先级为已声明共享参数桥 > moduleConfigs > 行默认。模块目录仅 source/local，官方工具、规划和压缩来自会话原有预设。自定义能力的新增/删除都经服务端白名单与候选验证，不由客户端猜目录或递归清理用户文件。

内容填充的安全边界：`env-facts` 只允许 `env-safety` 的安全环境白名单，白名单外的键在构造期 fail loud；`instruction-hint` 的 `params.file` 只允许指令文件候选名，realpath 必须落在会话 cwd→最近项目根或 DSH_HOME；custom `fs` 执行器用 realpath containment 限定 cwd，symlink/junction 越界拒绝。

## 配置序号与跨模块排序

module.yml.configOrder 保存规则id→非负安全整数，身份仍是模块id+规则id。同执行点按序排列，启用没有序号的规则追加到尾部；碰号时保留该模块内部相对顺序整体追加。规则事务新建卡时也读其他启用模块的序号，直接接在全局尾部；尾部算法只在 `src/shared/module-config-order.ts#nextConfigSequence` 一份（切片恢复只传本模块）。重复启用无冲突不改顺序。

排序接口提交完整身份集合与版本，包含 UI 过滤隐藏项。排序只改轻量映射，不复制正文、不改变互斥开关。官方 system/context 的 order 与 waterfall 注册顺序保持各自语义，见 [引擎顺序](engine-rules.md#提示词配置插入点与顺序)。

## 模块显示名称

`/module-name` 通过显式 `x-module-id` 读取 `{ name, revision }`；保存仅接受 `name`、`expectedModuleId`、`expectedRevision`，名称修剪后为 1–128 个字符。写入先校验用户可写目录、身份和完整定义版本，再用 YAML Document 与既有原子提交只修改 `name`，保留注释、未知字段与规则。过期版本返回 409；普通保存只确认 `persisted` 并登记后台发布，切片发布失败仍返回 `publicationPending` 与 `publicationError`，不伪报未写盘。模块显示名称不代表默认主语，空白创建名为“默认模块”也不会建立隐式写入目标。

## 磁盘保存与发布确认

- 普通模块写端点确认写盘和切片验证后返回 200 + `persisted:true`。Agent 后台发布独立进行，应答省略 `publicationPending:false`。启用模块先提交排序与启用表，再登记一次发布。
- 磁盘提交后切片发布失败，返回 200 + `persisted:true` + `publicationPending:true` + `publicationError`。提交前失败返回原错误。后台运行失败见日志与 `/meta.publicationFailures`，工作台的 `moduleWarnings` 和草稿错误不显示这类失败。
- `refreshOnly` 等待真实发布结果，成功才返回 `publicationPending:false`，同版本已生效则跳过重挂。请求保留端点所需的定位身份（id/targetId/expectedModuleId/主语头）；混入写载荷一律返回 400。跨模块互斥的 `activationPending` 例外见[规则事务与互斥](#规则事务与互斥)。
- 客户端发送共享 request/value map，宿主复检类型、大小、目标与版本。草稿、失焦、队列以及收到持久应答后的处理见[保存保护](ui-editing.md#保存保护)，主语载荷见 [bridge 主语策略](ui-bridge.md#模块主语策略)。

后台发布合并、发请求前的 freshness 检查及重挂时序见[引擎装配与发布](engine-assembly.md)。
