# SillyTavern 导入与兼容边界

转换器为 `src/host/sillytavern.ts`。目标是把 ST 的声明式内容映射到本项目预设，
不执行 ST 扩展脚本，也不声称复刻 ST 的完整会话运行时。导入成功、YAML 可解析或零告警
只代表结构可用；行为需按启停、顺序、变量、触发条件、角色和位置验证。

## 输入与入口

- 「预设配置」导入：没有 YAML 预设定义时，JSON 可为含 `prompts[]` 的预设、角色卡，
  或顶层 `entries` 的独立世界书；多个 JSON 合并后沿同一预设物化通道写盘。
- 「角色管理」导入：PNG/JSON 先进入 `.agent-presets/.characters/<id>/`，再由用户应用到预设。
- PNG 按魔数判断而非扩展名，读取 `tEXt` 的 `ccv3`，缺失时回退 `chara`；保留原图和原始 JSON。
- id 从文件名生成合法英文 slug；纯中文文件名回退 `st-<短哈希>`，显示名仍保留中文。
- 兼容提示存放于 `meta.stWarnings`；物化时通过现有 warn 通道报告。原始文件不修改。

## JSON 预设

| 输入 | 转换行为 |
|---|---|
| `prompts[].content` | 保留为配置模板；注释清理后空白内容跳过，纯赋值模板不跳过 |
| `identifier` / `name` | 标识与名称；UUID 标识转为 `st-prompt-N`，名称用 YAML 安全标量输出 |
| `prompt_order[].order[]` | 选择 `character_id` 对应表，默认选择全局表 `100001`；只有一张表时使用该表；多表且无法选择时拒绝 |
| 顺序表的 `enabled` | 优先于 `prompts[].enabled`；未在所选表出现的条目禁用；无顺序表时才回退条目自身 |
| 相对顺序 | 使用顺序表次序；无顺序表时使用数组次序。与原始 UUID 对应后再生成 id |
| `role: system` | `system-section`，同层可合并 |
| `role: user/assistant/model` | `pre-step`；相对位置映射到消息批头部或用户消息之后。pre-step 只发出 user：assistant/model 在导入期降级，原角色保留在 `params.stSource.role` |
| `marker: true` / `SPresetSettings` | 位置占位和扩展设置 dump 不作为正文注入；记录在 `meta.stDroppedMarkers` |
| `injection_position: 1` | 不具备完整历史深度等价性；原 position/depth/order/role 存 `params.stSource`，报告降级 |
| `injection_trigger` | 保留在 `params.stSource.triggers`；非空时报生成类型不兼容提示 |
| `prompts[].system_prompt` | 只保留事实（`params.stSource.systemPrompt`）并记 info：ST 用它标记内置/全局 prompt 的管理位（不可删除、不参与导出、不在 append 候选），不改变发送角色与位置，因此层归属仍按 `role` |

各 DSH 插入点仍然独立。这里的排序不建立跨插入点的全局注入顺序，角色不同的 ST 消息
也不能被视为在 DSH 中保留了完全相同的全序。原始采样参数不导入，由宿主模型设置管理。

生成预设按需装配 `prompt-config-engine`、`character-tools`、`session-var-tools`、
`tool-config-engine`；有世界书则加 `world-book-tools`。含 system-section 时
生成 `persona: { prefix: '', complete: false }`。`enable_web_search=true` 加 `tool-web`；
显式 false 时产出三条 `triggers` 声明（`assembly` 呈现剔除 + `sdk-strip` 裁 `tools:sdk`
正文 + `guard` 执行层拒绝，共用同一份 `deny: [web_search, web_fetch]`），
`writePreset` 把该段物化为 `triggers.yml`，`declared-triggers` 行自动补装配。

## 角色卡（PNG / JSON）与角色卡库

库存储原图 `avatar.png`、源数据 `card.json`、转换定义 `converted.yml` 和角色记忆 `memory.md`。

