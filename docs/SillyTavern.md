# SillyTavern 导入与兼容边界

转换器把外部预设、角色卡与世界书变成普通模块。原始 ST 字段只在 `src/host/sillytavern.ts` 和 `st-template.ts` 识别；运行时使用规则、上下文激活和两级持久变量。转换成功不代表与 ST 全部行为等价，降级报告和生成规则应一起检查。

本次映射核对的 ST 基线为 `ad29cbda62e92f145e44d7a10398a38af22ca986`。持久化与格式切换见 [参数框架](architecture-params.md#原生格式与持久状态) 和 [ADR-0013](adr/0013-native-context-module-state.md)。

## 输入与入口

工作台模块页与 `module_import` 共用来源识别、预览、选择、凭据和候选安装。支持原生 JSON/YAML、目录/ZIP、ST JSON 预设、PNG/JSON 角色卡和独立世界书。角色卡导入后位于普通 `modules/<id>/`，没有角色专属库或新的角色身份。

- PNG 按魔数识别，读取 `ccv3`，缺失时回退 `chara`；保留原图与来源资产。
- 包里有唯一原生定义时以它为准，其余文件作附件；多定义或矛盾来源拒绝。
- 无原生定义的多个 ST 来源按显式输入顺序组合；模块与规则身份冲突通过同一分配结果回填报告。
- 导入前显示来源、目标、启停与降级；默认同名另存，不自动启用。
- 提交带回 `expectedSourceDigest` 与 `expectedPreviewRevision`。来源、目标或选择变化后必须重新预览，不能复用旧确认。
- 覆盖安装先完整生成隔离候选，再核对版本并原子交换；模型工具导入保留目标记忆和用户资产。资源、路径、链接与体积限制见 [资产交换](asset-transfer.md)。

## 原生转换映射

一条外部条目生成一条普通规则。`rule.enabled` 是总开关，`then` 保存有稳定 id 的动作。原生 `params.source` 保存 `format: sillytavern`、来源身份和 `original`；运行时不以来源格式选另一套算法。

### 预设和角色内容

| ST 输入 | 生成行为 | 边界 |
|---|---|---|
| `prompts[].content` | 普通注入正文，启用原生模板求值 | 清洗后空白跳过；纯赋值模板保留 |
| `prompt_order` | 按选中的顺序组保留启停和相对次序 | 优先全局组 `100001`，只有一组时使用该组；多组有歧义则先选择 |
| 顺序组 `enabled` | 优先于 prompt 自身开关 | 已选组未列出的 prompt 禁用 |
| `role: system` | `system-section` | 系统段的顺序不等于跨插入点全序 |
| `role: user/assistant/model` | `pre-step` 的 user 消息 | assistant/model 明确降级，原角色进入 `source.original` |
| `marker`、`SPresetSettings` | 排除位置标记和扩展配置 dump | 不把脚本或设置 JSON 混入正文 |
| `injection_position/depth` | 映射到当前可用投递位置 | 不宣称支持持久历史深度插入，报告原值与降级 |
| `system_prompt` 管理位 | 来源元数据 | 不因该管理位改变 role/插入点 |
| `injection_trigger` | 保留来源并禁用该规则 | 当前不能等价执行生成类型门 |
| `description/personality/scenario` | 角色设定系统段及同名模块变量 | 同名不同值的组合拒绝，不能取顺序赢家 |
| `system_prompt/post_history_instructions` | 系统段 | 后历史指令的原位置报告降级 |
| `first_mes/alternate_greetings/mes_example` | 一次性 user 消息；备用开场白默认禁用 | 原角色保留，不伪造 assistant 消息 |
| `extensions.depth_prompt` | 默认禁用的 pre-step 规则及 `depth_prompt` 变量 | ST 群聊自动注入未实现 |
| `creator_notes` | 模块变量 | 仅在显式扫描清单中参与激活 |
| 采样参数 | 不导入 | 使用模块模型卡或 `request-params` 动作 |
| `enable_web_search: true` | 提示确认官方预设已提供工具 | 不装配额外 web 工具 |
| `enable_web_search: false` | 装配呈现、SDK 文本和执行拒绝规则 | 仍经官方工具管线执行 |

含系统段的来源生成主/子人设定义，但导入或启用规则不自动选择该人设。用户在独立人设卡中为主/子各选一个模块来源，默认仍为官方；运行时只取选中模块对应受众的字段。规则配装前仍检查有效官方人设与规则 complete 的冲突。字段和继承语义见 [独立人设卡](architecture-params.md#独立人设卡与继承)。

### 世界书到上下文激活

策略为 `context-activation`，只支持 `pre-step`。匹配共有字段位于 `params`，选择和扫描字段位于 `params.activation`。手写模块可直接使用同一结构。

| ST 输入或行为 | 原生承接 |
|---|---|
| `uid/id`、`comment`、`content` | 稳定规则身份、名称、正文；空正文排除 |
| `disable/enabled` | `rule.enabled`；存在 disable 时优先 |
| `constant/add_always` | `params.constant`；空主键不隐式常驻 |
| `keys/key`、`secondary_keys/keysecondary` | `params.keys/secondaryKeys`，求值来自来源模块与全局快照 |
| ST 可见历史扫描 | `activation.scan: history`；原生还可声明 `batch` |
| `scan_depth/scanDepth` | `activation.scanDepth`；条目→书级→2 的导入缺省 |
| `selective` | `activation.selective`，控制副键约束 |
| `selectiveLogic/selective_logic` | `params.selectiveLogic` 的具名逻辑，见下表 |
| 大小写、整词、正则 | `caseSensitive/wholeWords/useRegex` 与 `wordBoundary` |
| 六个字段扫描开关 | `activation.scanVariables`：description、personality、scenario、persona、creator_notes、depth_prompt |
| `probability/useProbability` | activation 中同名字段；百分比 0–100，显式 false 跳过概率门 |
| `group` | `activation.selectionGroup`，逗号分组；不是规则互斥组 |
| `group_override/group_weight` | `groupOverride/groupWeight`；sticky/override 优先，其余按权重 |
| `use_group_scoring` | `useGroupScoring`；只有显式启用评分且低于最高分的候选被淘汰 |
| `sticky/cooldown/delay` | 同名消息计数窗口；实际投递才 commit，sticky 重发不延期 |
| `exclude_recursion/prevent_recursion` | 分别限制参与重扫和正文进入递归池 |
| `delay_until_recursion` | `delayUntilRecursion`；true 为层级1，层级池只增不减 |
| 书级/条目 `recursive_scanning` | 只保留在来源；不能自动开启模块递归 |
| `insertion_order/order` | 保留选择高值优先与最终内容低值在前的区别 |
| 原位置/深度/角色 | `source.original`；位置4降到当前批尾，其余可承接位置降到批头 |

来源别名按 `extensions` 优先于条目顶层处理；同作用域的大部分开关先蛇形后驼峰，selectiveLogic 先驼峰后蛇形。显式 false/0 不当缺省丢弃。

历史扫描只看当前可见的真实对话，排除插件、指令及工具回执；batch 只看本批真实对话。`scanDepth: 0` 不扫描聊天、扫描变量或递归正文，但显式常驻仍可入选。键求值只读：set/add/inc/dec 和带默认写回的 get 被拒，不能在扫描时写变量。

设 P 为主键命中数，S 为副键命中数，N 为求值前副键项数。selective 未开或 N=0 时只要求 P>0；开启时：

| ST 数值 | 原生逻辑 | 条件 |
|---|---|---|
| 0 | `AND_ANY` | P>0 且 S>0 |
| 1 | `NOT_ALL` | P>0 且 S<N |
| 2 | `NOT_ANY` | P>0 且 S=0 |
| 3 | `AND_ALL` | P>0 且 S=N |

求值为空的副键仍占 N 的一项，不能缩小 ALL 约束。规则 `text.logic` 的 any/all/not/notAny 是另一组已有语义，不能仅按名字替换。ST 整词采用 `wordBoundary: ascii-token`（单词 ASCII 边界、多词子串）；原生可选 `unicode`。`useRegex` 保留强制正则/强制字面/省略时检测 `/pattern/flags` 的三态；ST 的 `use_regex` 不被当作强制正则。

模块顶层 `contextActivationRecursive` 默认 false，只控制本模块是否参与重扫。候选正文池跨模块共享，`preventRecursion` 控制哪段正文进入池；延迟层级池独立推进。成功压缩重基准窗口，非压缩 surface 替换不额外改变 sticky 契约。时间窗不承诺跨进程恢复。

## 模板操作与外部降级

ST 导入正文设置 `params.templateEvaluation: true`，变量操作经有界 parser 转成原生操作，不在导入时执行。

顶层文本末尾的未知裸引用残片（例如 `{{s}`）按普通文本保留，禁用提示词也能完整导入，后续启用不丢正文。这个边界不适用于变量操作、保留宏、带参数或嵌套表达式；这些内容缺少闭合括号仍明确报错，赋值不会部分提交。

| 来源 | 原生操作或处理 |
|---|---|
| set/get/add/inc/decvar | `module.set/get/add/inc/dec` |
| 对应 globalvar | `global.set/get/add/inc/dec` |
| 裸 `{{key}}` | 模块覆盖全局；具名空值替换为空 |
| `getvar::key::default` | 保留现有缺值默认写回扩展，纳入单域事务 |
| 嵌套表达式 | 同一 parser 分隔参数、递归求值 |
| pick/random/roll/chance 与事实宏 | 沿用有界求值；pick 不随普通前后缀长度漂移 |
| 注释、trim、ERA 标记 | 导入清洗 |
| if/else、scoped 块、STscript、变量简写、对象/数组下标宏 | 没有完整 ST 语义；需要显式审查和改写，不能当作已支持 |

**自动登记只属于 ST 导入。** 转换器扫描正文与激活键中的未声明裸引用，登记到模块 `variables`，初值为 `''`；触发键的缺值还进入报告。普通规则、模板选择器和手写模块不自动创建变量，需在变量卡手动建立。`WHO`、`stateKeys` 这类示例也遵守该边界。

正文中的角色名和用户称呼按当前转换器的名称处理；触发键保留引用再登记占位，避免凭空猜测匹配词。占位空值不是删除。模块变量跨会话持久，共享该模块的主/子会话看到同一值；不再有 ST 会话 local/global 表。

一张模板可读两域、只写一域；解析/循环/保留名/预算/双域写失败零提交。模板读取/写入、CAS、执行去重和发布失败边界见 [变量事务](architecture-params.md#规则与变量事务)。

## 不支持能力的处理

| 能力 | 实际处理 |
|---|---|
| outlet / vectorized / 条目 triggers | 记录原字段、报告不支持并禁用生成规则，避免变成无条件普通条目 |
| prompt 的生成类型触发 | 记录并禁用该规则 |
| 角色/标签动态过滤 | 保留 `characterFilter` 并报告；不实现过滤，也不据此静默丢条目 |
| automationId / STscript 自动激活 | 只记录并告警；无主键且非常驻的条目不会自动注入 |
| 历史深度、Author’s Note、Example Messages 特殊位置 | 映射到可用批位置并明确降级 |
| token 预算/上限、最少激活补扫、向量检索 | 未实现；没有等价预算或检索接口 |
| TavernHelper、扩展正则、任意脚本 | 不执行脚本，不把脚本源码注入正文 |
| 群聊轮转、跨进程 sticky/cooldown 恢复 | 未实现 |

报告的 `entries` 使用最终规则身份，`diagnostics` 给出原因，`summary` 区分转换、禁用、排除、不支持与降级。报告有展示上限，截断不影响实际转换。多源组合复用同一身份映射；同名不同变量值要求先改名，不保留动作局部变量表。

## 更新与验证

旧内部 world-book/ST 帧/会话变量字段与工具能力不作为运行兼容输入。重新导入原始 ST 来源，或经用户授权显式转换旧 module.yml；转换前备份用户文件并单独处理私有记忆标记，不能删标记后直接分享。

验收使用公共接口：预览→提交→重读→编译→实际注入，核对层、位置、时机、次数、受众、epoch、候选与 commit。未知控制项不能仅靠告警证明“没有注入”；禁用项必须检查最终行为。
