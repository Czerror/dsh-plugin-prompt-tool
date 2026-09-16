# SillyTavern 转换可靠性与可诊断性改进计划

- 日期：2026-09-16。
- 状态：用户已要求按本计划执行；执行 Wave 1（ST-01/ST-02）已实施并通过门禁，Wave 2–3 按依赖顺序推进；任务状态见第 7 节。
- 本轮授权：实施本计划第 7 节的核心任务（ST-01–ST-06），不扩大到第 1.3 节不做清单。
- 本仓库分析基线：`dev@0ea927f71458e22915ce25242c927b228f9c53b7`。
- 对比项目：本地 `D:\AI\GitHub\dsh-tavern`，基线 `73573a2e7ecfeacb57289e69a98c23cb14db6969`；不是对其远端最新版本的声明。
- 目标：借鉴 dsh-tavern 的字段归一、转换报告、来源追踪和可解释筛选，提升现有注入引擎的导入可靠性，不移植整个酒馆运行时。
- [旧计划归档](.scratch/prompt-tool-framework/archive/plan-agents-files-20260914-archived-20260916.md)：保留原文供历史核对，不再作为当前任务入口。归档内相对引用按原文件位于仓库根目录时解释，不作为本计划的现行契约。

## 0. 项目启动与执行规范来源

### 0.1 项目启动信息

- **项目名称/类型**：dsh-plugin-prompt-tool；现有 DeepSeek Harness 插件的定向改进，不是新建酒馆应用。
- **初始需求**：对比 dsh-tavern 的酒馆能力，尤其后端参数转换与实现；完整保存建议，归档过期 PLAN，并按用户指定 dev-expert 的任务拆解与执行规范形成可执行计划。
- **本轮交付**：根 PLAN.md 与旧计划原文归档；只写文档，不实现以下业务任务。
- **技术栈/运行环境**：现有 TypeScript、Node.js ESM、Cordis/DSH 公开服务、YAML Document API、React 工作台、pnpm 与 Node 内置 test runner；shell 固定 PowerShell 7，测试 cwd 固定隔离目录。
- **输入/输出**：ST 预设 JSON、角色卡 PNG/JSON、内嵌/独立世界书 → 现有 PresetSpec、promptConfigs 与预设物化；新增报告仅作可观测结果，不是新的预设所有者。
- **使用者与入口**：用户通过预设/角色导入入口操作；host 负责转换、bridge 负责受控传输、client 展示、engine 执行。
- **是否存在终极功能**：是，但仅在用户后续授权的核心改进范围内实施，不包含完全 ST 兼容。
- **终极功能定义**：受支持来源字段在实际注入中保持既定语义，每项有损转换和世界书筛选结果可追溯，且默认行为、数据所有权与安全边界不变；以第 9 节验收，不以“功能已写”计完成。
- **默认循环轮次/安全最大轮次**：3 / 6；同一诊断方向连续失败 3 次立即停下分析，不借安全上限继续相同尝试。
- **每轮最大改动点数**：3；单个任务建议不超过约 200 行业务代码，超过时先重拆任务和依赖，不把多个未验收能力混成一次提交。
- **角色配置**：主执行者承担需求理解、架构、实现和测试复核职责。本轮不启用子代理；未来只有明确授权后才考虑互斥写区的并行任务。
- **交付约束**：本轮 2 个版本化文档；本地 daily.md 仅作忽略的修改记忆，不产生第二份任务状态文件。

### 0.2 本次采用的技能规范

用户指定来源为 `D:\AI\CC-switch\skills\dev-expert\SKILL.md`，读取版本 `1.12.0`，不是仅引用默认技能目录的同名文件。
本计划采用该目录下：

- `references/software-project.md`：先明确插件边界、输入输出、模块所有权、验证、发布与回滚。
- `references/task-decomposition-and-execution.md`：2–7 个核心原子任务、每执行 Wave 2–5 个，XML 任务卡、依赖与写区冲突、任务摘要和失败回退。
- `references/execution-safety.md`：PLAN-GATE、实码确认、审计与修复分离、安全自审及同方向失败计数。
- `references/delivery-assurance.md`：证据类型、执行率自检、未验证项披露和收尾格式。

遵循六步闭环：分析（第 1–3 节）→ 方案（第 3–6 节）→ 执行（第 7 节）→ 验证（第 9 节）→ 交付（第 11 节）→ 复盘（任务摘要与本地 daily.md）。
仓库规则继续决定文件编辑入口、测试 cwd、运行服务保护、记忆落位和 Git 范围；不机械生成技能模板中的数据库、图谱、session_memory 或后台队列。

### 0.3 架构取舍与撤销条件

| 决策 | 选项与代价 | 推荐及反选理由 | 重新评审条件 |
|---|---|---|---|
| 修字段归一还是重写导入器 | 局部补别名影响小；新转换框架能统一更多输入但扩大迁移和双轨风险 | 修现有共同入口，证据只有 F1/F2，不为两个字段重写框架 | 多个真实格式持续出现相同归一缺陷，局部方案已无法保持单一来源 |
| 增加报告还是新增转换稿资源库 | 报告直接解释当前结果；资源库增加状态、同步和持久化所有者 | 报告作为派生结果，不再造可编辑预设实体 | 用户明确需要独立资源生命周期并接受数据模型变化 |
| 插入点注入还是整份请求重建 | 注入沿用宿主生命周期；请求重建可表达更多 ST 历史语义但改变产品边界 | 保留官方插入点并标注降级，不搬兼容运行时 | 用户另行提出完整兼容产品目标并批准独立设计 |

模块方向保持 `client → shared bridge 契约 → host 转换/物化 → engine 消费`；shared 只定义契约，不反向调用 UI 或磁盘实现。报告/诊断读取不拥有第二份行为状态。
当前只规划既有有界导入与诊断，不新增批量作业或后台队列。若后续需求明确超过 100 条处理或实测操作超过 3 秒，应先暂停该任务，按技能另拆 Init → Step → Poll（以及取消、恢复、幂等验证），不得用一个长阻塞端点硬做。

## 1. 执行入口与产品边界

### 1.1 实施前必读

1. 检查工作树、分支和 HEAD，重新核对本计划记录的代码事实；不覆盖用户已有修改。
2. 导入、角色卡、世界书以 [SillyTavern 兼容边界](docs/SillyTavern.md) 为准。
3. 参数、变量、保存和生成以 [参数架构](docs/architecture-params.md) 为准。
4. 插入点、运行时、去重和 disposer 以 [引擎复用](docs/engine-reuse.md) 为准。
5. 如进入报告 UI 或 bridge 阶段，先读 [UI 架构](docs/ui-architecture.md)。
6. 涉及宿主契约时先查 `D:\AI\GitHub\deepseek-harness\docs`，再核对当前安装包类型；不能把对方依赖版本下的实现直接当作本仓库契约。