| 字段 | 落点 |
|---|---|
| `description/personality/scenario` | 角色设定 system-section；同名内容变量可引用 |
| `system_prompt/post_history_instructions` | system-section；不是 ST 对 main/jailbreak 的完整覆盖语义 |
| `first_mes` | 一次性开场白，`dedupe: session`；ST 的 assistant 侧降级为 user，原角色存 `params.stSource.role` |
| `alternate_greetings` | 独立备用开场白，默认禁用，用户可切换；同样降级为 user |
| `mes_example` | 按 `<START>` 和角色标记拆成一次性示例消息；assistant 轮次降级为 user（原角色存 `params.stSource.role`），无法识别的块保留为 user 文本 |
| `extensions.depth_prompt` | 只在群聊自动注入（ST 语义），本项目没有群聊：保留为一条**默认禁用**的 pre-step 配置（`st-depth-prompt`，来源与原因码 `depth-prompt-group-only` 齐全），用户可手动启用；同时登记 `depth_prompt` 变量供扫描开关使用 |
| `creator_notes` | 登记为 `creator_notes` 内容变量，供世界书条目按需扫描（ST 的 `globalScanData.creatorNotes` 同名来源） |
| `character_book.entries` | ST world-book 配置 |
| `extensions` 的 regex/TavernHelper/JS | 不执行、不放入提示正文，报告兼容提示 |

「应用到当前预设」复用既有工厂和重建通道。配置 id 加 `chara-<id>-` 前缀；角色卡的
声明变量合并到所属配置的 `variables`，不覆盖预设自身变量。重复应用幂等；移除卡片不删除
预设原有变量。多个 JSON 合并时也保留每个来源的局部变量绑定。

`world_book_*` 工具的 note 写入角色 `memory.md`；应用时作为常驻条目注入。
这是 DSH 的附加管理能力，不等同于 ST 扩展脚本或 MVU 状态更新。

### 应用与移除的模块语义（2026-09-18）

「应用到当前预设」按卡的实际需要装配模块，不再固定追加四件套；移除时对称回退：

- **声明优先**：卡顶层 `modules` 存在时按声明追加。ST 转换产物自带 `prompt-config-engine`、`character-tools`、
  `world-book-tools`（有世界书时）、`session-var-tools`、`tool-config-engine` 的声明，
  所以 ST 卡的应用行为与改造前一致。
- **必需项兜底**：`prompt-config-engine` 始终补齐——缺少该行时 `promptConfigs` 不会生效，且不会有任何报错；
  卡含 `world-book` 策略配置时补 `world-book-tools`。因此未声明 `modules` 的手写卡只会得到必需项。
- **来源记录**：应用时把「追加前没有、追加后有」的差集写入 `preset.yml` 的 `meta.characterModules[<卡 id>]`；
  预设原本就有的模块不会被记成这张卡引入的。来源记录保留到模块完成回退；首次引入它的卡先被移除时，
  记录仍保留给后续消费者，因此两张卡按任意顺序全部移除都能回退共享模块。
- **移除回退**：按记录删除模块，删除前检查消费者——其他已导入卡仍引用（各自的记录或 `converted.yml` 里的声明）、
  或预设内容仍需要它（还有 `promptConfigs` / `world-book` 配置 / `params.stMacros` / 顶层 `customTools`）时保留。
  **改造前应用过的卡没有记录，移除时不会回退模块**：
  无从判断归属，宁可留下模块也不误删用户或引擎要用的装配。
- **手写卡的档位**：用 `group` + `exclusive`（同一互斥组只运行排序最前的启用配置）表达档位三选一；
  本项目没有 `/命令` 式切换通道，切换在工作台的提示词配置页完成（关闭当前档、打开目标档）。
- 两条路径的取舍：ST 导入路径保持原有模块清单不变（ST 的宏与状态变量确实需要 `session-var-tools`），
  角色卡应用路径按声明与必需项装配。二者共用同一份移除回退逻辑。

## ST 宏与变量

导入只做 `prepareStText`：清理注释、trim/ERA、替换默认 user/已知 char、归一宏拼写。
赋值不在导入期执行。配置带 `params.stMacros: true`，模型实际收到的是运行时求值结果。

