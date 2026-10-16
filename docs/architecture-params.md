# 后端参数框架

本页说明模块定义、持久变量、人设、版本事务与保存边界。规则语义以 `engine/rule-spec.mjs` 为准，共享参数以 `src/shared/engine-params.ts` 为准，bridge 以 `src/shared/bridge-contract.ts` 为准；文档不建立第二份字段校验器。

## 原生格式与持久状态

| 数据或行为 | 唯一所有者 | 派生面 |
|---|---|---|
| 规则、条件、动作、启停与互斥 | module.yml.rules | 经校验的规则切片 |
| 共享引擎参数 | module.yml.layerSettings | `loadModuleSpec().params` 内部平铺适配 |
| 模块变量 | module.yml.variables | rules/variables.yml 与运行快照 |
| 全局变量 | `$DSH_HOME/.prompt-tool/variables.yml` 的 variables 映射 | 两级有效值快照，不随模块导出 |
| 模块记忆 | 当前受控模块 memory.md | 显式工具读取，不自动注入 |
| 人设正文与选项 | 各模块 module.yml.persona.main / persona.subagent | rules/_settings.yml 的校验投影与官方有效声明 |
| 人设来源选择 | config.yml.personaSources | main/subagent 各选一个模块 ID 或官方默认，不存正文 |
| 自定义工具 | customTools | 经验证的内联运行输入 |
| 外部来源事实 | 注入动作 params.source | 导入报告与导出元数据 |
| 模块显示名称 | module.yml.name | 模块卡、目标选择与人设来源目录；不改变模块 ID 或目录 |

当前格式的决策见 [ADR-0013](adr/0013-native-context-module-state.md)。模块不注册为官方会话预设、不保存会话绑定，不通过 settings 携带规则正文或大文本。

`/module-name` 通过显式 `x-module-id` 读取 `{ name, revision }`；保存仅接受 `name`、`expectedModuleId`、`expectedRevision`，名称修剪后为 1–128 个字符。写入先校验用户可写目录、身份和完整定义版本，再用 YAML Document 与既有原子提交只修改 `name`，保留注释、未知字段与规则。过期版本返回 409；已保存但刷新失败返回 `persisted` 与 `publicationError`，不伪报保存失败。模块显示名称不代表默认主语，空白创建名为“默认模块”也不会建立隐式写入目标。

## 部署设置与编辑目标

唯一部署开关 `modulesEnabled` 控制模块运行总闸。关闭只撤回贡献，定义、资产与持久变量保留。规则启用成员来自插件存储根 config.yml.enabled；人设来源来自独立的 config.yml.personaSources，主/子各自单选且默认官方。选择人设不改变 enabled；排序另归模块 configOrder。

读端点与写端点都由请求头 `x-module-id` **定位**目录（服务端只用它解析 `deps.moduleDirectory`；未声明即无目标，`required` 端点 400 `module-dir-unavailable`）。写端点另在本体里带 `expectedModuleId`／`expectedRevisions`，其中 `expectedModuleId` 只作**一致性校验**、不参与定位：与请求头声明不一致即 400 `module-subject-conflict`，与当次解析目录不符即 409 `module-changed`（处理期间目标被换掉）——载荷永远不能替请求头选路径。两条身份判据在任何端点、任何豁免下都执行（见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)）。声明只决定这次读写作用在哪个模块，不改变启用集合或官方预设。官方工具预览的 presetId 保留官方含义。

模型工具用执行 Agent 的受控配装记录解析写入目标——该记录只含**已启用的规则模块**，人设来源由 personaSources 独立引用、可以指向未启用的模块，因此不参与写入目标；缺声明即无目标（模块类端点拒绝），启用表不再决定写入目标（阶段 4 把工具主语改为工具参数，见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)）。模板按自身 sourceModuleId 访问变量，与模型工具目标和 UI 卡片归属分开。

## 磁盘格式：规则与共享参数各有所有者

module.yml 是完整定义、唯一提交点和恢复依据，支持直接手改。rules/ 是物化投影：