### 1.2 必须保持

- 项目仍是位置、时机与受众可配置的提示词注入引擎，不成为完整对话请求、游戏世界或聊天历史的所有者。
- `preset.yml` 拥有预设行为；部署 settings、模板变量、会话变量、角色记忆与指令文件正文继续分属既有所有者。
- 各官方插入点独立，不建立跨插入点的插件全局运行顺序。
- 所有导入复用现有 host 转换器、`buildWorldBookEntry()`、角色应用和 `rebuildPreset()` 通道；客户端只采集输入和展示结果。
- 新能力默认保持旧行为或显式 opt-in；导入文件中的开关不等于执行任意脚本的授权。
- YAML 保存使用 Document API 保留注释和未知字段，沿用现有原子物化、只读 system 保护和 bridge 输入校验。
- 不修改 DeepSeek Harness 源码，不启停或重启用户正在运行的 DSH 服务，不操作其端口。

### 1.3 不做的事情

- 不整体移植 TavernHelper、浏览器脚本宿主、EJS 执行、MVU 结算、Story Timeline、游戏存档或后台 Agent 系统。
- 不为支持导入新增第二套工作台 store、角色卡库、转换入口、物化通道或通用配置框架。
- 不把历史深度近似、system 角色降级、marker 丢弃描述成完整 ST 等价。
- 不自动导入采样参数，不把未知 ST 顶层字段原样透传到模型请求。
- 不自动重写已导入预设或重新导入用户素材；已有手工编辑必须保留。

## 2. 对比结论与能力盘点

以下对方文件均相对于 `D:\AI\GitHub\dsh-tavern\tavern-plugin\lib\domain`。

| 项目 | 对方实现 | 本仓库现状 | 采用判断 |
|---|---|---|---|
| 世界书格式归一 | `worldbook-resource.js` 区分内嵌/独立格式，统一投影，保留 rawEntry/sourcePath，支持写回来源格式 | 已有别名映射与统一工厂，但复现两处 extensions 别名遗漏 | P0 补缺口并借鉴跨格式测试，不重写导入器 |
| 转换报告 | `preset-conversion-preview.js` 返回来源行、顺序组、诊断、未转换项和统计 | 已有 stWarnings/stDroppedMarkers/stSource，但多数告警是字符串 | P1 增量结构化，保留现有转换函数和预设结构 |
| 世界书筛选解释 | `worldbook-activation.js` 返回扫描来源、筛选原因和预算结果 | 已有完整的既定匹配路径，缺少逐条可解释结果 | P1 增加旁路诊断，不改变筛选 |
| 快照/来源 | `runtime-presets.js` 保留来源与 digest；兼容请求复制并冻结消息 | 已有共享宏帧及重建机制 | 借来源版本与请求一致性验收，不再造快照系统 |
| 模型参数 | 预设转换稿忽略顶层参数 | 明确独立管理 model/subagentModel 并生成 agent-request patch | 保留本仓库所有权 |
| 完整消息编排 | 独立兼容编译器重建消息列表 | 通过官方插入点注入 | 不移植；准确报告边界 |

### 2.1 已有能力，不重复实现

- 宏导入只 prepare，不执行赋值；实际运行时求值，同请求共享变量帧避免重复自增。
- 禁用、受众不符、未命中世界书及未获执行资格的一次性卡不产生对应副作用；单卡失败不提交其变量修改。
- 宏具备输入/输出 1 MiB、嵌套 32 层、总展开工作量、循环与危险变量键保护。
- 世界书已有主副关键词、四种 selective logic、概率、分组、扫描深度、字段扫描、递归与 sticky/cooldown/delay。
- 角色库保留原图、原始 JSON、转换定义和角色记忆，应用时复用现有命名空间及变量绑定。
- 参数已有 `ENGINE_PARAM_DEFINITIONS`、`MODEL_SEGMENT_MAP` 和生成器消费链，不另建 ST 专属模型参数管理层。

### 2.2 对方也不是完整兼容基准

- 对方普通转换将深度注入收敛为中段并报告 `TAVERN_DEPTH_COLLAPSED`；独立兼容编译器才尝试重建历史顺序、marker 和角色边界。
- 对方世界书激活器明确沿用自身 10 轮冷却，并非直接完整落实源 sticky/cooldown/delay；本仓库现有按源字段处理的行为必须保留。
- 根许可证分别为对方 AGPL v3、本仓库 MIT。以独立实现字段语义、借鉴测试场景为主；直接复制实现或 vendor 代码前须另行核对许可义务。

## 3. P0：世界书字段别名修复

### 3.1 已确认的缺陷

| 编号 | 输入 | 预期语义 | 基线实际行为 |
|---|---|---|---|
| F1 | `extensions.selective_logic: 3` | 主关键词命中且全部副关键词命中 | 没有写入 params.selectiveLogic，运行时回退 0，即 AND_ANY |
| F2 | `extensions.use_probability: false` | 不执行概率过滤 | 没有写入 stWorldBook.useProbability，仍执行概率过滤；probability=0 时错误排除 |

证据位置：

- 本仓库 `src/host/sillytavern.ts:232–269`：选项读取与工厂参数构造；`engine/st-world-book.mjs:74–85`：缺省逻辑与概率开关的实际消费。
- 对方 `worldbook-resource.js:48–90`：投影同时识别两种别名；`:226–248`：导出内嵌格式会产生对应蛇形字段。
- 以上行号只对应本计划分析基线，实施时按符号重定位。

### 3.2 已执行的最小行为复现

使用主关键词 `dragon`、副关键词 `red` 与 `flying`，开启 selective，正文为普通世界书文本：

| 输入条件 | 蛇形字段实际是否注入 | 驼峰字段实际是否注入 | 正确结果 |
|---|---|---|---|
| logic=3，消息仅含 dragon red | 是 | 否 | 否，缺少 flying |
| useProbability=false、probability=0，消息含全部关键词 | 否 | 是 | 是，概率过滤已关闭 |

验证通过 `convertStToPreset → createPromptConfigs → runPreStepBatch`，不是仅匹配源码字符串。
另用对方 `exportCharacterBook()` 生成内嵌世界书后送入本仓库，确认这些字段形态能由真实转换通道产生。
探针仅用于复现基线缺陷，不代表本仓库已经修复。

### 3.3 最小实施方案

1. 根因只在 `src/host/sillytavern.ts` 的字段归一层修复，让角色导入、预设 JSON 导入和世界书导入共用结果。
2. 明确识别两种拼写；不修改世界书执行器默认语义来掩盖导入遗漏。
3. 保持既有字段读取优先级；新旧别名同时出现时先列出冲突规则，再用测试固定，不能因真值判断丢失 false 或 0。
4. 对其他别名做定向检查；只有存在真实输入、消费方和行为证据时扩大修复，不顺手设计通用字段转换 DSL。
5. 核心回归不运行或依赖对方仓库。使用独立编写的最小 JSON 夹具，保证本仓库单独检出也能测试。
6. 同步 `docs/SillyTavern.md` 的兼容说明；如参数字段契约改变，再同步参数权威文档。