| 宏 | 运行时行为 |
|---|---|
| `setvar/setglobalvar` | 设置 local/global，宏本身无输出 |
| `addvar/addglobalvar` | 数值相加、JSON 数组追加、非数值字符串拼接 |
| `getvar/getglobalvar` | 读取对应表；缺失返回空；local 可回退声明变量。`::default`（缺失时取第二参数，非空则写回表，`engine/st-macros.mjs:177-183`）是**本项目扩展**：ST 的 `getvar` 只声明一个参数（`macros/definitions/variable-macros.js:99-116`），多给的参数按参数个数报错、宏文本原样保留（`macros/engine/MacroEngine.js:229-237`） |
| `incvar/decvar` 及 global 形式 | 更新数值并输出新值 |
| `{{key}}`（**本项目扩展**） | ST 的裸 `{{key}}` 从不查变量：没有注册同名宏时原样保留（`macros/engine/MacroEngine.js:215-218`）。本项目按 ST local、自身声明变量、已有动态宏/内置变量依次解析（`engine/st-macros.mjs:198-206`、`engine/interpolate.mjs:108-138`） |
| 时间与最后消息宏 | 运行时求值，不登记为空默认值 |
| `random` | 支持 `::` 或逗号分隔，转义逗号保留，每次出现求值 |
| `pick` | 会话、模板位置确定的稳定选择；不复刻 ST 的具体随机序列或 reroll 命令 |
| `roll` | `NdM±K` 或数字（按 `1dN`），非法输入空输出 |

同一请求的 ST 模板按声明顺序构造变量帧；禁用和不匹配受众的模板不执行，纯赋值卡可以
独立启停。多个官方插入点读取同一帧不会重复自增。world-book 只在命中时求值，一次性卡只在
实际注入时求值。宏解析限制输入/输出 1 MiB、嵌套 32 层及总展开工作量，拒绝循环和原型键；
单卡失败不提交其变量修改，也不阻断其他卡。

local/global 两张表隔离，但目前均为会话内、mount 生命周期状态；**global 不跨会话持久化，
恢复进程或重挂不会恢复 ST 宏状态**。`session_var` 可显式覆盖 local，clear 回退默认值。
这不是 ST 的全局持久变量或 slash-command 运行时。

普通（非 ST）配置继续使用官方变量注册通道：按局部命名空间绑定变量，相同事实名的大小写
形式共用注册，非法官方名用确定性别名。声明值与会话覆盖值先有界展开，再清洗未解析引用；
空白引用规范化，避免官方严格渲染器抛错。所有注册跟随 scope/disposer。

## 世界书

ST 导入在既有 `buildWorldBookEntry` 结构上添加 `params.stWorldBook`，与原生世界书策略区分。
原生手写 world-book 的历史约定保持不变，不能把它当作 ST 等价模式。