- `<ruleId>.yml`：id/name/layer/if/then/else 正文。
- `_settings.yml`：规则启停、group、exclusive、order、模块变量开关、人设校验投影与完整性元数据。人设正文的唯一真值仍为 module.yml，不能编辑投影反写。
- `variables.yml`：模块变量投影。

读取只认清单内切片，名单外备份、同步副本等由用户拥有，不读、不改、不删。清单内缺失或失配从有效完整定义单向恢复；完整定义非法则报错，不能用切片反向修复。规则文件名拒绝保留名、大小写冲突、设备名和路径字符。

普通重建在原目录恢复切片，保留记忆和未知资产；导入才在隔离候选中完整生成并交换目录。模块生产路径不生成 configs/、rules.yml、agent.cordis.yml 或第二套工具/策略目录。

规则顶层 layer 是注入动作缺省层及展示归属，不建立跨层总顺序。正文和内容策略属于动作，变量属于持久存储。读取叶子可投影稳定身份；映射写入覆盖 then、else、嵌套分支，保持原始条件、未改参数与注释，不写回编译展开或默认值。

## 规则与变量事务

### 规则事务与互斥

`readModuleRules` 返回完整原始规则和 `revisions: { rules, settings, variables }`。`editModuleRules`、`/rules`、TUI 与模型工具统一携带 `expectedRevisions`，规则接口不再接受整文档 expectedRevision。其它领域的字节版本不因此删除。

| 操作 | 版本与载荷 |
|---|---|
| 编辑正文 | 目标规则 revision；提交完整 rule，保留未改字段 |
| 修改启停/group/exclusive | `settingsChanged: true` 并校验 settings |
| 新增/删除/改名 | 同时校验 settings；改名/删除同步 configOrder |
| 启用互斥卡 | `activateRuleId`，同一次事务关闭组内其他卡 |
| 删除整规则 | `rule: null`；工具不会根据删除叶子推断删除父规则 |
| 仅校验 | `validateOnly: true`，完整候选编译且不写盘 |

同模块同名非空 group 中任一卡 exclusive:true，整组最多一条启用。多启用候选拒绝，不按排序挑赢家。正文保存不覆盖并发状态。非法条件、重复动作身份、越权目录、失效版本都在提交前拒绝。

每次事务使用 YAML Document 保留注释和未知元数据，提交前复核版本与目录。模块锁序列化保存和恢复；正文/变量切片先准备，module.yml 原子替换为提交点，再发布清单。多文件替换不宣称物理同时原子。提交前失败恢复旧投影；提交后发布失败返回 `persisted`、新版本和 publicationError，保留最后有效运行贡献。

**共享引用守卫（`shared-alias`）**：YAML 的 anchor/alias 会让一次「只改 A」的编辑连带改掉 B，因此每次写事务都必须自证「只改了自己声明的字段」——声明完整候选的路径（规则编辑、人设保存、存储配置）走 `module-storage.ts#serializeWithoutSharedAlias`（序列化失败与候选不一致同判），改-后-比对的路径走 `assertUnownedUnchanged`，`withModuleDefinition` 的调用方必须用必填的 `{ owns }` 声明本次编辑拥有的顶层键。判定不通过一律 400 `shared-alias` 且零写盘，拒绝文案点名被连带改动的键。

### 两级变量事务

变量是扁平字符串。module 覆盖 global；模块值 `''` 是有效覆盖，删除模块键才回落全局。global 只在同一 DSH_HOME 共享；不同安装隔离。`variables` 与共享参数允许同名但互不清理。

`readModuleVariables` 返回 `{ module, global, effective, revisions, enabled }`；版本域是 global、module、settings。全局文件缺失为空且 revision:null，损坏 YAML、非法 UTF-8、链接或读取错误必须报告，不能当成空表覆盖。模块值仍通过完整定义事务提交。

`editModuleVariables` 每次只写一个 scope，支持完整 values 或局部 changes，二者不混用。changes 中 null 删除，字符串（包括空串）写入。更新内容要求目标域 revision，开关要求 settings；模板额外校验所有实际读取域。锁顺序固定全局→模块，单域原子提交，不创建跨文件 journal。