### 3.4 验收与停止条件

- F1/F2 在修复前以正确语义断言失败，修复后通过；旧驼峰形态行为不变。
- 独立世界书、角色卡内嵌世界书的等价字段产生相同触发结果。
- 覆盖 false、0、缺省值、冲突别名、禁用条目和无主关键词场景，保留源对象不变。
- 保持 order、role、位置降级、局部变量、宏副作用和原生非 ST world-book 行为。
- 定向与全量门禁通过后结束本阶段，不自动开展报告 UI 或可选功能。

## 4. P1：结构化转换报告与来源追踪

### 4.1 目标与最小结果模型

继续以 `convertStToPreset()` 为唯一转换实现，报告作为其结果或包装结果的增量，不成为第二份可执行预设。
最少提供以下有明确消费方的信息；字段名在 shared 契约阶段确定，不因本计划直接冻结 API：

| 信息 | 必须回答的问题 |
|---|---|
| 来源身份 | 来自哪个上传文件、哪个 JSON 字段/原条目、哪个顺序组？ |
| 目标身份 | 生成哪个合法配置 id、插入点、层内顺序、角色和位置？ |
| 转换分类 | 等价、降级、不支持或被排除？禁用与转换失败必须区分 |
| 结构化诊断 | 稳定 code、severity、条目/字段定位及可读原因 |
| 摘要 | 输入数、转换数、禁用数、未转换数及需要确认的降级 |
| 来源版本 | 来源内容摘要与转换器版本，能解释本次生成使用的输入 |

不默认保存绝对磁盘路径、整份敏感正文或无消费方的分析数据；来源身份优先采用文件显示名和文档内指针。

### 4.2 行为要求

- 预览与实际提交使用同一个后端转换函数；预览不写盘、不执行宏、不调用重建。
- 原始 identifier、来源索引和生成 id 保持可追踪；重复 identifier 不得通过 Map 静默覆盖。产生合法不冲突的 id 或明确诊断，具体重复引用语义用夹具固定。
- 多个 prompt_order 组允许用户明确选择；保留本仓库歧义时拒绝的安全行为，不照搬对方默认任取首组。
- 报告区分已丢弃 marker、未编排条目、纯赋值条目、不支持脚本、深度/角色降级和未选择顺序组。
- 保留纯赋值卡以及其启停状态；对不支持的宏/字段不能以空字符串伪装成成功转换。
- 多文件合并继续保留每个来源的局部变量绑定，并将诊断映射到合并后的目标条目。
- 预览后内容、所选顺序组或目标预设发生变化，应重新校验/重新预览，不能提交旧报告代表的新内容。
- 兼容现有 stWarnings 展示和 warn 通道；同一告警只维护一个事实来源，再派生旧字符串表现，避免两套判断漂移。

### 4.3 Bridge 与 UI

1. 先检查既有导入接口能否携带预览/报告，只有不足时再增加端点。
2. 先修改 `src/shared/bridge-contract.ts`，再同步 host、typed client 和 shared/client/host 契约测试。
3. 请求沿用文件类型、大小、目标白名单和统一成功/失败包装；预览身份不替代写入授权。
4. UI 复用预设/角色导入入口，只展示来源、转换结果、降级和顺序组选择，不重复执行转换。
5. 错误阻止提交；有损映射须清楚展示并由用户明确确认，不以零解析错误宣称行为等价。
6. 不建独立“转换稿资源库”，不将报告写进模型可见正文，不增加第二套工作台状态。

### 4.4 快照借鉴的边界

对方 `runtime-presets.js` 的 sources/digest 和 `compatibility-request.js` 的冻结请求可作为验收思路。
本仓库继续复用现有重建结果与共享宏帧，不移植其前中后三段模型或请求重建系统。
优先将来源摘要和版本用于导入报告、生成结果及调试定位；若发现同一请求读取混合版本，再在已有请求生命周期所有者处修复。
同一请求不能因报告预览或调试读取再次执行宏副作用，配置更新应在明确的后续边界生效。

## 5. P1：世界书入选与落选诊断

### 5.1 实施位置

在现有 `selectStWorldBook()` 判断分支旁记录可选诊断，执行器保留真实注入与 commit 的最终权威。
不为解释结果另跑一次选择器，不重新抽样概率，不把“候选命中”当成“已经注入”。

### 5.2 最小诊断内容

- 配置 id、来源条目、所属会话/请求或 epoch 的必要标识。
- 进入候选、最终入选、实际提交三个阶段的区别。
- 扫描窗口及来源类别，主副关键词是否满足、selective logic、概率过滤、分组胜负。
- 延迟、粘滞、冷却、递归边界、禁用/受众/门控/去重等相关原因；各原因由实际负责层提供，不能由 UI 猜测。

### 5.3 安全、成本与验收

- 默认不额外持久化完整对话和世界书正文；使用有上限的诊断记录，必要样本须截断/脱敏并由用户主动查看。
- 调试数据不进入 preset.yml 预设行为、模板变量或模型上下文，不污染 settings descriptor。
- 诊断关闭/开启应产生相同入选集合、正文、顺序、抽样次数、变量修改和激活状态。
- 重复查看不推进 sticky/cooldown，不产生新递归，不让一次性卡重新注入。
- 如需要展示入口，沿用 typed bridge 和工作台，不另起日志服务；无 UI 消费需求时先保留确定性测试/受控调试入口。

## 6. 保留的兼容边界

### 6.1 模型参数：保留既有链路

当前链路为 `ENGINE_PARAM_DEFINITIONS → 校验 → MODEL_SEGMENT_MAP → model/subagentModel → agent-request patch`。
ST 导入不会自动覆盖用户模型设置，这是有意边界，不是此次需要补齐的兼容缺陷。
以后若单独授权导入采样值，必须显式勾选、白名单映射、验证 provider/model 支持情况，并对已有值的覆盖单独确认；未知参数不可直通请求。

### 6.2 完整 ST 消息兼容：不在本计划实施

对方 `sillytavern-compatibility.js` 会展开 marker、重排历史、保留角色边界，并将人物卡 system_prompt/post_history_instructions 用于 main/jailbreak 覆盖。
本仓库按官方插入点注入，不能据此承诺这些完全相同的可观察语义：

- Prompt Order 的全局全序不能等同于各插入点内的 order。
- injection_depth 不能靠 before-all/after-user 等当前消息批位置无损表达。
- pre-step 不支持的 system 角色不能伪装成已保留。
- post_history_instructions 放入 system-section 不等于 ST 后历史覆盖。

保持原始来源字段和清晰降级说明。若未来用户要求完整兼容，应作为独立产品范围重新评审，而不是混入本注入引擎的局部修复。