| ST 语义 | 导入后的处理 |
|---|---|
| `keys/key`、`secondary_keys/keysecondary` | 保留；只有主键命中才能进行选择性判断 |
| `keys`/`secondary_keys` 里的 ST 宏 | 匹配前求值，方向对齐 ST 的 `substituteParams`（`world-info.js:4914-4917`、`world-info.js:4946-4948`），但**求值面窄于 ST**：只用配置声明的变量表（`engine/st-world-book.mjs:114-116`）。`session_var` 维护的会话变量只在 `engine/layers.mjs:111`、`engine/executor.mjs:229` 显式并入，运行时 `setvar` 写入的 ST local 帧（`engine/st-render.mjs:74-85`）同样不在键的求值面里；`{{getvar::x}}` 一族也不求值（`engine/interpolate.mjs:108-138` 无对应分支），保持字面量参与匹配。卡内无源的宏（如只存在于 ST 全局 persona 的 `{{user}}`）登记为空占位并产出 `st-key-macro` 诊断：未赋值时该键不参与匹配（不会退化成字面量误判），在「模板变量」赋值后按既有匹配路径生效 |
| `selective=false` | 不要求副键；非常驻且没有主键时不自动激活 |
| 0 AND_ANY | 主键命中且至少一个副键命中 |
| 1 NOT_ALL | 主键命中且至少一个副键未命中 |
| 2 NOT_ANY | 主键命中且所有副键未命中 |
| 3 AND_ALL | 主键命中且所有副键命中 |
| `constant` / `add_always` | 常驻候选；概率、分组、延迟仍可限制 |
| `selectiveLogic/selective_logic` | 副键组合逻辑；`extensions` 内两种拼写与条目顶层一并读取 |
| `extensions.case_sensitive/match_whole_words` | 与编辑器顶层别名一并读取 |
| `scan_depth` | 最近真实对话窗口（默认 2，0 不扫描聊天）；包含当前消息，排除插件注入和 reasoning 块 |
| `delayUntilRecursion` / `delay_until_recursion` | 延迟到递归扫描：非递归 pass 一律抑制（sticky 命中例外），递归 pass 中按层级池判断是否解锁；层级池取条目集合里的最小层级并逐个打开 |
| `useGroupScoring` / `use_group_scoring` | 组内评分：组内存在显式开启的条目时整组按主/副键命中数评分，只有开启评分的条目会被淘汰（严格低于最高分），未开启者不被淘汰但其分数计入最高分 |
| `characterFilter` | 真实形态是嵌套对象 `{ names, tags, isExclude }`（不是三个顶层字段）；原样保留到 `params.stWorldBook.characterFilter`，在两个维度至少一个非空时告警「按角色过滤不受支持」——不实现过滤、也不据此跳过条目 |
| `automationId` / `automation_id` | 顶层驼峰与 extensions 蛇形都读；字段类型是字符串，非字符串形态（数字 0、布尔）视为未设置；非空时保留事实并告警「依赖 STscript 自动化」，其中无主键且非常驻的条目额外说明「不会自动注入」 |
| `outletName` / `outlet_name` | 双形态读取；非空时保留事实并计入不支持控制项（`unsupported-controls`） |
| 角色描述/性格/场景/persona 扫描开关 | 显式开启时把相应声明字段加入扫描 |
| `matchCreatorNotes` / `match_creator_notes` | 显式开启时把卡片 `creator_notes`（清洗后）加入扫描文本；未开启时不并入，既有触发面不变 |
| `matchCharacterDepthPrompt` / `match_character_depth_prompt` | 显式开启时把 `extensions.depth_prompt.prompt`（清洗后）加入扫描文本；未开启时不并入 |
| `probability/useProbability/use_probability` | 概率过滤；同一消息状态重复求值保持抽样结果 |
| `group/group_override/group_weight` | 同组只选一个；override 优先选择高 order，否则按权重 |
| `sticky/cooldown/delay` | 按真实对话消息数维护会话内窗口，实际插入后才提交激活状态 |
| 显式 `recursive_scanning` | 有界重复匹配已选正文；支持 exclude/prevent recursion；不自动继承外部 ST 全局设置 |
| `insertion_order/order` | 选择优先级高值优先；最终正文按 ST unshift 后的低值在前 |

位置与角色仍有边界：pre-step 不能无损插入历史深度，也不能创建 system 角色消息。
position=4 降级为当前消息批末尾；其他世界书位置落在消息批头部。`role: 0`（system）与
`role: 2`（assistant）都降级为 user；原位置/深度/角色仍在 stWorldBook 中并产生诊断，
不冒充等价。

别名冲突按固定优先级读取：同一作用域内既有拼写（驼峰主名）优先于兼容别名，`extensions`
整体优先于条目顶层；显式 `false`/`0` 不当作缺省值丢弃。

未复刻 token 预算、向量检索、outlet、Author's Note、生成类型触发、ST 插件正则、跨进程
粘滞/冷却恢复等能力。角色卡中的源选项不会授权执行任意脚本。

键宏的恢复路径不新增通道：诊断只说明哪条条目的触发键需要赋值，赋值仍在工作台
「模板变量」里完成，写入 `variables.yml` 后按既有重建流程生效。本项目不猜测 `{{user}}`
的值（它来自 ST 全局设置与 persona，卡内不存在，用同义词反推属猜测），也不在导入期执行宏。

## 未复刻的 ST 能力与降级对照

下表每行都与实现一致：**等价** = 行为与 ST 一致；**降级** = 内容保留但位置/角色/时机改变；
**保留事实** = 只记录来源字段，行为不生效；**不支持 / 未复刻** = 本项目不执行该能力。
诊断码列写的是真实产出（`st-*` 是导入期诊断码，括号内是报告条目的原因码或引擎原因码）。
ST 源码路径相对 `public/scripts/`，对照基线为 SillyTavern 1.19.0 / `7c399419`（新宏引擎在该版本默认开启：`power-user.js:302`）。