例如 module.inc 从 global=10 回落计算11，提交前也须核对 global revision；不能仅校验模块版本。变量名拒绝原型键、保留名及非法空白，值/总量有界；具体上限由存储校验器拥有。

`/module-variables` 接受 scope、完整 variables、enabled、expectedModuleId、expectedRevisions。工具 `module_variables` 提供 list/get/set/delete；set 必须显式字符串 value，delete 只删除指定域键。全局写同样需要实际装配工具权限和受控目标。

值更新发布新快照，不重挂 Agent；新增键和不同模块同名键按来源动态读取。变量开关只控制该模块求值和模板写入，不关闭其它模块，也不删除持久值。发布失败只重试 `refreshOnly`，不重放内容写入。

## 独立人设卡与继承

```yaml
persona:
  main:
    prefix: 你是项目助手。
    complete: false
  subagent:
    suffix: 返回可核验的结果。
```

每个模块可定义主/子受众的 prefix、suffix、complete、includeRuntimeContext。独立人设卡为两类受众各提供一个来源下拉，默认官方，也可分别选模块；同一受众在状态中只有一个来源。所选模块缺少对应目标或字段时继承官方，prefix/suffix 的空串清空对应段，删除键恢复继承；complete 的 false 解除人设独占，true 只标记目标 prefix。includeRuntimeContext:false 额外抑制运行上下文，true 不撤销宿主的抑制。

config.yml 只保存来源引用，不复制人设正文：

```yaml
personaSources:
  main: project-persona
  subagent: null
```

null 或未配置表示官方默认。选择 project-persona 不自动启用它的 rules；模块规则启用和人设来源是两个独立状态。运行时由 `selectedPersonaModules(root)` 读取所选模块的对应受众字段，不遍历启用模块合并人设，也不按排序补齐字段。

所选来源缺失或定义无效时拒绝发布并保留上次有效配装；运行读取从完整定义补建或恢复人设投影。删除仍被任一受众选择的模块会被拒绝，须先切换该受众来源。

正文不进入 rules 数组或 configOrder，`rules/_settings.yml` 仅含可恢复投影。`/persona` 返回正文与完整定义字节 revision，保存携带 expectedRevision；来源选择由 `/persona-sources` 及独立来源版本处理。两类请求都保留并发草稿，不以切换来源覆盖未提交正文。

单选避免了同受众多模块字段合并，但没有取消 complete 冲突检查：装配仍在撤旧之前预检人设与同受众规则的独占声明，冲突时保留上次有效配装。人设与规则是同一次装配的贡献，不存在「人设已更新、规则停在部分成功」的中间态。

规则独占按 main/subagent 分别校验，互不重叠的两类独占允许共存；官方人设只与当前受众生效的规则比较。受众限定规则的 complete 与上下文抑制在注册前筛选，不能仅把非目标受众正文置空。

