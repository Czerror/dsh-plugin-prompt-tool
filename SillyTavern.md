# SillyTavern 预设转换指南

把 SillyTavern 预设卡片 JSON（含 `prompts[]` 的预设文件）转换为本项目预设（preset.yml + promptConfigs），
转换引擎为 `src/host/sillytavern.ts` 的 `convertStToPreset`（纯函数，无文件 IO）。

**入口**：工作台「预设配置」页导入——导入包无预设定义文件（preset.yml / 任意 *.yml/*.yaml）、
仅含单个 `.json` 时自动识别并转换。转换结果为普通预设（工作台预设切换器可直接使用）。

> 按需转换原则：只按注入层级映射 SillyTavern 实际内容，**不注入本项目默认提示词**。

## 顶层字段映射

| SillyTavern 字段 | 本项目落点 | 规则 |
|---|---|---|
| `prompts[]` | `promptConfigs[]` | 逐条转换，见下节 |
| 采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`） | **剥离** | 模型参数由「模型设置」UI / 宿主默认管理——ST 卡固化值会覆盖用户在模型设置里的设置，转换不携带 |
| `{{setvar::k::v}}` / `{{getvar::k::default}}` | 顶层 `variables`（`k`） | 变量收集进预设级模板变量段（非 params），由引擎插值 |
| 未定义自定义宏（`{{日期}}` 等） | 顶层 `variables` 空值占位 | 卡内引用了但无变量源的 `{{key}}` 自动登记为空值——插值替换为空不留字面；模板变量卡片可编辑默认值；会话变量工具（`session_var`）可运行时覆盖 |
| `enable_web_search: true` | `modules` + `tool-web` | 组装 `tool-web`，`moduleConfigs.tool-web.fetch: true` |
| `enable_web_search: false` | `modules` + `tool-filter` | 不组装 tool-web，改加 `moduleConfigs.tool-filter.deny: [web_search, web_fetch]`（即使宿主装配了 web 工具也不暴露） |

## prompts[] 逐字段映射

| SillyTavern 字段 | 转换规则 |
|---|---|
| `content` | → `text`；空内容（trim 后为空）整条跳过 |
| `identifier` | → `id`；36 位 UUID 形态（`/^[0-9a-f-]{36}$/i`）退化为 `st-prompt-<序号>` |
| `name` | → `name`；缺失用 `id` |
| `enabled` | → `enabled`；`false` 原样保留（OFF 备用提示词转禁用，UI 卡片可重新启用） |
| `injection_order` | → `order`；缺失默认 100，另加 `序号 × 10` 保证声明顺序稳定 |
| `system_prompt: true` + `role: system` | → `layer: system-section` + `mergeMode: merged`（多条按 order 升序拼接为一条 system prompt） |
| `role: assistant`（非 system） | → `pre-step` + `role: assistant` |
| 其他 role | → `pre-step` + `role: user` |
| `injection_position: 0` | → `pre-step` + `position: before-all` |
| 其他 position | → `pre-step` + `position: after-user` |
| 非 system 全部 | → `strategy: static` + `dedupe: none` |

## modules / moduleConfigs 组装

| 条件 | modules | moduleConfigs |
|---|---|---|
| 始终 | `prompt-config-engine` | — |
| 含 system-section | 前插 `persona` | `persona.complete: false`（standard 语义，允许 system-section 生效；text 不声明，不注入 anchored 内容） |
| `enable_web_search: true` | 追加 `tool-web` | `tool-web.fetch: true` |
| `enable_web_search: false` | 追加 `tool-filter` | `tool-filter.includeSubagents: false` + `deny: [web_search, web_fetch]` |

## 生成预设元数据

| 字段 | 规则 |
|---|---|
| `id` | 文件名（去 `.json`）转小写 slug（非字母数字 → `-`，去首尾 `-`，**中文字符不保留**——官方 agent-presets 只认 `^[a-z0-9][a-z0-9-]*$`）；结果为空则 `st-<文件名短哈希>` |
| `name` | 卡片 `name` 字段（非空白）优先；缺失/空白时回退文件名（去 `.json`），统一加「（SillyTavern 转换）」后缀 |
| `version` / `engineCompat` | `1.0.0` / `">=0.4.2"` |

## 转换示例

输入 `roleplay-assistant.json`（SillyTavern 预设卡片）：

```json
{
  "name": "Roleplay Assistant",
  "temperature": 0.7,
  "openai_max_tokens": 2048,
  "reasoning_effort": "low",
  "enable_web_search": true,
  "prompts": [
    {
      "identifier": "intro-prompt",
      "name": "开场白",
      "content": "你是一个乐于助人的助手。",
      "role": "system",
      "system_prompt": true,
      "injection_order": 1,
      "injection_position": 0,
      "enabled": true
    },
    {
      "identifier": "guidance",
      "name": "行为准则",
      "content": "回答前先思考。",
      "role": "user",
      "injection_order": 2,
      "injection_position": 1,
      "enabled": false
    },
    {
      "identifier": "3f2a9c1e-7b4d-4f6a-9c2e-1a2b3c4d5e6f",
      "content": "备用提示词（无名称）",
      "role": "assistant",
      "injection_order": 3,
      "injection_position": 1,
      "enabled": true
    }
  ]
}
```

转换生成的 preset.yml：

```yaml
id: roleplay-assistant
name: Roleplay Assistant（SillyTavern 转换）  # 卡片 name 字段优先；空白时回退文件名
version: 1.0.0
engineCompat: ">=0.4.2"
# 采样参数不转换（模型设置 UI 管理）；setvar/getvar 变量收集进顶层 variables（本例无变量）
modules:
  - persona          # system-section 注入需要 persona 服务
  - prompt-config-engine
  - tool-web         # enable_web_search: true
moduleConfigs:
  persona:
    complete: false  # standard 语义，允许 system-section 生效
  tool-web:
    fetch: true
promptConfigs:
  - id: intro-prompt            # system_prompt + role=system → system-section
    name: 开场白
    enabled: true
    strategy: static
    order: 1                    # injection_order=1 + 0×10
    text: 你是一个乐于助人的助手。
    layer: system-section
    mergeMode: merged           # 多条 system-section 按 order 拼接
  - id: guidance
    name: 行为准则
    enabled: false              # ST OFF 状态保留，UI 可重新启用
    strategy: static
    order: 12                   # injection_order=2 + 1×10
    text: 回答前先思考。
    layer: pre-step
    mergeMode: merged
    role: user
    position: after-user        # injection_position=1 → after-user
    dedupe: none
  - id: st-prompt-3             # identifier 是 UUID 形态 → 序号兜底 id
    name: st-prompt-3
    enabled: true
    # …（strategy: static / layer: pre-step / role: assistant / position: after-user）

---

# 角色卡（PNG / JSON）导入与角色卡库

**入口**：工作台「角色管理」页（顶层第 5 页）——导入角色卡 PNG 或 JSON 到**角色卡库**，
参数不直接生成预设，而是按需「导入到当前预设」合并生效。

## 角色卡库存储（预设根下点前缀目录，官方 discovery 跳过）

```
~/.dsh/.agent-presets/.characters/<cardId>/
  ├── avatar.png      # PNG 原图（base64 解码落盘，字节无损）
  ├── card.json       # 原始角色卡 JSON 存档
  ├── converted.yml   # 转换参数（convertStToPreset 产物）
  └── memory.md       # 角色本地记忆（跟随角色卡跨预设）
```

## PNG 解析（对齐官方 character-card-parser.js）

- tEXt chunk 关键字：**ccv3 优先 / chara 兜底**，值为 base64 编码的角色卡 JSON
- 客户端字节流解析（无第三方依赖），原图提取为 `avatar.png`
- 角色卡 id 保留中文（如 `我的教师母亲`），目录名/宿主发现均支持

## 角色卡正文映射

| SillyTavern 字段 | 转换规则 |
|---|---|
| `first_mes` | → `first-mes` 开场白（pre-step / assistant / before-all / `dedupe: session` 每会话一次） |
| `alternate_greetings[]` | → `first-mes-2/3…` 备用开场白（默认禁用，UI 可切换启用） |
| `description` + `personality` + `scenario` | → `character-definition` 角色设定（system-section，拼接） |
| `system_prompt` / `post_history_instructions` | → `system-prompt` / `post-history-instructions`（system-section） |
| 采样参数（`temperature` 等） | **剥离**（模型参数归「模型设置」UI / 宿主默认） |
| `extensions.*`（TavernHelper 脚本 / regex_scripts） | **剥离**——ST 扩展注入物，不进转换产物 |

## 应用到当前预设 / 移除

- 「导入到当前预设」：角色卡全部参数（正文 + 世界书 + 记忆）合并进当前预设
  `promptConfigs`，id 带 `chara-<cardId>-` 前缀防冲突，重复应用幂等
- 「从当前预设移除」：按前缀批量移除，`meta.importedCharacters` 除名
- 多文件导入（角色卡 × 响应预设）自动合并为一个预设（`mergeStPresets`）

## 角色记忆（角色卡级，优于预设级）

- 模型工具 `world_book_upsert/delete` 的 `note` 参数按条目 id 前缀归属写入
  `.characters/<cardId>/memory.md`（跟随角色卡跨预设）；无归属回退预设 `memory.md`
- 应用到预设时记忆合并为 world-book constant 配置 `chara-<cardId>-memory`，模型直接可见

---

# 世界书（world-book 策略）

`character_book`（lorebook）条目转为 **world-book 策略配置**（`promptConfigs` 模块体系，
与普通提示词配置同一存储/编辑/工具链）。

## 条目字段映射

| SillyTavern 字段 | 落点 |
|---|---|
| `comment` | `name` |
| `content` | `text`（命中后注入） |
| `keys[]` / `secondary_keys[]` | `params.keys` / `params.secondaryKeys`（合并匹配，任一命中即注入） |
| `constant: true` | `params.constant: true`（恒注入，不依赖关键字） |
| `case_sensitive` / `match_whole_words` | `params.caseSensitive` / `params.wholeWords` |
| `use_regex: true` | `params.useRegex`（keys 按正则匹配） |
| `selectiveLogic`（0/1/2/3） | `params.selectiveLogic`——选择性触发组合逻辑（0=任一命中 / 3=副键全中 / 1=副键全不中 / 2=至少一个副键未中），由锚定匹配引擎（anchor-match）消费 |
| `insertion_order` | `order`（层内升序） |
| `enabled` | `enabled`（原样保留） |

## 注入语义

- `constant: true` → 每轮恒注入（不扫描关键字）
- 有 `keys` → 命中当前消息批文本（`extractText`）任一关键字即注入，未命中不注入
- 无 `keys` 且非常驻 → **全局条目，每轮注入**（对齐 dsh-tavern 语义）
- 注入形态：pre-step `before-all` 独立消息；`useRegex` / `caseSensitive` / `wholeWords` 控制匹配方式

## 管理方式（与模块体系统一）

- **模块列表「世界书」过滤**：主会话页模块列表顶部下拉选「世界书」，全部世界书条目以
  完整模块卡片形态展示——可编辑任意字段（id/名称/层级/策略参数/排序/启用），可批量启用/禁用
- **模型工具**：`world_book_list / world_book_upsert / world_book_delete`
  （读写 promptConfigs 的 world-book 配置；`note` 写入角色卡记忆）
- **旧数据迁移**：旧版 preset.yml 顶层 `worldBook` 段在下次重建时自动迁移为
  world-book 配置并删除段（一次性、幂等）

---

# ST 变量规则（variables 插值 + 会话变量）

ST 变量系统 = **变量读取 + 默认值兜底**，由引擎 `interpolate` 承载：预设级顶层
`variables`（writePreset 展开进生成目录 `variables.yml`，引擎合并进每条配置）+
会话变量（`session_var` 工具，会话级覆盖）。

| ST 语法 | 处理 |
|---|---|
| `{{setvar::k::v}}` | 收集 `k=v` 进顶层 `variables`（预设变量初始值 = fallback 基准），指令剥离 |
| `{{getvar::k::default}}` | 改写 `{{k}}`，`variables.k` 缺省时写入 `default`（兜底落 variables） |
| `{{getvar::k}}` | 改写 `{{k}}`（引擎按 variables 插值） |
| `{{trim}}` / `{{//注释}}` / `{{ERA:...}}` | 剥离（格式化指令 / 注释 / 第三方运行时） |
| `{{user}}` / `{{char}}` | 替换为「用户」/ 角色名 |
| `{{lastusermessage}}` / `{{lastcharmessage}}`（大小写不敏感） | 运行时宏：会话最后一条用户 / 角色消息（引擎从 session 事件提取） |
| `{{charIfNotGroup}}` | 空串（dsh 会话 header 无角色名；不残留字面） |

插值优先级：**resolved 运行时 > 会话变量（session_var） > 配置 variables > 预设 variables > 运行时宏 > 内置（DSH_HOME/WORKSPACE/CWD） > 字面保留**。

会话变量工具（模型可调用）：

```
session_var list                 → 当前会话全部变量
session_var get <key>            → 读取
session_var set <key> <value>    → 设置（{{key}} 后续注入替换；会话结束即失）
session_var clear <key> | 全部    → 清除
```

跨会话长期记忆用 `world_book` 工具的 `note` 参数（持久 memory.md，跟随角色卡）。

纯指令 prompt（setvar/注释无正文）剥离后自动过滤；TavernHelper 扩展注入物（JS 脚本）不执行、不进转换产物。
    strategy: static
    order: 23                   # injection_order=3 + 2×10
    text: 备用提示词（无名称）
    layer: pre-step
    mergeMode: merged
    role: assistant             # ST role=assistant → pre-step assistant
    position: after-user
    dedupe: none
```

## 边界与注意

- 空 `content` 的提示词整条跳过（不生成 promptConfigs 项）。
- 采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`）**不转换**——模型参数统一由「模型设置」UI / 宿主默认管理，ST 卡固化值不再覆盖用户设置。
- 未定义自定义宏自动登记为顶层 `variables` 空值占位（不留字面；模板变量卡片可编辑默认值）。
- 导入端点有路径穿越防护（仅接受扁平相对路径，拒绝 `..` / 盘符 / 绝对路径）。
- JSON 解析失败或转换异常 → 导入返回 400 `preset-package-invalid`，不会静默产生坏预设。

## 角色卡 PNG 提取（人设卡片图）

SillyTavern 人设卡片 PNG 的 JSON 藏在 PNG 的 `tEXt` chunk（键 `chara`）：
V1 = `base64(明文 JSON)`，V2 = `base64(zlib 压缩 JSON)`。项目提供提取脚本
（`scripts/extract-st-character.mjs`，零依赖，Node 内置 zlib）：

```sh
node scripts/extract-st-character.mjs card.png           # 提取角色卡 JSON → card.json
node scripts/extract-st-character.mjs --preset card.png  # 转本插件预设 JSON → card-preset.json
```

`--preset` 模式把角色卡字段映射为预设卡 JSON（`prompts[]` 结构，工作台「预设配置」页
直接导入，走与预设卡相同的转换链路）：

| 角色卡字段 | 预设 JSON prompts[] | 转换后注入层 |
|---|---|---|
| `system_prompt` | `role: system` + `system_prompt: true` | `system-section`（系统静态段） |
| `description` + `personality` + `scenario` | 合并为 `role: user` | `pre-step`（角色设定） |
| `first_mes` | `role: assistant` | `pre-step`（开场白） |
| `post_history_instructions` | `role: user` | `pre-step`（历史后指令） |
| `extensions.sampling.temperature` / `max_tokens` | 顶层 `temperature` / `openai_max_tokens` | 剥离（模型参数归「模型设置」UI） |

> 角色卡 ≠ 预设卡：角色卡描述「角色是谁」，预设卡描述「注入什么、注入到哪一层」；
> PNG 提取转换后是后者，可在工作台预设切换器中直接使用。