| ST 能力 / 字段 | ST 行为（源码位置） | 本项目处理 | 诊断码 |
|---|---|---|---|
| `world_info_budget`（默认 25）/ `budget_cap` / `ignoreBudget` | 按 token 预算裁剪注入（`world-info.js:73`、`:4095`） | **未复刻**：不做 token 预算裁剪，入选条目按顺序全部注入 | 无（不产生诊断） |
| `forbid_overrides` | 保护 `main` / `jailbreak` 不被角色卡覆盖（`openai.js:1495-1513`） | **保留事实**：DSH 没有 prompt 覆盖机制，字段不产生行为 | 无 |
| `min_activations` / `min_activations_depth_max`（默认 0） | 深度偏斜补足最少激活数（`world-info.js:5110-5126`） | **未复刻**：不实现深度偏斜 | 无 |
| ST 全局开关 `recursive` / `use_group_scoring` / `case_sensitive` / `match_whole_words` | 全局默认 false（`world-info.js:69-82`），条目可继承 | **逐条目读取**：按条目字段判定，不读 ST 全局设置；缺省即按 false 语义 | 无 |
| 位置 `ANTop(2)` / `ANBottom(3)` / `EMTop(5)` / `EMBottom(6)` | Author's Note / Example Messages 插入点（`world-info.js:855-864`） | **降级**：落到当前消息批头部，原位置保留在 `stWorldBook.position` | `st-worldbook-position`（`position-downgraded`） |
| 位置 `atDepth(4)` | 插入历史深度 | **降级**：保留 position/depth/role，落到当前消息批末尾 | `st-worldbook-depth`（`depth-collapsed`） |
| 位置 `outlet(7)` 与 `outletName` | outlet 注入通道 | **不支持**：保留 `outletName` 事实，内容不被误注入 | `st-worldbook-controls`（`unsupported-controls`） |
| `vectorized` | 向量检索激活条目 | **不支持**：只保留字段 | `st-worldbook-controls`（`unsupported-controls`） |
| `triggers`（生成类型触发） | 按生成类型过滤（`world-info.js:4807-4813`） | **不支持**：保留在 `stSource.triggers`，不按生成类型过滤 | `st-prompt-triggers` / `st-worldbook-controls` |
| `automationId`（STscript 自动化） | 由自动化脚本激活条目 | **不支持**：保留事实并告警；无主键且非常驻时明确「不会自动注入」 | `st-worldbook-automation`（`automation-dependent`） |
| `characterFilter`（角色 / 标签过滤） | 按当前角色头像名或标签过滤条目（`world-info.js:4815-4843`） | **不支持**：保留嵌套对象，条目对所有角色生效（不静默跳过） | `st-worldbook-character-filter`（`character-filter-unsupported`） |
| `extensions.depth_prompt` | 只在群聊自动注入（`group-chats.js:459-464`） | **降级**：保留为默认禁用的 pre-step 配置，登记 `depth_prompt` 变量 | `st-depth-prompt`（`depth-prompt-group-only`） |
| 群聊（多角色轮转） | `group-chats.js` 逐成员注入 | **未复刻**：本项目是单角色会话 | 无 |
| 跨进程 sticky / cooldown 恢复 | 持久化在 `chat_metadata.timedWorldInfo`（`world-info.js:619-660`） | **未复刻**：时间窗状态只在会话内、随 mount 生命周期 | 无 |
| ST 插件正则 / 扩展脚本 / TavernHelper | `regex_scripts` 等在 ST 内执行 | **不执行**：脚本不进入提示正文 | `st-extension-scripts` |
| `allowWIScan` 的扩展提示词扫描 | `setExtensionPrompt(..., scan)` 让扩展文本无条件进入扫描（`world-info.js:4719-4726`） | **未复刻**：只按条目开关并入 `creator_notes` / `depth_prompt` | 无 |
| `prompts[].system_prompt` | 仅作「内置/全局 prompt」管理位（`openai.js:1240-1257`） | **等价**：不改变层归属，只保留来源事实 | `st-prompt-system-flag`（info） |
| `selective` 缺省值 | 求值用 `entry.selective &&`，`undefined`/`false` 都不过滤（`world-info.js:4925`） | **等价**：`entry.selective === true` 与 ST 求值路径一致 | 无 |
| `use_regex` | 匹配器不消费该字段，只有 `/pattern/flags` 形态才当正则 | **等价**：缺省时自动检测 `/pattern/flags` | 无 |
| `world_info_logic` / `world_info_position` 默认值、`scan_depth`、`case_sensitive`、`match_whole_words`、`recursive` 的条目级默认 | 与 ST 定义一致 | **等价** | 无 |
| `{{.key}}` / `{{$key}}` 变量简写与运算符 | 本地/全局变量简写，支持 `++ -- = += -= ?? == != > >= < <=` 等运算符（`macros/engine/MacroLexer.js:101-119`、`macros/engine/MacroParser.js:80-117`、`macros/engine/MacroCstWalker.js:651-795`） | **未复刻**：不解析简写与运算符。`{{.key}}` 在导入期被当成普通裸引用登记为空占位（`src/host/sillytavern.ts:769` 的键字符集含点），正文里替换为空串、世界书主键被过滤（`engine/st-world-book.mjs:114`）；`{{$key}}` 既不登记也不匹配插值正则（`engine/interpolate.mjs:180`），作为未解析引用被移除（`engine/st-render.mjs:82-83`） | 无 |
| `{{if}}` / `{{else}}` 与 scoped 块、`#`/`/` flag | 条件块按真值选分支并支持 scoped 内容与 `{{else}}`（`macros/definitions/core-macros.js:134-225`）；闭合块内容作为最后一个无名参数、默认自动 trim、`#` 保留空白（`macros/engine/MacroCstWalker.js:438-469`、`macros/engine/MacroFlags.js:56-73`） | **未复刻**：这些宏不注册，条件不参与判断——`{{if}}`/`{{else}}`/`{{/if}}` 标签按未解析引用被移除（`engine/st-render.mjs:82-83`），两个分支的正文都会留下 | 无（正文出口只发一条聚合 warn） |
| `hasvar` / `deletevar` / `setvarkey` / `getvarkey` 及 global 形式（另带 `varexists`/`flushvar`/`setvarindex`/`getvarindex` 等别名，共 8 个宏） | 本地与全局变量的存在性检查、删除、对象/数组键读写（`macros/definitions/variable-macros.js:119`、`:139`、`:159`、`:189` 与 `:323`、`:343`、`:363`、`:393`） | **未复刻**：`engine/st-macros.mjs:168` 只识别 `set`/`add`/`get`/`inc`/`dec` 加可选 `global` 的变量宏，这些宏按未解析引用被移除（`engine/st-render.mjs:82-83`）；变量表是扁平字符串，没有嵌套键/数组语义（`engine/interpolate.mjs:119`） | 无 |
| scoped `{{setvar::k}}正文{{/setvar}}` | 闭合块内容成为最后一个无名参数，任何宏都可 scoped（`macros/engine/MacroFlags.js:56-63`、`macros/engine/MacroCstWalker.js:438-469`） | **未复刻**：`{{setvar::k}}` 缺第二个参数时既不赋值也不吞正文（`engine/st-macros.mjs:185-195`），两个标签按未解析引用被移除（`engine/st-render.mjs:82-83`）——正文留下，赋值不发生 | 无 |
| 世界书键的宏求值面（会话变量） | 匹配前对主键/副键逐个 `substituteParams`（`world-info.js:4914-4917`、`world-info.js:4946-4948`），走同一套宏引擎（`../script.js:2997-3014`），`{{getvar::x}}` 读会话内 local 表 | **降级**：只用配置声明变量求值（`engine/st-world-book.mjs:114-116`），不含会话变量（会话变量表只在 `engine/layers.mjs:111`、`engine/executor.mjs:229` 显式并入）；`{{getvar::x}}` 一族不求值，保持字面量参与匹配（`engine/interpolate.mjs:108-138`） | 无 |
| 原生（手写）`world-book` 的 `keys` | 条目来源不改变键求值：任何条目都在匹配前对主键/副键 substituteParams（`world-info.js:4914-4917`、`:4946-4948`） | **未复刻**：原生 `world-book` 策略把 `params.keys` 原样交给匹配器，键里的 `{{key}}` 是字面量（`engine/strategies.mjs:149-158`、`:170-175`）；只有 ST 导入路径插值（`engine/st-world-book.mjs:114-116`） | 无 |