## 7. 任务拆解报告与执行状态

### 7.1 需求概述与范围分组

先修复真实字段丢失，再提供可解释导入和运行结果；本轮只交付可执行规划。
下表 W0–W3 是功能范围分组，**不是实际执行 Wave 序号**；任务依赖与写区调度以 7.2–7.3 的 3 个执行 Wave 为准。

| 工作包 | 优先级 | 交付物 | 开始条件 | 当前状态 |
|---|---|---|---|---|
| W0 | 文档 | 旧计划原文归档、本计划、路径/命令校验 | 用户已授权 | 已完成（仅文档） |
| W1 | P0 | F1/F2 修复、跨格式行为回归、兼容文档 | 用户明确授权实施 | 已完成（ST-01、ST-02） |
| W2 | P1 | 结构化报告、来源身份、顺序组选择、必要 bridge/UI | W1 完成且用户授权本阶段 | 后端切片已完成（ST-03、ST-04）；UI 属 Wave 3 |
| W3 | P1 | 世界书实际筛选与注入诊断 | 用户授权；W2 来源信息可复用 | 引擎侧已完成（ST-04）；受控入口属执行 Wave 3 |

W1–W3 共拆为以下 6 个原子任务，每执行 Wave 2 个，不再保留额外候选工作包。
每个任务在一个上下文窗口中完成一个可验证切片；改动规模超出建议粒度时先重拆，不跳过安全和验证。

#### Wave 进度清单

参考归档 `plan-module-list-refactor.md` 的复选任务样式：`[x]` 仅表示已有验收证据的完成项；`[ ]` 表示未完成，进行中/部分完成/阻塞时在条目末尾注明状态与原因，不提前勾选。
每次更新复选框时同步上方范围表与对应 Task Summary；只有该 Wave 的任务、门禁与交付均完成后，才能勾选 Wave 总项。

- [x] **Wave 0：规划文档交付（对应 W0，已完成）**
  - [x] 原样归档旧 PLAN，核对 Git blob 与固定基线一致。
  - [x] 按指定 dev-expert 规范编写完整方案、6 张 XML 任务卡、依赖、安全验收、回滚和执行摘要。
  - [x] 通过文档结构、路径、命令与 diff 检查，完成文档提交并推送 origin/dev；业务代码未实施。
- [x] **执行 Wave 1：字段正确性（对应 W1，已完成）**
  - [x] **ST-01**：修复 selective_logic 别名，完成红灯到绿灯及独立/内嵌格式回归。
  - [x] **ST-02**：修复 use_probability 别名，锁定 false/0 与概率过滤语义。
  - [x] 完成 T01/T02、每任务完整门禁及兼容文档同步，记录 Summary，提交并推送 origin/dev。
- [x] **执行 Wave 2：可观测后端切片（对应 W2/W3 后端，依赖 Wave 1）**
  - [x] **ST-03**：通过既有导入 API 提供同源预览、结构化报告和来源版本校验。
  - [x] **ST-04**：从实际世界书筛选/提交路径输出有界只读诊断。
  - [x] 完成 T03–T08/T14 中本 Wave 的后端验收、安全检查与完整门禁，记录 Summary，提交并推送 origin/dev。
- [ ] **执行 Wave 3：受控用户入口（对应 W2/W3 用户入口，依赖 Wave 2）**
  - [ ] **ST-05**：在现有预设/角色导入入口展示报告、顺序组选择和有损转换确认。
  - [ ] **ST-06**：通过 typed bridge 和现有工作台展示只读世界书诊断，完成核心交付。
  - [ ] 完成相关 shared/client/host/engine 门禁、必要交互 smoke 和证据汇总，记录 Summary，提交并推送 origin/dev。

退出条件：执行 Wave 1–3 的 6 个核心任务分别满足 XML 中的 done；未验证的关键行为不因写了说明或完成了部分代码而勾选。

### 7.2 原子任务列表（XML）

#### 执行 Wave 1：字段正确性（ST-01、ST-02；无业务依赖，写区重叠而串行）

```xml
<task type="auto" id="ST-01">
  <name>修复内嵌世界书 selective_logic 别名及实际注入回归</name>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；test/engine/st-world-book.test.mjs；docs/SillyTavern.md</files>
  <depends_on>无</depends_on>
  <action>沿所有 convertStToPreset 调用方复核共同入口；先补 F1 的正确语义红灯，再只在字段读取处补别名；列明冲突优先级，保留独立/内嵌格式、禁用和原生 world-book 行为；同步稳定兼容说明。</action>
  <verify>证据类型：命令+输出、测试报告。运行第 9.3 节定向命令；T01/T02 中 F1 的蛇形/驼峰、四种逻辑、副关键词部分/全部命中、冲突输入均须有行为断言；按 7.4 运行本任务门禁。</verify>
  <security>验证外部 JSON 的 null/错误字段类型不会绕过既有输入校验；源对象不可变；无主关键词和禁用条目不得因缺省值误启用；不执行源扩展脚本，不修改真实用户素材。</security>
  <rollback>保留原始输入；未提交时只撤回本任务补丁，已提交时通过新的反向提交回退，不覆盖其他改动；不会自动迁移用户预设。</rollback>
  <done>F1 先红后绿、旧拼写与既有语义通过、全量门禁通过且 Task Summary 有原始证据；不能以探针显示两者不同代替正确语义验收。</done>
</task>
```

```xml
<task type="auto" id="ST-02">
  <name>修复 use_probability 别名并锁定 false/0 语义</name>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；test/engine/st-world-book.test.mjs；docs/SillyTavern.md</files>
  <depends_on>无</depends_on>
  <action>先补 F2 红灯；在同一转换入口补概率开关别名，禁止把 false 当缺省或把 probability=0 当空值；补独立/内嵌最小夹具及冲突输入，不调整执行器概率默认值。</action>
  <verify>证据类型：命令+输出、测试报告。运行第 9.3 节定向命令；T01/T02 覆盖关闭开关且概率为0时入选、开启且概率为0时不入选、缺省开关、已禁用条目和源对象不变；按 7.4 运行门禁。</verify>
  <security>测试缺失/null/错误类型与显式 false 的区别；外部布尔值不能扩权或启用脚本；失败转换不能修改原始 JSON、角色库或预设文件。</security>
  <rollback>只回退本任务变更，不移除 ST-01 已验收修复；保留夹具、诊断和原始资产供再次实施。</rollback>
  <done>F2 先红后绿；Wave 1 的 F1/F2 同时通过且全量门禁通过；记录旧转换产物需用户确认重新导入，不直接修改用户环境。</done>
</task>
```

#### 执行 Wave 2：可观测后端切片（ST-03、ST-04；依赖 Wave 1）

