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
| `role: user/assistant` | `pre-step`；相对位置映射到消息批头部或用户消息之后 |
| `marker: true` / `SPresetSettings` | 位置占位和扩展设置 dump 不作为正文注入；记录在 `meta.stDroppedMarkers` |
| `injection_position: 1` | 不具备完整历史深度等价性；原 position/depth/order/role 存 `params.stSource`，报告降级 |
| `injection_trigger` | 保留在 `params.stSource.triggers`；非空时报生成类型不兼容提示 |

各 DSH 插入点仍然独立。这里的排序不建立跨插入点的全局注入顺序，角色不同的 ST 消息
也不能被视为在 DSH 中保留了完全相同的全序。原始采样参数不导入，由宿主模型设置管理。

生成预设按需装配 `prompt-config-engine`、`character-tools`、`session-var-tools`、
`tool-config-engine`、`tool-filter`；有世界书则加 `world-book-tools`。含 system-section 时
生成 `persona: { prefix: '', complete: false }`。`enable_web_search=true` 加 `tool-web`；
显式 false 时过滤 web 工具。

## 角色卡（PNG / JSON）与角色卡库

库存储原图 `avatar.png`、源数据 `card.json`、转换定义 `converted.yml` 和角色记忆 `memory.md`。

| 字段 | 落点 |
|---|---|
| `description/personality/scenario` | 角色设定 system-section；同名内容变量可引用 |
| `system_prompt/post_history_instructions` | system-section；不是 ST 对 main/jailbreak 的完整覆盖语义 |
| `first_mes` | 一次性 assistant 开场白，`dedupe: session` |
| `alternate_greetings` | 独立备用开场白，默认禁用，用户可切换 |
| `mes_example` | 按 `<START>` 和角色标记拆成一次性示例消息；无法识别的块保留为 user 文本 |
| `character_book.entries` | ST world-book 配置 |
| `extensions` 的 regex/TavernHelper/JS | 不执行、不放入提示正文，报告兼容提示 |

「应用到当前预设」复用既有工厂和重建通道。配置 id 加 `chara-<id>-` 前缀；角色卡的
声明变量合并到所属配置的 `variables`，不覆盖预设自身变量。重复应用幂等；移除卡片不删除
预设原有变量。多个 JSON 合并时也保留每个来源的局部变量绑定。

`world_book_*` 工具的 note 写入角色 `memory.md`；应用时作为常驻条目注入。
这是 DSH 的附加管理能力，不等同于 ST 扩展脚本或 MVU 状态更新。

## ST 宏与变量

导入只做 `prepareStText`：清理注释、trim/ERA、替换默认 user/已知 char、归一宏拼写。
赋值不在导入期执行。配置带 `params.stMacros: true`，模型实际收到的是运行时求值结果。

| 宏 | 运行时行为 |
|---|---|
| `setvar/setglobalvar` | 设置 local/global，宏本身无输出 |
| `addvar/addglobalvar` | 数值相加、JSON 数组追加、非数值字符串拼接 |
| `getvar/getglobalvar` | 读取对应表；缺失返回空，兼容 `::default`；local 可回退声明变量 |
| `incvar/decvar` 及 global 形式 | 更新数值并输出新值 |
| `{{key}}` | ST local、自身声明变量、已有动态宏/内置变量依次解析 |
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
| `selective=false` | 不要求副键；非常驻且没有主键时不自动激活 |
| 0 AND_ANY | 主键命中且至少一个副键命中 |
| 1 NOT_ALL | 主键命中且至少一个副键未命中 |
| 2 NOT_ANY | 主键命中且所有副键未命中 |
| 3 AND_ALL | 主键命中且所有副键命中 |
| `constant` / `add_always` | 常驻候选；概率、分组、延迟仍可限制 |
| `selectiveLogic/selective_logic` | 副键组合逻辑；`extensions` 内两种拼写与条目顶层一并读取 |
| `extensions.case_sensitive/match_whole_words` | 与编辑器顶层别名一并读取 |
| `scan_depth` | 最近真实对话窗口（默认 2，0 不扫描聊天）；包含当前消息，排除插件注入和 reasoning 块 |
| 角色描述/性格/场景/persona 扫描开关 | 显式开启时把相应声明字段加入扫描 |
| `probability/useProbability/use_probability` | 概率过滤；同一消息状态重复求值保持抽样结果 |
| `group/group_override/group_weight` | 同组只选一个；override 优先选择高 order，否则按权重 |
| `sticky/cooldown/delay` | 按真实对话消息数维护会话内窗口，实际插入后才提交激活状态 |
| 显式 `recursive_scanning` | 有界重复匹配已选正文；支持 exclude/prevent recursion；不自动继承外部 ST 全局设置 |
| `insertion_order/order` | 选择优先级高值优先；最终正文按 ST unshift 后的低值在前 |

