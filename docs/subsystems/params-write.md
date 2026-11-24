# 规则与共享参数保存

规则正文、共享参数、模块名称和排序均写入完整定义。先按[编辑目标](../architecture-params.md#部署设置与编辑目标)确定本次模块，再按下文对应版本域提交。变量写入见[持久变量事务](variables.md#持久变量事务)。

## 规则动作的持久化约束

规则的 `executionScope` 缺省为 `agent`，进程级命令规则使用 `process`。规则正文和启停由本地提交保存，随完整定义复制和导出。[宿主控制动作](engine-host-controls.md)

委派额度归 `host-control/delegation-limits` 的 `value`：可选 `maxDepth`（非负安全整数）与 `askTimeout`（1–2147483 秒），至少一项。复用规则数字草稿与版本保存；清空撤销该字段，空对象与非法数字拒绝发布。

### 动作字段与候选校验

委派参数保存在普通规则动作 `subagent-params`，当前只接受 `provider: spawn`、合法工具名 `tool` 与必填非负安全整数 `maxDepth`。0 表示明确禁止委派；空值、负数、小数与非数值均拒绝，撤回贡献通过关闭规则或删除动作表达。数字沿原 RuleParameterFields、fields/hasRuleFields、规则 CAS 与发布，不新增深度草稿或保存端点。`assembly.target.sections.replace` 的名称与完整正文沿原装配表单及规则事务编辑。

阶段条件的 `maxPromoteSteps` 继续按正安全整数校验。普通 `request-params.patch/unset` 沿宿主请求配置生效。旧顶层 `request-params.maxTokens` 在候选校验中拒绝；`persona.instructionsMaxBytes` 保留为旧字段诊断，persona 的其他正文仍生效。已有用户模块保留原文件。

文件读取额度归普通 `host-control/file-read-limits` 动作的 `value`，不进入部署settings或独立参数表。三个可选正安全整数复用原 `RuleParameterFields` 数字原文、错误草稿、版本保存和完整候选校验；清空只撤销该字段，三项全空仍由编译拒绝，不发布为0。标签保持简短，单位及继承说明使用原hint。实际接入边界见[文件读取上限](engine-host-controls.md#文件读取上限)。

结果片段配置归普通规则的 `tool-result/action: edit-text` 动作。`edits` 保存非空数组及每项的 `region/match/text`，空替文表示删除，空匹配在候选校验时拒绝。装配替句的 `match` 可为非空字面候选数组，候选按原文字面匹配。两者沿规则版本检查、切片提交、导入导出和运行发布保存。[工具结果与Web功能段](engine-tools.md#工具结果与web功能段)

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

模块锁内复核目录、候选及所读字段的版本，写入变更的对象后原子替换提交记录。记录切换前失败时，旧代仍可读。切换后规则回执包含 `persisted` 与 `definitionRevision`。工作台通过 `publicationPending`、`publicationError` 和 `effectiveGenerations` 区分保存与运行生效。挂载失败的 Agent 可保留各自上次有效贡献，其余 Agent 可采用新代。桥接重试通过 `refreshOnly` 和 `expectedDefinitionRevision` 核对原代，只重试发布。

跨模块选择逐模块提交；后续成员写入失败时，已保存的目标不回滚，响应仍返回目标当前规则和版本，以及 `persisted:true`、`publicationPending:true`、`publicationError` 和 `activationPending`（本次选择的规则 id）。此时重试须用返回的新版本再次提交该 `activateRuleId`，不重放已保存的正文；目标已经启用也仍完成成员关闭。客户端保留此选择并优先重试保存，成功后才走正常发布；纯运行发布失败才用 `refreshOnly`。不保存恢复日志或选择栈，不承诺跨文件崩溃原子性。

**共享引用守卫（`shared-alias`）**：YAML 的 anchor/alias 会让一次「只改 A」的编辑连带改掉 B，因此每次写事务都必须自证「只改了自己声明的字段」——声明完整候选的路径（规则编辑、存储配置）走 `module-write.ts#serializeWithoutSharedAlias`（序列化失败与候选不一致同判），改-后-比对的路径走 `assertUnownedUnchanged`，`withModuleDefinition` 的调用方必须用必填的 `{ owns }` 声明本次编辑拥有的顶层键。判定不通过一律 400 `shared-alias` 且零写盘，拒绝文案点名被连带改动的键。

## 共享参数与保存链路

`layerSettings.<层>.<键>` 是共享参数唯一磁盘路径。storageLayer 由参数目录固定，UI displayLayer/card 只影响展示。公开目录覆盖主/子模型、PTC 呈现、Git Bash 配置、指令提示和自定义工具审批。完整表与类型直接查 `ENGINE_PARAM_DEFINITIONS`，根 [module.yml](../../module.yml) 由脚本生成参考。运行时注入的资源根和规则/工具文件路径不进入通用编辑字段；规则与工具定义继续使用专用编辑器。

同名键可来自模块本地清单或存储根 `config.yml` 的全局 `layerSettings`。优先级为**模块显式键 ＞ 全局键 ＞ 引擎或行默认**，`false` 与 `0` 也算显式键。合并由 `module-params.ts#resolveModuleParams` 处理。

模型卡的路由/采样在 prepareAssembly 转成两条受众限定的 request-params 合成规则，不写回规则文件。也可显式写 request-params 动作。未配置模型参数继承宿主，不修改全局默认模型。子代理递归深度归宿主官方委派管理（`subagent.maxDepth`），插件不再提供逐模块深度配置。

```text
共享参数草稿 → /param-overrides → saveModuleParams → 完整定义提交
规则草稿 → /rules → editModuleRules → 完整候选校验与提交
两级变量草稿 → /module-variables → editModuleVariables → 单域提交
规则或参数保存 → 验证候选 → 切换本地提交 → 发布给受影响 Agent
变量内容更新 → 发布快照 → 下一求值读取，不重新配装
```

共享参数的空字符串/空列表表示删键，false/0 保留。这个规则不适用于模板变量或规则正文；具名空变量和空正文都合法。只发送已存在或用户修改的参数，不把下拉默认项和能力行默认值固化进定义。

`/param-overrides` 的 `overrides` 只返回模块显式持久键，`effective` 返回白名单内有效参数，包含全局回退及能力组合默认。客户端用有效读数作显示与比较基线，用显式键记录删除语义；未编辑默认值不写盘。声明 `modules` 或 `moduleConfigs` 的模块即使没有 `layerSettings`，也可读取能力默认参数。

PTC 的 `ptcMainMode` 与 `ptcSubagentMode` 分别映射到 `present-as.mainMode/subagentMode`，两页各编辑对应字段；缺省继承该行原有 `mode`。`presentAsEnabled` 是该能力的模块级共享开关；执行器挂载、等待和释放遵循[工具呈现契约](engine-tools.md#工具呈现present-as)。

组合配置优先级为已声明共享参数桥 > moduleConfigs > 行默认。模块目录仅 source/local，官方工具、规划和压缩来自会话原有预设。自定义能力的新增/删除都经服务端白名单与候选验证，不由客户端猜目录或递归清理用户文件。

内容填充的安全边界：`env-facts` 只允许 `env-safety` 的安全环境白名单，白名单外的键在构造期 fail loud；`instruction-hint` 的 `params.file` 只允许指令文件候选名，realpath 必须落在会话 cwd→最近项目根或 DSH_HOME；custom `fs` 执行器用 realpath containment 限定 cwd，symlink/junction 越界拒绝。

## 配置序号与跨模块排序

本地清单的 `configOrder` 保存规则 ID 到非负安全整数的映射，导出仍使用同名字段。身份仍由模块 ID 和规则 ID 组成。同执行点按序排列，启用没有序号的规则追加到尾部。碰号时保留模块内部相对顺序。规则新建沿用现有参与模块的顺序追加策略。跨模块排序逐模块提交。

排序接口提交完整身份集合与版本，包含 UI 过滤隐藏项。排序只改轻量映射，不复制正文、不改变互斥开关。官方 system/context 的 order 与 waterfall 注册顺序保持各自语义，见 [引擎顺序](engine-rules.md#提示词配置插入点与顺序)。

## 模块显示名称

`/module-name` 通过显式 `x-module-id` 读取 `{ name, revision }`，保存接受 `name`、`expectedModuleId`、`expectedRevision`。名称修剪后为 1–128 个字符。写入校验用户可写目录、身份及版本，只修改本地清单的 `name`。过期版本返回 409。每次操作仍由调用方显式提供模块主语。

## 磁盘保存与发布确认

- 普通模块写端点在本地提交后返回 `persisted:true` 并登记运行发布。启用模块先提交排序与启用表，再登记发布。
- 提交前失败返回原错误。磁盘提交后的运行发布失败通过 `publicationPending` 与 `publicationError` 表示。后台运行失败见日志与 `/meta.publicationFailures`。规则端点另返回各 Agent 已生效版本。
- `refreshOnly` 等待真实发布结果，成功才返回 `publicationPending:false`，同版本已生效则跳过重挂。请求保留端点所需的定位身份（id/targetId/expectedModuleId/主语头）；混入写载荷一律返回 400。跨模块互斥的 `activationPending` 例外见[规则事务与互斥](#规则事务与互斥)。
- 客户端发送共享 request/value map，宿主复检类型、大小、目标与版本。草稿、失焦、队列以及收到持久应答后的处理见[保存保护](ui-editing.md#保存保护)，主语载荷见 [bridge 主语策略](ui-bridge.md#模块主语策略)。

后台发布合并、发请求前的 freshness 检查及重挂时序见[引擎装配与发布](engine-assembly.md)。