```xml
<task type="auto" id="ST-03">
  <name>通过现有导入 API 提供同源转换预览与结构化报告</name>
  <files>src/shared/bridge-contract.ts；src/host/sillytavern.ts；src/host/characters.ts；src/host/write-preset.ts（仅需传递报告时）；src/runtime/settings-bridge.ts；test/shared、test/host 中实际契约文件；docs/SillyTavern.md</files>
  <depends_on>ST-01, ST-02</depends_on>
  <action>先冻结最小请求/响应契约，优先扩展现有入口；转换结果增加条目/字段来源、顺序组选择、降级分类和摘要；preview 与实际提交共用纯转换函数；为来源版本和过期预览定义拒绝或重算规则；通过 API 夹具走完整预览/提交路径，不创建第二份预设。</action>
  <verify>证据类型：命令+输出、测试报告、API 响应（注明隔离 host 夹具或真实隔离服务）。T03–T06 覆盖预览不写盘、不重建、不执行宏，多个顺序组歧义拒绝，重复 identifier、多文件变量绑定、过期输入及统一成功/失败载荷。</verify>
  <security>验证 loopback、Host/Origin、方法、类型、体积和目标白名单；只读 system 及未授权目标不可写；报告不泄露绝对路径或无必要正文；preview 身份不能作为写入凭证，非法或过期载荷不得产生写盘副作用。</security>
  <rollback>报告是派生元数据；保留现有预设和 warn 兼容路径，回退本任务即可恢复旧导入表现；不得清理已存在资产或重写用户默认值。</rollback>
  <done>后端预览/提交同源契约有可执行消费者夹具，T03–T06 和完整门禁通过；报告字段均有 API/UI 计划消费用途，无独立转换稿资源库。</done>
</task>
```

```xml
<task type="auto" id="ST-04">
  <name>从实际世界书筛选与提交路径输出只读诊断</name>
  <files>engine/st-world-book.mjs；engine/executor.mjs（仅需确认提交结果时）；test/engine/st-world-book.test.mjs；docs/engine-reuse.md</files>
  <depends_on>ST-01, ST-02</depends_on>
  <action>在实际谓词和提交点收集有上限的结构化原因，沿用配置 id 作为身份；先以现有可用回调/受控调试接口及行为测试消费，不新增无人消费的状态服务；明确候选、入选、已注入的区别。</action>
  <verify>证据类型：命令+输出、测试报告。T07/T08/T14 对照诊断开关的输出集合、排序、随机调用次数、变量修改和窗口状态；覆盖主/子代理、压缩后重晋升、失败压缩、重复装配与 disposer。</verify>
  <security>诊断只读，不扫描真实工作区或暴露完整聊天/世界书正文；超量记录必须有界；读取不再抽样、不触发宏、不推进冷却；检查禁用、受众、门控及去重不会被调试入口绕过。</security>
  <rollback>新增诊断可撤回，不改变持久预设和原生 world-book 语义；失败时回到基线选择/提交路径，不保留半套新的行为状态。</rollback>
  <done>有可运行诊断消费者与差分行为测试，T07/T08/T14 和完整门禁通过；开启或关闭诊断只改变观测结果，不改变模型输入及运行状态。</done>
</task>
```

#### 执行 Wave 3：受控用户入口（ST-05、ST-06；依赖 Wave 2）

```xml
<task type="auto" id="ST-05">
  <name>在现有预设与角色导入入口展示预览并确认有损转换</name>
  <files>src/client/features、src/client/data 中现有导入组件/facade/typed bridge；src/shared/bridge-contract.ts 和 src/runtime/settings-bridge.ts（仅同步必要契约）；test/client、test/shared、test/host 中相关测试；docs/SillyTavern.md、docs/ui-architecture.md</files>
  <depends_on>ST-03</depends_on>
  <action>读取服务端报告，展示条目来源、诊断和顺序组；接入错误阻止、有损确认与过期预览处理；复用现有导入按钮、store 与保存队列，不在客户端转换或另建资源库。</action>
  <verify>证据类型：命令+输出、测试报告；交互 smoke 使用截图+步骤并记录浏览器/宿主版本。T03–T06 覆盖换文件/换目标/换顺序组、失败不提交、显式确认、关闭再打开、键盘可操作；未做真实 smoke 时单列未验证，不冒充已完成交互验收。</verify>
  <security>以文本渲染导入名称和告警，恶意 HTML 不能执行；客户端禁止项仍由服务端复验；过期异步响应不能覆盖新草稿；大文件和超限报告有受控失败行为。</security>
  <rollback>撤回新增展示与确认接线，不删除原始资产或改动已保存预设；涉及共用 facade 时仅撤回本任务补丁，保留其他任务结果。</rollback>
  <done>实际入口能完成预览到受控导入闭环，契约/行为门禁与授权范围内的交互验收完成；没有第二套转换器或 store，所有未验证项明确记录。</done>
</task>
```

```xml
<task type="auto" id="ST-06">
  <name>通过 typed bridge 暴露有界只读世界书诊断并完成核心交付</name>
  <files>src/shared/bridge-contract.ts；src/runtime/settings-bridge.ts；src/client/features、src/client/data 中现有调试/世界书入口；test/shared、test/client、test/host、test/engine 中相关测试；docs/SillyTavern.md、docs/ui-architecture.md、PLAN.md</files>
  <depends_on>ST-03, ST-04</depends_on>
  <action>先定义最小只读载荷，再连接引擎诊断与既有工作台入口；把来源 id、真实原因和提交状态展示给用户；限制记录体积及生命周期；检查并汇总 6 个核心任务的证据，不扩大实施范围。</action>
  <verify>证据类型：命令+输出、测试报告、API 响应；UI smoke 同 ST-05 单列。T06–T08/T14 覆盖同会话重复读取、换会话、越界请求、无记录/过期记录、超量记录、启停/卸载后的状态释放，以及完整 shared/client/engine/host 门禁。</verify>
  <security>只返回当前授权会话诊断，不泄露其他会话或完整敏感正文；保留 Host/Origin/loopback 校验；读取接口不得写 preset.yml、改变变量或推进时间窗；UI 不把源文本当 HTML 或模型指令执行。</security>
  <rollback>撤回诊断 bridge/UI，保留已验收的字段修复和转换报告；清理仅限本次拥有的临时记录，不能删除用户资产、历史或其他服务状态。</rollback>
  <done>世界书原因可以从真实运行路径追溯到受控入口，安全/一致性/生命周期测试和完整门禁通过；6 个核心任务均有 Summary，交付明确实际完成范围和未验证项。</done>
</task>
```

### 7.3 依赖、冲突与执行建议

```text
W0 文档交付 + 用户实施授权
  └─ 执行 Wave 1：ST-01、ST-02（相同写区，串行）
       └─ 执行 Wave 2：ST-03、ST-04（职责/写区可分，默认串行）
            ├─ ST-03 → ST-05
            └─ ST-03 + ST-04 → ST-06
                 执行 Wave 3：ST-05、ST-06（共用 bridge/facade，串行）
```

