# 后端参数框架

模块用 `module.yml` 交换完整定义。安装后的运行输入来自经校验的本地提交。写入前确定本次操作的编辑目标。字段以 `engine/rule-spec.mjs` 和 `src/shared/engine-params.ts` 为准，bridge 载荷见 `src/shared/bridge-contract.ts`。

## 按问题查阅

- [规则、共享参数或排序保存后，怎样确认已写盘、重试发布？](subsystems/params-write.md)
- [变量空串会回退吗？模板读取多域后如何提交？](subsystems/variables.md)
- [人设的空值和继承如何生效？](subsystems/params-editors.md#动态人设规则与继承)
- [哪些指令文件可编辑？过滤策略存在哪？](subsystems/params-editors.md#指令文件与逐文件过滤策略)
- [工具定义怎样编辑、校验和注册？](subsystems/params-editors.md#自定义模型工具)
- [旧模块格式怎样显式转换？](subsystems/params-migration.md#旧格式与显式转换)
- [怎样预览并导入模块私有数据？](subsystems/params-migration.md#模块私有数据预览与导入)
- [账本、知识库授权和 SELF 分别由谁负责？](subsystems/params-module-data.md)

## 原生格式与持久状态

| 数据或行为 | 唯一所有者 | 派生面 |
|---|---|---|
| 规则、条件、动作、启停与互斥 | 本地提交的规则切片及状态 | 经校验的规则快照 |
| 共享引擎参数 | 本地清单的 layerSettings | `loadModuleSpec().params` 内部平铺适配 |
| 模块变量 | 本地提交的变量内容 | 运行快照 |
| 全局变量 | `$DSH_HOME/.prompt-tool/variables.yml` 的 variables 映射 | 两级有效值快照，不随模块导出 |
| 会话变量 | 官方 storageDomain 的 `prompt_tool_session_variables` 域 | 按来源模块目录与真实会话隔离，运行有效值优先覆盖模块与全局 |
| 模块记忆 | 当前受控模块 memory.md | 显式工具读取，不自动注入 |
| 模块私有数据 | 当前受控模块 data/（账本、SELF、AGENTS.md 等） | 显式工具读取/追加；不导出，覆盖安装保留 |
| 人设正文与选项 | 规则切片中的 persona 动作 | 按真实受众聚合的官方有效声明 |
| 自定义工具 | customTools | 经验证的内联运行输入 |
| 外部来源事实 | 注入动作 params.source | 导入报告与导出元数据 |
| 模块显示名称 | 本地清单的 name | 模块卡与编辑目标选择；不改变模块 ID 或目录 |

当前格式的决策见 [ADR-0013](adr/0013-native-context-module-state.md)。模块不注册为官方会话预设、不保存会话绑定，不通过 settings 携带规则正文或大文本。

具体卡片和初值由内容来源决定。随包内置模块只在用户模块根缺失同名目录时补建，已有副本不覆盖（[ADR-0015](adr/0015-builtin-module-seed-missing-only.md)）。模块停用再启用会保留逐条启停选择。

## 部署设置与编辑目标

唯一部署开关 `modulesEnabled` 控制模块运行总闸。关闭只撤回贡献，定义、资产与持久变量保留。规则启用成员来自插件存储根 config.yml.enabled，人设动作与其他规则共同参与；排序归模块 configOrder。

启用模块时，以配置锁内读到的最新启用集合为准完成路径及跨模块互斥校验；若另一提交使候选集合冲突，本次启用拒绝且不改写已有合法集合。停用与重复启用保持幂等，配置中的注释及未知字段保留。

读端点与写端点都由请求头 `x-module-id` **定位**目录（服务端只用它解析 `deps.moduleDirectory`；未声明即无目标，`required` 端点 400 `module-dir-unavailable`）。写端点另在本体里带 `expectedModuleId`／`expectedRevisions`，其中 `expectedModuleId` 只作**一致性校验**、不参与定位：与请求头声明不一致即 400 `module-subject-conflict`，与当次解析目录不符即 409 `module-changed`（处理期间目标被换掉）——载荷永远不能替请求头选路径。两条身份判据在任何端点、任何豁免下都执行（见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)）。声明只决定这次读写作用在哪个模块，不改变启用集合或官方预设。官方工具预览的 presetId 保留官方含义。

模型工具的主语由这次调用显式声明的 `moduleId` 参数决定——该 Agent 这次启用了哪几层只作拒绝时的候选提示，绝不作为目标，缺声明即拒绝；工具主语约定见 [ADR-0014](adr/0014-module-subject-declared-per-operation.md)。模板按自身 sourceModuleId 访问变量，与模型工具目标和 UI 卡片归属分开。

## 磁盘格式：规则与共享参数各有所有者

单模块以 `rules/_commit.json` 的原子替换发布一代。安装和结构变更生成完整成员索引。单条正文编辑只登记上一代、目标规则 ID 和新正文摘要，沿用原有 `rules/.objects/`。热保存按 ID 查找目标并复核其版本与模板依赖。冷进程从完整索引重放后续变更；冷读成本随尚未重放的记录数增长。清单保留模块身份、能力及顶层键是否声明。运行时读取记录列出的成员和登记的资产，每条规则正文与共享状态分别校验版本。

当前成员缺失或摘要错误时，可读取完整验证过的上一代。无可验证代时报告模块损坏并撤回新请求贡献。临时文件、名单外文件和链接不会成为运行输入。已有本地提交的模块忽略旧 `module.yml`；把外部完整定义应用到已装模块时使用显式导入。

规则顶层 layer 是注入动作缺省层及展示归属，不建立跨层总顺序。正文和内容策略属于动作，变量属于持久存储。读取叶子可投影稳定身份；映射写入覆盖 then、else、嵌套分支，保持原始条件、未改参数与注释，不写回编译展开或默认值。

候选安装与目录交换见[资产交换](asset-transfer.md#预览与提交)。

## 规则与变量事务

- [规则事务与互斥](subsystems/params-write.md#规则事务与互斥)
- [持久变量事务与模板求值](subsystems/variables.md)

<a id="规则事务与互斥"></a>

规则版本、互斥和冲突恢复见[规则事务与互斥](subsystems/params-write.md#规则事务与互斥)。

<a id="持久变量事务"></a>

变量作用域、版本与空值见[持久变量事务](subsystems/variables.md#持久变量事务)。

<a id="动态人设规则与继承"></a>

正文拼接、继承与替换见[动态人设规则与继承](subsystems/params-editors.md#动态人设规则与继承)。

<a id="共享参数与保存链路"></a>

共享参数的存储层、优先级与空值见[共享参数与保存链路](subsystems/params-write.md#共享参数与保存链路)。

<a id="配置序号与跨模块排序"></a>

跨模块序号、碰号和排序版本见[配置序号与跨模块排序](subsystems/params-write.md#配置序号与跨模块排序)。

<a id="4-持久变量与模板求值"></a>

模板读取、单域写入和执行去重见[模板求值](subsystems/variables.md#模板求值)。

<a id="保存状态机"></a>

磁盘写入和运行发布的应答见[磁盘保存与发布确认](subsystems/params-write.md#磁盘保存与发布确认)，草稿和队列见[保存保护](subsystems/ui-editing.md#保存保护)。

<a id="自定义模型工具"></a>

工具定义、保存与审批见[自定义模型工具](subsystems/params-editors.md#自定义模型工具)。

<a id="指令文件与逐文件过滤策略"></a>

正文权限与过滤范围见[指令文件与逐文件过滤策略](subsystems/params-editors.md#指令文件与逐文件过滤策略)。

<a id="旧格式与显式转换"></a>

旧键拒绝、源文件保留和显式转换见[旧格式与显式转换](subsystems/params-migration.md#旧格式与显式转换)。

<a id="书房数据预览与导入"></a>
<a id="模块私有数据预览与导入"></a>

私有目录预览、冲突与只补缺失见[模块私有数据预览与导入](subsystems/params-migration.md#模块私有数据预览与导入)。

<a id="模块数据与能力接口"></a>
<a id="soul账本与派生快照"></a>
<a id="账本授权与动态上下文"></a>

账本、知识库与派生快照见[账本、授权与动态上下文](subsystems/params-module-data.md#账本授权与动态上下文)。

<a id="self-装配与预算"></a>
<a id="动态上下文装配与预算"></a>

SELF 取材与字节预算见[动态上下文装配与预算](subsystems/params-module-data.md#动态上下文装配与预算)。

<a id="模块归属与验证"></a>
<a id="实现归属与验证"></a>

实现文件与验证边界见[实现归属与验证](subsystems/params-module-data.md#实现归属与验证)。