会话运行期由装配通道在每个 Agent 自己的 scope 注册 prefix/suffix 同名段，不改变官方服务启动依赖，也不重载任何官方 fiber。AgentSetup 窗口内注册的同层声明被接住并撤换；窗口外的同层声明撤不掉时装配失败保旧。自定义正文使用所属模块的两级变量与原生模板，继承的官方文本不重复执行。生命周期边界见 [引擎接线](engine-reuse.md#执行状态与接入)。更改代码或 patch 后需用户重启 DSH。

## 共享参数与保存链路

`layerSettings.<层>.<键>` 是共享参数唯一磁盘路径。storageLayer 由参数目录固定，UI displayLayer/card 只影响展示。公开目录目前有13个键：主/子模型各5个，以及 instructionHint、toolGitBashEnabled、customToolRequireApproval。完整表与类型直接查 `ENGINE_PARAM_DEFINITIONS`，根 [module.yml](../module.yml) 由脚本生成参考。

同名键在两处存在：模块自己的 `module.yml`（模块层）与存储根 `config.yml` 的 `layerSettings`（**全局层**，固定卡指令卡的设置区写它）。有效值优先级是**模块显式键 ＞ 全局键 ＞ 引擎/行默认**——存在即覆盖，`false`/`0` 也算显式；判据与合并只在 `module-params.ts#resolveModuleParams` 一处，客户端与端点都不重复判。模块没有该键时回退全局值，因此全局开关对未声明它的模块同样生效。

模型卡的路由/采样在 prepareAssembly 转成两条受众限定的 request-params 合成规则，不写回规则文件。也可显式写 request-params 动作。未配置模型参数继承宿主，不修改全局默认模型。子代理递归深度归宿主官方委派管理（`subagent.maxDepth`），插件不再提供逐模块深度配置。

```text
共享参数草稿 → /param-overrides → saveModuleParams → 完整定义提交
规则草稿 → /rules → editModuleRules → 完整候选校验与提交
两级变量草稿 → /module-variables → editModuleVariables → 单域提交
规则/参数保存 → ensureModuleReady → 刷新受影响 Agent
变量内容更新 → 发布快照 → 下一求值读取，不重新配装
```

共享参数的空字符串/空列表表示删键，false/0 保留。这个规则不适用于模板变量或规则正文；具名空变量和空正文都合法。只发送已存在或用户修改的参数，不把下拉默认项和能力行默认值固化进定义。

组合配置优先级为已声明共享参数桥 > moduleConfigs > 行默认。模块目录仅 source/local，官方工具、规划和压缩来自会话原有预设。自定义能力的新增/删除都经服务端白名单与候选验证，不由客户端猜目录或递归清理用户文件。

## 配置序号与跨模块排序

module.yml.configOrder 保存规则id→非负安全整数，身份仍是模块id+规则id。同执行点按序排列，启用没有序号的规则追加到尾部；碰号时保留该模块内部相对顺序整体追加。重复启用无冲突不改顺序。

排序接口提交完整身份集合与版本，包含 UI 过滤隐藏项。排序只改轻量映射，不复制正文、不改变互斥开关。官方 system/context 的 order 与 waterfall 注册顺序保持各自语义，见 [引擎顺序](engine-reuse.md#提示词配置插入点与顺序)。

## 4. 持久变量与模板求值

普通规则只引用作者已建立的变量，不自动扫描创建；工作台变量卡手动添加空占位。ST 导入是自动登记的独立入口：正文/触发键的缺失裸引用登记为 `''`，不猜测业务值。原动作 config.variables 已退役，无冲突值可在显式转换时提升到模块 variables；同名不同值必须先解决。

`params.templateEvaluation: true` 启用原生 module/global 的 set/get/add/inc/dec。set/add 不输出，inc/dec 输出结果；裸引用模块优先，显式 global 只访问全局。带非空默认值的 get 保留缺值写回扩展。

求值先得到正文和变更集，同卡读取看到暂存写入。一张模板可读两域但只写一域；双域赋值、非法解析、循环、保留名、原型键或展开预算错误整卡零提交。扫描/预览只读，不能执行赋值。输入/输出和嵌套工作量有界。

真实执行先判规则及动作资格。执行帧按运行 Agent、取消信号、turn/step 边界识别，assembly→pre-step→同执行重挂只提交一次；版本改变不触发同执行重放。成功前可有界重试当前卡且保留随机样本；提交后发布失败只重试发布。跨卡不承诺原子，跨进程任意崩溃不承诺 exactly-once。

同模块的主/子会话共享持久值，结束会话、压缩、卸载或重挂不清空。普通前后缀不改变 pick 的稳定选择；运行事实仍从会话读取。未知引用的出口清洗不创建变量，具名空值则直接替换为空。

## 保存状态机

本地内容编辑采用自动保存：文本输入停顿后提交，开关与选项立即提交；不合法的数字、JSON 或未完成输入保留为草稿，修正后再保存。发送消息不等待草稿提交，运行只读取磁盘已保存的有效内容。各官方入口的注册与更新时机见 [引擎接线](engine-reuse.md)。

1. 参数、规则和能力操作进入模块保存队列，队列内完成写入与读回。
2. 入队即固定请求快照，成功只确认该快照；请求期间的新输入继续保持 dirty。
3. 切模块先处理未存草稿并等待队列，迟到响应只能更新原目标草稿。
4. 变量草稿按模块+scope 隔离，内容和开关分别保留版本；CAS 失败保留编辑。
5. 已持久化但发布失败显示实际状态，重试只刷新；不重复导入、改名或自增。

空键行属于 UI 草稿，保存载荷不发空键；保存或后台读取不因空行清理用户输入。UI 只在对应草稿版本仍一致时刷新。客户端使用共享 request/value map，服务端仍完整复检类型、大小、目标与版本。

## 自定义模型工具

customTools 独立于规则/变量。`compileCustomTool` 使用官方 DSL 转换再交 `tool-definition.mjs` 校验；身份、Schema、执行器和输出都在保存/装配前检查。保存保留作者 DSL，运行内联编译工具，不另写工具产物目录。

支持 shell/http/delegate/fs/ask-user；delegate 通过官方工具调度保留批准与拒绝。customToolRequireApproval 只接受实际执行器名称。大文本、秘密与 token 不放 settings；shell 环境沿白名单处理。工具卡的参数行编辑不得丢嵌套 properties/items/oneOf/enum。

## 指令文件与逐文件过滤策略

AGENTS.md/CLAUDE.md 及 local 变体属于用户文件。正文就地保存；显示名和后续注入开关属于独立 `$DSH_HOME/.prompt-tool/instructions.yml`。两者不写入 module.yml、settings、生成目录或模板变量。

- 文件卡探测 `$DSH_HOME/AGENTS.md` 与当前会话 cwd 到项目根链的候选。真实路径命中授权范围且为普通文件才可编辑；部署 cwd 回退只是范围提示，不等于会话写授权。
- 保存要求 fileId/contextId 白名单及 expectedRevision 字节版本。不存在、越界、过期、超限或读取失败明确拒绝；临时文件+rename 替换目标本身并保留权限。
- 正文保存不重建模块。策略局部写保留注释、未知字段及另一端最新状态；共享 alias 可能改变未编辑内容时拒绝。
- 过滤只作用于可识别的未来官方消息。关闭不撤回历史，不阻止官方读取，不补预算删掉的正文；未知身份/不可分段保留并诊断。
- instructionHint 在过滤后且有有效模板时转换；空模板保持原文。owner 只报告已观察事实，未观察不捏造“未装配”。

细节与理由见 [ADR-0003](adr/0003-instruction-files-independent.md)、[ADR-0004](adr/0004-official-instruction-filter.md)、[引擎过滤](engine-reuse.md#pre-step-协调器与官方指令过滤)。

## 旧格式与显式转换
新内部上下文、变量、工具和人设字段不双读：world-book/stWorldBook/stWorldBookRecursive/stMacros/stSource、动作局部变量、旧工具能力和扁平 persona 均需明确转换。外部 ST 标准别名仍由 adapter 识别。

其它历史快捷参数按共享白名单读取，未登记值不参与执行；旧快捷键写入拒绝。不能因此推断任意旧模块可运行，更不能把被拒绝的本次退役字段当普通未知元数据略过。完整边界以 load/compile/save 的实际错误为准。

旧私有记忆/角色来源标记阻止原生分享与导入；不能删掉标记后发出潜在记忆。先备份并明确拆分私有 memory.md 和可分享规则，再由用户授权转换。未知附件保留，不清理旧用户目录。

## 模块归属与验证

| 所有者 | 文件 |
|---|---|
| 完整定义/切片 | host/module-storage.ts、module-rules.ts |
| 两级变量 | host/module-variables.ts、shared/module-variables.ts |
| 模块合并/记忆 | host/characters.ts、module-memory.ts |
| 导入/导出 | host/import-source.ts、module-package.ts、module-install.ts |
| 装配/人设 | runtime/agent-assembly.ts、persona-registration.ts；host 来源 owner 的 selectedPersonaModules |
| 请求/草稿 | shared/bridge-contract.ts、client/data/、settings-bridge.ts |

长期测试只进入注入行为、写盘语义、bridge 载荷、安全拒绝 seam，期望来自独立规格/字面样例，断言公共接口。提交前跑完整 package gates，涉及宿主/包接入补对应验证；一次性探针放隔离临时目录，不能用仅检查旧符号消失的测试替代行为验收。