- 独立任务不等于已授权并行；本轮不启动任何子代理。未来有明确授权且写区互斥时，才可并行执行 Wave 2；主执行者先自行理解整体边界，不能将理解任务外包。
- Wave 1 的两个修复没有语义依赖，但写同一转换器/测试/文档，必须在前一补丁回读验证后再做下一项。
- ST-05/ST-06 开始前进一步圈定现有组件和测试文件；若共用文件不能拆出互斥写区，保持串行，不靠并行编辑后碰运气合并。
- 任何前置任务处于失败、部分完成或证据不足状态，后续依赖不得开始；完成规划不计任何 ST 任务完成率。
- 当前依赖链只包含 ST-01–ST-06；范围外能力不属于待办，也不影响已授权 P0/P1 的独立交付。

### 7.4 PLAN-GATE 与每任务闭环

每项实施授权后，按以下门禁逐项确认；本轮文档校验不能代替未来代码任务门禁。

| 门禁 | 必须记录的证据 |
|---|---|
| 范围与定制文件 | HEAD、工作树、该任务实际 files 清单，用户手工文件/旧数据处理范围 |
| 实码与调用方 | 目标文件回读、共同入口所有调用方、相关测试；图谱若存在也必须用实际搜索复核 |
| 架构与外部契约 | 唯一数据所有者、依赖方向、宿主安装版本、bridge 契约及消费方；无新库时注明不涉及许可证新增 |
| 安全 | 对照每卡 security 执行类型/大小/授权/路径/脚本/XSS/敏感数据检查，不以“已检查”替代方法 |
| 并发与生命周期 | 预览过期、请求一致性、重复求值、主/子代理、压缩和 disposer 的对应场景 |
| 性能与批量 | 扫描/报告的规模上限；超过约 200 行业务代码、3 个改动点或长任务阈值时重拆 |
| 验证与恢复 | 最小红灯、定向及完整门禁命令、仅本任务可撤回的补丁/提交、恢复起点 |
| 计划回读 | 任务 XML、依赖、路径和权限边界完整，跳过项说明原因，无乱码或截断 |

执行顺序为：分析并确认授权 → 回读/搜索/冲突检查 → 更新本任务边界 → 最小修改 → verify 自测 → 逐项复核 → 记录 Summary → 达到 done 才更新状态。
每个任务修改后立即运行其定向验证；业务任务标记完成或创建实施提交前，仍须通过第 9.3 节完整门禁，不因同 Wave 有其他任务而省略。
关键验收或必要 smoke 未完成时，任务只能标记部分完成/阻塞，不能仅凭“已披露未验证项”就满足 done。
单个方向连续失败 3 次，停止该方向，记录原始错误、差异和 2–3 个不同策略的选项，等待必要输入；不得悄悄跳过用例或将环境失败记为通过。
实现中出现新增所有者、宿主 API 不足或大范围架构变化，先改计划并确认，不以“为了兼容”扩大授权。

### 7.5 上下文、Task Summary 与检查点

每次恢复只读本任务关联需求/设计、允许文件、关键决策和前置 Summary，不加载无关模块或完整历史聊天。
如将来获准委派，简报必须包含目标、背景、互斥写区、约束、前置输入、验收和返回格式；主执行者复核后才可计入完成。

```text
## Task Summary: [ST-xx / 任务名]
完成状态: 未开始 / 进行中 / 完成 / 部分完成 / 失败 / 阻塞
修改文件: 实际文件清单，与计划范围不同须说明
验证证据: 类型 + 命令/请求/步骤 + 退出码/状态码 + 关键输出或报告位置
置信度: 高 / 中 / 低；低置信度说明原因
关键决策: 所选方案、边界及必要的撤销条件
偏差说明: 无偏差或实际差异与原因，禁止省略
遗留问题: 未验证项、环境阻塞、失败明细
检查点/下一步: 已验收提交或补丁状态，恢复需要的最小上下文
```

本轮 W0 采用“命令+输出”证据：文档/任务卡解析、路径/scripts 检查、旧计划 blob 对比及 Git diff 检查；不伪造截图、API 响应或实施测试结果。
运行 API 夹具需注明“隔离 host 夹具”，不能写成真实生产联调；UI 截图证据须带步骤和环境版本。
任务状态和最小检查点更新到本计划；项目修改记忆仅追加 `.ai-memory/20260916/daily.md`（后续使用执行当日目录）。不把 handoff、图谱或第二份任务账本放入 `.ai-memory`。

#### Task Summary: W0 / 按指定 dev-expert 规范编写计划

- **完成状态**：完成，仅限文档；ST-01–ST-06 均未开始。
- **修改文件**：PLAN.md；`.scratch/prompt-tool-framework/archive/plan-agents-files-20260914-archived-20260916.md`；本地忽略的 daily.md 另记结果。
- **验证证据**：命令+输出。隔离 cwd 的 PowerShell 只读校验退出 0：6 张 XML 任务卡必填字段非空、3 个 Wave 的依赖只指向前序 Wave、5 个 Markdown 链接和 26 个仓库路径存在、7 个 package scripts 有定义、UTF-8 无 BOM 且代码围栏配对；`git -C $Repo diff --check` 退出 0。
- **归档证据**：`git -C $Repo rev-parse 0ea927f:PLAN.md` 与归档的 `git hash-object` 均为 `9935da145ef7552586ae9c1ba78f11c0ef803f8b`，旧计划原文未改写。
- **置信度**：文档结构与路径验证为高；不将该置信度用于声称尚未实施的业务功能已正确。
- **关键决策**：保留核心改进及兼容边界，拆成 6 个任务/3 个执行 Wave；不保留范围外候选方案。
- **偏差说明**：无业务范围偏差；按用户追加指示采用 CC-switch 路径下的指定技能，补齐 XML 任务、安全、回滚、依赖及执行摘要，而非只保留阶段表。
- **遗留问题**：无文档阻塞；本轮未运行业务测试、构建、真实 UI/API smoke，原因是没有业务代码改动。基线测试和对方缺依赖记录见第 10 节。
- **检查点/下一步**：本计划是唯一当前任务入口；若用户授权 P0，从 ST-01 的红灯回归开始。提交 SHA 由交付消息和 Git 历史记录，不在计划内自引用。

#### Task Summary: 执行 Wave 1 / ST-01 + ST-02