预算类字段（`world_info_budget` / `budget_cap` / `ignoreBudget`）与 `min_activations` 需要官方
tokenizer 与上下文预算通道，超出本插件的宿主边界；`forbid_overrides` 对应的覆盖机制在 DSH
不存在。这些差异不会让内容静默丢失：来源字段保留在 `params.stWorldBook` / `params.stSource`，
报告按「降级 / 不支持」分类，不冒充等价。

## 更新与验证

- 新导入才能恢复源文件中的纯赋值卡、真实顺序表及遗漏字段；旧转换产物没有这些信息，
  单纯重新物化不能恢复，需用户重新导入并确认是否覆盖手工修改。
- 引擎更新后通过现有重建流程物化；运行中的 DSH 是否重启由用户决定，插件不会自动重启。
- 回归入口：`test/host/sillytavern-convert.test.mjs`、`test/host/pre-step-persistence.test.mjs`、
  `test/engine/st-render-macros.test.mjs`、`test/engine/st-world-book.test.mjs` 和
  `test/engine/official-variable-regression.test.mjs`。从仓库规定的隔离 cwd 运行完整测试。

### pre-step 角色出口（2026-09-17）

- 宿主把 pre-step 批次的每条消息写成 `user/message` 事件，事件校验要求 `role === "user"`；
  assistant 只能来自模型侧 `assistant/message` 事件。因此 ST 的 assistant/system 角色在
  **导入期**就降级为 user，**运行出口**再兜底一次：执行器创建消息时统一发出 user，旧预设里
  声明的 assistant（含模板 patch 给出的角色）保留正文、只告警一次，原角色记入
  `source.requestedRole`，不把非法值传给宿主。