位置与角色仍有边界：pre-step 不能无损插入历史深度，也不能创建 system 角色消息。
position=4 降级为当前消息批末尾；其他世界书位置落在消息批头部。assistant 保留，system
降为 user；原位置/深度/角色仍在 stWorldBook 中并产生兼容提示，不冒充等价。

别名冲突按固定优先级读取：同一作用域内既有拼写（驼峰主名）优先于兼容别名，`extensions`
整体优先于条目顶层；显式 `false`/`0` 不当作缺省值丢弃。

未复刻 token 预算、向量检索、outlet、Author's Note、生成类型触发、ST 插件正则、跨进程
粘滞/冷却恢复等能力。角色卡中的源选项不会授权执行任意脚本。

## 更新与验证

- 新导入才能恢复源文件中的纯赋值卡、真实顺序表及遗漏字段；旧转换产物没有这些信息，
  单纯重新物化不能恢复，需用户重新导入并确认是否覆盖手工修改。
- 引擎更新后通过现有重建流程物化；运行中的 DSH 是否重启由用户决定，插件不会自动重启。
- 回归入口：`test/host/st-compatibility.test.mjs`、`test/engine/st-macros.test.mjs`、
  `test/engine/st-render.test.mjs`、`test/engine/st-world-book.test.mjs` 和
  `test/engine/official-variable-regression.test.mjs`。从仓库规定的隔离 cwd 运行完整测试。

### 导入预览与转换报告（2026-09-16）

`convertStToPreset()` 仍是唯一转换实现；`convertStToPresetWithReport()` 在同一路径上额外
返回结构化报告。报告是派生元数据：不写入 `preset.yml`、不进入模型上下文、也不是写入凭证。

- 预览与提交同源：`/import-preset-package`、`/characters-import` 带 `preview: true` 时
  只做转换并返回 `report` + `sourceDigest`，不落盘、不重建、不执行宏。
- 过期校验：提交带 `expectedSourceDigest` 时服务端按本次上传文件重算摘要，不一致返回
  409（`preset-preview-stale` / `characters-preview-stale`）且不写盘。
- 报告内容：来源身份（文件显示名、原 identifier/uid、序号、顺序组）、目标身份（生成的
  配置 id、层、顺序、角色、位置）、分类（等价/降级/不支持/被排除，禁用与失败区分）、
  结构化诊断（稳定 code + severity + 定位）、摘要计数、转换器版本。
- 多顺序组：`prompt_order` 歧义保持拒绝；显式 `promptOrderCharacterId`（或文件内
  `character_id`）才选择，未选中的组在报告中标记 `selected: false`。
- 兼容：`meta.stWarnings` 由结构化诊断派生（同一事实来源，消息仍去重），有损映射在预览里
  单独列为需确认项。条数上限：条目 500、诊断 200，超出标 `truncated`。
- 边界：PNG 流式导入（`/characters-import-stream`）保持既有行为，暂不提供预览；
  世界书运行期诊断见 [引擎复用](engine-reuse.md) 的入选/落选诊断一节。

### 工作台入口（2026-09-16）

- 预设导入（预设切换器）与角色卡 JSON 导入（角色管理页）都走「预览 → 确认 → 提交」：
  预览来自同一个 `convertStToPresetWithReport()`，确认时回传 `expectedSourceDigest`。
  取消预览不产生任何写入；来源摘要变化时服务端返回 409，界面要求重新选择文件。
- 有损项（深度注入降级、system 角色降级、不支持的控制项、被排除条目）在预览卡里逐条列出，
  用户确认后才写入；预览身份本身不是写入授权。
- 世界书筛选视图（主会话页「世界书」过滤）显示只读诊断卡：记录来自引擎真实选择路径，
  展示配置 id、阶段（未参与/被拒/候选/入选/已注入）与稳定原因码；刷新只重读、不重新求值。
- 角色卡 PNG 流式导入与大 JSON 流式导入仍即时入库，不经过预览（受既有 32 MiB JSON /
  64 MiB 流式上限约束）。