- **完成状态**：完成。两任务写同一转换器文件，按计划串行、在同一补丁内实施。
- **修改文件**：`src/host/sillytavern.ts`；`test/host/st-compatibility.test.mjs`；`test/engine/st-world-book.test.mjs`；`docs/SillyTavern.md`；本 PLAN。
- **验证证据**：命令+输出，cwd 固定 `D:\AI\workspase\_temp`。定向 `node --test`（st-compatibility、st-world-book、st-macros、st-render）先红灯 4 项（F1 `selectiveLogic` 缺失、F2 `use_probability:false` 仍被概率过滤、别名冲突未定位、独立格式等价缺失），修复后同命令 39/39 通过（基线 35/35 + 新增 4）；全量 `pnpm typecheck`、`pnpm lint`、`pnpm test`（908/908）、`pnpm build`、`git -C $Repo diff --check` 全部退出 0。
- **关键决策**：字段读取统一为「作用域内主名 → 兼容别名；`extensions` 优先于条目顶层」，一律以 `!== undefined` 判定，显式 `false`/`0` 不当缺省；新增别名只限有真实输入证据的 `selective_logic`、`use_probability`，未扩大为通用字段转换；执行器（`engine/st-world-book.mjs`）默认语义未改，避免用改默认值掩盖导入遗漏。
- **置信度**：高。T01/T02 以「转换 → createPromptConfigs → runPreStepBatch 真实注入结果」断言，而非源码字符串匹配。
- **偏差说明**：无。修复落在计划指定的共同入口，所有 `convertStToPreset` 调用方（预设 JSON、角色卡内嵌世界书、独立世界书）共用同一结果。
- **遗留问题**：已生成的旧 `preset.yml` 不因本次修复而补回源字段，需用户重新导入才生效；本轮未做真实会话 smoke，未改用户真实 DSH_HOME。
- **检查点/下一步**：交付提交 SHA 与推送分支见交付消息与 Git 历史，不在本文件自引用；下一步执行 Wave 2（ST-03、ST-04）。

#### Task Summary: 执行 Wave 2 / ST-03 + ST-04

- **完成状态**：完成（可观测后端切片）。子代理通道在本会话不可用（spawn/followup 均收到空消息，含一行探针），按委派规范「无可用代理时主线程自己做」由主线程串行实施，未放弃任何验收项。
- **修改文件**：`src/shared/bridge-contract.ts`、`src/host/sillytavern.ts`、`src/host/characters.ts`、`src/runtime/settings-bridge.ts`、`engine/st-world-book.mjs`、`test/host/st-preview-report.test.mjs`（新增）、`test/engine/st-world-book.test.mjs`、`docs/SillyTavern.md`、`docs/engine-reuse.md`、本 PLAN。
- **验证证据**：命令+输出，cwd 固定 `D:\AI\workspase\_temp`。定向：`test/host/st-preview-report.test.mjs` 6/6、`test/engine/st-world-book.test.mjs` 13/13（含 4 项新增诊断差分/有界/原因断言）。变异红灯：临时禁用预览短路后 2/6 失败，恢复后 6/6。全量 `pnpm typecheck`、`pnpm lint`、`pnpm test`（918/918）、`pnpm build`、`git diff --check` 全部退出 0。
- **关键决策**：①报告走 `convertStToPresetWithReport()` 同源纯函数，不进 `preset.yml`、不进模型上下文；`meta.stWarnings` 改由结构化诊断派生（同一事实来源、消息仍去重），既有字符串表现不变。②预览复用既有端点（`preview: true`）而不是新端点；提交用本次上传文件重算 `sourceDigest` 校验，预览身份不构成写入凭证。③世界书诊断挂在 `selectStWorldBook()` 返回集合上（`selection.diagnostics = { records, truncated }`），上限 200 条，不新增状态服务，不重跑选择器。
- **置信度**：高（T03–T08/T14 的相关断言均以真实转换→物化→注入结果与真实端点响应为准；诊断差分断言含 `Math.random` 调用次数与粘滞窗口）。
- **偏差说明**：PNG 流式导入（`/characters-import-stream`）未提供预览（保持既有行为），已在 `docs/SillyTavern.md` 明示；世界书诊断的 UI 消费入口属 ST-06，未在本 Wave 假装完成。
- **遗留问题**：未做真实会话 smoke；运行中的 DSH 需用户重启后才会加载新引擎与端点行为；受控用户入口（ST-05/ST-06）与交互验收待 Wave 3。
- **检查点/下一步**：交付提交 SHA 与推送分支见交付消息；下一步执行 Wave 3（ST-05、ST-06）。

### 7.6 风险登记与处置

| 风险 | 影响 | 防线/停止条件 |
|---|---|---|
| 补别名改变既有优先级或吞掉 false/0 | 错误启停、关键词误触发 | F1/F2 红灯、冲突输入及独立/内嵌行为对照；默认不扩大字段清单 |
| 预览与提交重复实现或源版本不一致 | 用户确认的内容与写入内容不符 | 同一纯转换入口、输入/目标/顺序组版本校验、过期重预览 |
| 诊断再次运行选择器或宏 | 抽样、变量与冷却状态改变 | 同一真实路径旁路记录，开关差分与重复读取测试 |
| 跨层任务变大或共享文件并发修改 | 契约漂移、覆盖用户改动 | shared 先行、互斥写区/串行、每任务回读，超粒度重拆 |
| 直接搬对方运行时/vendor | 许可证、宿主版本与产品边界风险 | 独立实现最小语义，许可和版本未核验不得直接复制 |
| 缺依赖/未做 smoke 被记成通过 | 错报完成度 | 原始错误和未验证项单列，只有满足 done 的任务计完成 |
| 旧导入产物被自动覆盖 | 用户手工改动丢失 | 保留原始资产、先预览并取得重新导入确认，不操作真实 DSH_HOME |

## 8. 预计文件影响与复用点

本节是实施定位，不是本轮已修改清单；新文件只在职责无法落入已有模块时创建。

| 文件/目录 | 阶段 | 预计职责 |
|---|---|---|
| `src/host/sillytavern.ts` | W1/W2 | 字段别名、来源定位、转换报告；所有调用方复用 |
| `src/host/worldbook.ts` | 视契约需要 | 保持 buildWorldBookEntry 结构权威，不重复工厂 |
| `src/host/characters.ts` | W2 | 角色导入/应用的报告传递与原始资产保留 |
| `src/host/write-preset.ts` | W2 | 复用兼容 warn 与生成结果，不往正文混入报告 |
| `src/shared/bridge-contract.ts` | W2/W3 | 先定义需传输的报告/诊断载荷与端点 |
| `src/runtime/settings-bridge.ts` | W2/W3 | 复用现有入口、校验和目标写入守卫 |
| `src/client/features`、`src/client/data` | W2/W3 | 在现有 facade/typed bridge 下展示，不建立第二个 store |
| `engine/st-world-book.mjs` | W3 | 旁路原因记录，不改变原生 world-book |
| `engine/st-render.mjs`、`engine/executor.mjs` | 仅实际需要时 | 保持宏求值和真实注入提交边界 |
| `test/host/st-compatibility.test.mjs` | W1/W2 | 来源归一、纯转换、变量绑定和不可变输入 |
| `test/engine/st-world-book.test.mjs` | W1/W3 | 实际入选、注入和时序 |
| `test/engine/st-macros.test.mjs`、`test/engine/st-render.test.mjs` | 按影响面 | 宏语义、有界展开、失败隔离和同请求幂等 |
| `test/shared`、`test/client`、`test/host` | W2/W3 | bridge 与导入/展示行为契约 |
| `docs/SillyTavern.md` 及对应权威文档 | 各实施阶段 | 只沉淀已实现稳定行为，未实现内容留在本计划 |