- 导入期降级逐条留痕：条目分类为 `degraded`、原因码 `assistant-role-downgrade`，原角色保留在
  `params.stSource.role`（prompt / 开场白 / 示例对话）或 `params.stWorldBook.role`（世界书），
  并产生 info 级诊断（同类来源只发一条，不刷屏）。预览报告因此不把这些条目报成「等价」。
- 兼容边界：旧 `preset.yml` 里的 `role: assistant` 仍可加载（引擎接受 `user` 与 `assistant`
  两种输入），但工作台角色选项只提供可发出角色 `user`；已有 assistant 条目在表单里显示降级提示，
  不做自动回写。
- 验收入口：`test/host/pre-step-persistence.test.mjs` 用已发布 `@deepseek-ai/dsh-session` 走
  「注入 → 事件持久化 → 重新加载 → 派生请求」，旧 assistant 夹具必须在加载时触发真实角色校验错误。

### 顺序组选择、预览版本与报告身份（2026-09-17）

- 选组优先级（唯一实现，转换与预览共用）：请求显式 `promptOrderCharacterId` → 文件内
  `character_id` → 全局组 `100001` → 仅有一组时回退。显式选择必须命中：找不到时明确报错，
  不回落；同一 `character_id` 重复出现时拒绝（无法明确对应）。
- 首次预览即歧义（多组且按优先级无法确定）时返回 `state: 'needs-order-selection'` 与有界候选
  （`candidates: [{ characterId, entries }]` 加来源文件显示名），此时**没有**报告与写入凭据、
  确认按钮禁用；用户在预览卡里选择顺序组后立即重新预览，`state: 'ready'` 才可确认。
  提交仍拒绝歧义——候选状态从未宣称已转换。
- 预览版本：预览除 `sourceDigest`（本次上传文件内容）外返回 `previewRevision`，由服务端对
  预览协议版本、转换器版本、规范化文件有序数组、实际选组与目标身份（导入类型、目标 id、
  目标**当前**内容版本、目标归属）计算。提交携带 `expectedPreviewRevision`，服务端重算：
  文件、选组、转换器版本或目标（含预览期间被用户改动的目标）任一不符即 409
  （`preset-preview-stale` / `characters-preview-stale`）且零写盘。目标"不存在"与"已存在"
  必须可区分。旧调用只带 `expectedSourceDigest` 时仍按文件校验，但若要新的选组覆盖则必须重新预览。
- 客户端不计算版本：换文件、换组、目标变化都让旧 ready 失效并重新预览；迟到的预览响应按
  请求序号丢弃，重预览期间卡片保留但确认禁用（可继续换组）。
  重预览期间取消会失效在途结果；迟到响应不能恢复卡片或触发提交。
- 报告身份：多文件合并的最终 id 只由合并分配一次，报告条目的 `targetId` 消费同一份映射
  （`targetIndex` 关联到生成配置下标），并附 `sourceName` / `sourceFileIndex`；
  `sourceId` 表达来源身份、`targetId` 表达目标身份，被排除条目没有目标身份。
- 有损信息完整展示：预览卡渲染服务端返回的全部 warning、info 级降级与被排除条目
  （长列表在容器内滚动，容器可键盘聚焦），每条带来源/目标定位，不存在前端二次截断。
  服务端报告被截断时明确给出已展示条目数、诊断数与来源条目总数，并建议拆分导入复核，
  不标成"全部已展示"。

### 导入预览与转换报告（2026-09-16）

`convertStToPreset()` 仍是唯一转换实现；`convertStToPresetWithReport()` 在同一路径上额外
返回结构化报告。报告是派生元数据：不写入 `preset.yml`、不进入模型上下文、也不是写入凭证。

- 预览与提交同源：`/import-preset-package`、`/characters-import` 带 `preview: true` 时
  只做转换并返回 `report` + `sourceDigest`，不落盘、不重建、不执行宏。
- 入口参数严格区分缺省与非法类型：`preview` 只接受布尔（省略或 `false` = 显式提交，
  `true` = 只读预览）；字符串 `"true"`、数值、`null`、数组、对象返回 400。
  `expectedSourceDigest` 提供时必须是 SHA-256 十六进制摘要，`promptOrderCharacterId`
  必须是有界非空字符串；`files` 容器与条目（path/content）类型错误一律 fail closed。
  校验全部发生在创建目录、备份、写盘与重建之前，错误请求对目录树与重建回调零副作用。
- 过期校验：提交带 `expectedSourceDigest` 时服务端按本次上传文件重算摘要，不一致返回
  409（`preset-preview-stale` / `characters-preview-stale`）且不写盘。
- 报告内容：来源身份（文件显示名、原 identifier/uid、序号、顺序组）、目标身份（生成的
  配置 id、层、顺序、角色、位置）、分类（等价/降级/不支持/被排除，禁用与失败区分）、
  结构化诊断（稳定 code + severity + 定位）、摘要计数、转换器版本。
- 多顺序组：`prompt_order` 歧义保持拒绝；显式 `promptOrderCharacterId`（或文件内
  `character_id`）才选择，未选中的组在报告中标记 `selected: false`。
- 兼容：`meta.stWarnings` 由结构化诊断派生（同一事实来源，消息仍去重），有损映射在预览里
  单独列为需确认项。条数上限：条目 500、诊断 200，超出标 `truncated`。
  上限只限制展示数组；分类摘要与 `needsReview` 统计全部输入，完整去重告警继续保存在
  `meta.stWarnings`，不会因较早的 info 记录耗尽展示额度而丢失。
- 世界书副键中的无源宏求值为空时仍代表一项未命中的条件；AND_ANY/AND_ALL 不因此取消
  副键约束，NOT_ALL/NOT_ANY 也按原始副键数量及实际命中数判断。
- PNG 与大 JSON 的原始流仅暂存；所有载体统一预览后提交，旧直接入库端点返回刷新页面提示。
  世界书运行期诊断见 [引擎复用](engine-reuse.md) 的入选/落选诊断一节。

### 工作台入口（2026-09-18）

- 预设导入（预设切换器）与角色卡 PNG/JSON/YAML 导入（角色管理页）都走「预览 → 确认 → 提交」：
  预览来自同一个 `convertStToPresetWithReport()`，确认时回传 `expectedSourceDigest`。
  取消预览不写目标；来源或目标版本变化时返回 409，保留来源并要求重新预览。
- 预设目录中的定义、正文和自有附件共同预览；技能库与指令文件不属于预设交换包。
  无原生定义的多个 ST 来源按输入顺序合并为预设。角色卡按文件逐张确认，“跳过这张”和“结束本次导入”分别控制当前项与剩余批次。
- 有损项（深度注入降级、system 角色降级、不支持的控制项、被排除条目）在预览卡里逐条列出，
  用户确认后才写入；预览身份本身不是写入授权。
- 世界书筛选视图（主会话页「世界书」过滤）显示只读诊断卡：记录来自引擎真实选择路径，
  展示配置 id、阶段（未参与/被拒/候选/入选/已注入）与稳定原因码；刷新只重读、不重新求值。
- JSON bridge 上限为 32 MiB，原始上传及 ZIP 解压总量上限为 64 MiB；大小只影响传输，不改变确认时机。完整格式、事务、记忆保留与导出规则见 [资产交换](asset-transfer.md)。