本轮实际只应提交新 `PLAN.md` 和旧计划归档；本地 `.ai-memory` 追加文档工作记录但不入库。

## 9. 验收矩阵与验证命令

### 9.1 行为矩阵

| 编号 | 阶段 | 最小验收 |
|---|---|---|
| T01 | W1 | F1/F2 正确语义先红后绿，蛇形/驼峰等价且 false/0 不丢失 |
| T02 | W1 | 独立/内嵌格式、别名冲突、禁用/无主键、源对象不变 |
| T03 | W2 | 预览与提交同源，预览无写盘、无宏副作用、无重建 |
| T04 | W2 | 多顺序组显式选择、歧义拒绝、重复 identifier 可定位且不静默覆盖 |
| T05 | W2 | 深度/角色/marker/脚本降级准确，禁用与失败区分，合并变量不串来源 |
| T06 | W2/W3 | shared/host/client 载荷一致，类型/大小/目标/只读校验与失败包装正确 |
| T07 | W3 | 开关诊断不改变输出、抽样、宏副作用、去重或激活状态 |
| T08 | W3 | 候选、入选、真实提交可区分，重复求值与查看不推进时间窗 |
| T14 | 运行时变更 | 主会话、子代理、压缩后重晋升、失败压缩、重复装配与 disposer |
| T15 | 生成/写盘变更 | 注释/未知字段、用户文件、只读目录、原子切换与失败回退保持 |

验收以注入层、位置、时机、次数、受众、epoch 和实际输出断言为准，不用模型措辞、主观分数或源码字符串检查替代。
优先 Node 内置 test runner 和现有 helper；文件系统测试使用独立临时目录与临时 DSH_HOME，并在结束后清理。

### 9.2 本轮文档验证

只做文档时不需要为“看起来完整”运行构建或重建预设。验证：

- 根计划状态、优先级、证据、文件影响、验收、未实施边界齐全。
- 新计划的当前仓库路径/Markdown 链接存在，外部项目路径明确标为本地参考。
- 旧计划归档内容与固定基线 `0ea927f:PLAN.md` 的 Git blob 一致；历史原文不偷偷改写，提交后不再用变化的 HEAD 作为旧计划来源。
- 命令对应当前 package.json scripts，`.ai-memory` 未进入暂存。
- `git -C $Repo diff --check`，提交前补 `git -C $Repo diff --cached --check`。

### 9.3 后续实施的门禁

所有测试和脚本从隔离 cwd 启动，不能在仓库目录中运行：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'

# W1 与宏/世界书变更的定向回归
node --test "$Repo\test\host\st-compatibility.test.mjs" `
  "$Repo\test\engine\st-macros.test.mjs" `
  "$Repo\test\engine\st-render.test.mjs" `
  "$Repo\test\engine\st-world-book.test.mjs"

# 任何业务代码实施完成后的完整门禁
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check

# 涉及宿主接线时追加
pnpm --dir $Repo verify:host
```

若涉及组合或 vendor，按任务范围运行 `rebuild:composition` / `sync:yaml` 并检查版本化快照；不能手工编辑或删除分发目录。
若涉及 bridge/UI/预设生成，追加对应 shared/client/host/presets 契约测试；最终仍跑完整 test。
真实 smoke 只能使用隔离 DSH_HOME 和随机端口，不调用生产 rematerialize 或启停现有服务。

## 10. 基线验证记录与证据限制

以下为 2026-09-16 只读对比阶段已执行的结果，不代表未来实现的验收：

| 验证 | 结果 | 范围限制 |
|---|---|---|
| 本仓库 st-compatibility、st-macros、st-render、st-world-book 四个文件 | 35/35 通过 | 既有测试未覆盖 F1/F2 蛇形形态，不能据此否认缺陷 |
| 对方 preset-conversion-preview、preset-reading、tavern-regex-display、worldbook-resource 四个文件 | 25/25 通过 | 仅这些局部测试，不是对方全量验收 |
| 对方 worldbook-st-activation、worldbook-token-budget | 未能加载 | 缺少 marked 依赖；不记通过，也不能认定业务实现失败 |
| F1/F2 单独探针 | 已复现不同注入结果 | 正确性回归仍须在 W1 写入本仓库 |
| 两个仓库状态 | 对比结束时均干净 | 当时没有修改源码、用户数据或运行服务 |

主要定位索引：

- 本仓库：`src/host/sillytavern.ts`、`src/host/characters.ts`、`src/host/manifest.ts`、`src/host/write-preset.ts`、`src/shared/engine-params.ts`。
- 本仓库运行时：`engine/st-macros.mjs`、`engine/st-render.mjs`、`engine/st-world-book.mjs`、`engine/executor.mjs`。
- 对方转换：`worldbook-resource.js:48–90`、`:204–260`；`preset-conversion-preview.js:129–179`、`:290–360`。
- 对方运行：`worldbook-activation.js:189–259`；`tavern-regex-display.js:21–85`；`tavern-macro-engine.js:67–188`。
- 对方请求：`runtime-presets.js:381–464`；`compatibility-request.js:9–14`；`sillytavern-compatibility.js:56–89`、`:135–228`。
- 模型参数边界：本仓库 `src/host/sillytavern.ts:11–13`、`src/host/manifest.ts:200–210`、`src/host/write-preset.ts:216`；对方 `tests/preset-conversion-preview.test.mjs`。

## 11. 切换、回滚与交付

- 计划文档本身不改变运行行为，不需要重启 DSH、重建预设或重新链接 profile。
- 后续导入修复通常只影响新转换；已丢失源字段的旧产物不能靠重建恢复。用户需先预览，再明确确认重新导入和手工改动处理方式。
- 引擎更新沿用现有构建和物化流程；若运行服务需重启才能生效，仅在交付说明提醒，由用户安排。
- 每阶段保留默认行为与原始资产，写入失败沿用原子回退；不通过删除用户目录、reset --hard 或重装用户环境“回滚”。
- 完成并验证后只暂存本次任务文件，创建中文 Conventional Commit，普通推送 origin/dev；不切 main、不创建 PR、不强推。
- 本地 `.ai-memory/{YYYYMMDD}/daily.md` 记录文档或实施结果但不入库；报告验证命令、结果、提交 SHA、分支和未完成项。
- 本轮停止条件：旧计划安全归档、新计划完整可执行、文档检查通过并完成文档交付；W1–W3 保持未实施状态，等待用户下一次授权。
