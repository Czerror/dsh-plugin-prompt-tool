# Changelog

## [0.5.0] - 2026-08-22

### 角色卡 / 世界书 / ST 变量（SillyTavern 全链路）

- **角色卡库**：SillyTavern 角色卡（PNG tEXt chunk `ccv3`/`chara` 或 chara_card JSON）导入独立库 `~/.dsh/.agent-presets/.characters/<id>/`（原图 / 原始 JSON / 转换参数 / 角色记忆），按需「导入到当前预设」（`chara-<卡>-` 前缀合并、幂等可移除）；多文件（角色卡 × 响应预设）自动合并；中文 id 支持
- **角色记忆**：`memory.md` 跟随角色卡跨预设，应用时合并为 world-book constant 配置注入；世界书工具 `note` 参数按 id 前缀归属写入卡记忆
- **世界书回归模块体系**：`character_book` 转 world-book 策略配置（`keys` 命中触发 / `constant` 常驻 / `useRegex` 正则 / `caseSensitive` / `wholeWords`），与普通模块同一存储与编辑；模块列表「世界书」过滤 + 批量启用/禁用；旧 `worldBook` 段自动迁移
- **ST 变量 fallback**：`setvar` 收集进 params、`getvar`（含默认值）改写 `{{key}}` 由引擎插值兜底（key 支持中文）；`trim`/注释/ERA 剥离、`{{user}}`/`{{char}}` 替换、TavernHelper 扩展注入物剥离
- **模型工具 8 个**：`character_import/apply/remove/delete/list` + `world_book_list/upsert/delete`（会话中直接管理角色卡与世界书）
- **UI**：角色管理页（方块卡片）、模块列表合并过滤下拉（全部/世界书/层级）+ 批量开关、备用开场白、TavernHelper 剥离
- **依赖**：新增 `@deepseek-ai/dsh-tools`（模型工具注册）；`.gitattributes` 统一 LF

## [Unreleased]

### world-book 卡片 selectiveLogic 下拉 + useRegex 开关（2026-08-23）

- **UI**：world-book 策略参数补全——`selectiveLogic` 下拉（0 任一 / 1 副键全排除 / 2 部分排除 / 3 副键全包含，对齐 ST `world_info_logic`）与 `useRegex` 开关（此前仅转换层支持，UI 未暴露）。
- **引擎**：`MATCH_LOGIC` 细分 `NOT_ANY`（主键命中且至少一个副键未中）——ST 2 号语义此前与 1 号合并为 not，现精确区分；resolver 映射 0→any / 1→not / 2→notAny / 3→all。
- **测试**：notAny 单元用例（279 pass/0 fail）。

### 锚定匹配引擎（anchor-match）：拆解 fallback，world-book 选择性触发落地（2026-08-23）

- **新引擎 `engine/anchor-match.mjs`**（纯函数、无依赖）：主/副键、大小写、整词、正则、组合逻辑（`any`/`all`/`not` 对齐 ST `world_info_logic` AND_ANY/AND_ALL/NOT_ALL）、匹配模式（`scan` 全文 / `prefix` 开头锚定）。
- **custom-fallback 拆解**：`matchesAnchorWord` 迁移为 matcher prefix 模式（`{ keys: [firstTurnWord] }`）——锚定能力成为引擎能力，行为不变（回归测试通过）。
- **world-book selective 落地**：`selectiveLogic`（ST 0/1/2/3）→ `any`/`not`/`all`；转换层不再丢弃 `selectiveLogic`（写入配置 params）；无键/constant 恒注入语义保留。
- **测试**：anchor-match 单元（any/all/not × 选项 × prefix）+ world-book 集成（副键全中/排除/任一）（278 pass/0 fail）。
- **未做**：scan_depth 递归扫描（引擎无条目间递归概念，需要时再加深度选项）。

### 合并 text / texts 编辑框为单一内容框（对齐官方 text 单字符串语义）（2026-08-23）

- **依据**：dsh 官方（`packages/core/system-prompt/src/index.ts` L67/L84）prompt 条目 `text` 为单字符串（或函数 provider），多段靠多条 section（order 拼接）——无 `texts` 数组概念；`texts` 是我们引擎的自研扩展。
- **合并**：模块卡片表单的 text / texts 两个编辑框合并为「内容（注入文本；空 = 不注入；变量 {{key}} 插值）」单框——普通配置保存统一写 `texts: [整块]`（单段，对齐官方语义；变量为空只留空位不整段消失）；`text` 字段保留兼容读取，编辑后归一。
- **内容资产兼容**：prompt-injector / instruction-hint（`config.id` / `fill` 判定）编辑仍写 `text`（生成目录文件通道 params.text，行为不变）。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。

### 修复 Variables 卡片「删除（清空）」失效（2026-08-23）

- **根因**：`clearAll` 先 `setTemplateVariables({})` 再调 `saveTemplateVariables()`——React setState 异步，保存闭包里的 state 还是旧值，后端写回旧变量，卡片清不掉。
- **修复**：`saveTemplateVariables(next?)` 支持显式传入下一份值；清空场景传 `{}`（后端清 variables 段 + 重建），与 setState 解耦。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。

### 模块「新建」增加 Variables 入口（2026-08-23）

- **新建 → Variables**：模板选择弹窗（新建）顶部新增固定「变量 / Variables」入口——点击展开模块列表顶部的模板变量卡片（受控展开）并添加一个待编辑空行，不插入提示词配置。
- 模板变量卡片展开状态提升为受控（`PromptConfigsEditor` 管理），清空/折叠联动。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。

### 模块列表增加拖拽排序（2026-08-23）

- **拖拽**：模块卡片 header 新增拖拽手柄（⠿），HTML5 DnD 拖到目标卡片上/下半区（落点指示线：上缘/下缘高亮）松手即移动；复用显示视图移动（`moveToView`：按显示相邻逐步交换 order 与数组位置，与连续点按钮等价，跨层正确）。
- **交互隔离**：`draggable` 只设在手柄上（整卡不参与拖拽），展开表单的输入/文本选择不受干扰；拖拽源卡片半透明（data-dragging）。
- 样式：configCard 新增 `data-dragging` / `data-drop-before` / `data-drop-after`。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。

### 修复模块列表上移/下移失效（2026-08-23）

- **根因**：`moveWithinLayer` 按**数组相邻**交换，而列表显示顺序是 `(层序, order, 声明序)` 排序——跨层配置混合时（ST 转换产物正是如此）数组顺序 ≠ 显示顺序，上移/下移交换的是"数组邻居"而非"显示邻居"，视觉上不移动甚至错乱（跨层跳位）。
- **修复**：移动基于显示视图（`viewOrderedIds`：层序/order/声明序）找显示相邻项，交换两者的 order 与数组位置——显示顺序与引擎注入顺序（数组序）同步变化；按钮可用状态（canMoveUp/canMoveDown）同步按显示视图计算。
- 验证：跨层场景（`[P1(pre), S1(ss), P2(pre)]` 中 P2 上移 → `[S1, P2, P1]`）正确；typecheck / lint / test 全绿（272 pass/0 fail）。
- **说明**：模块列表为按钮式排序（无拖拽）；技能列表拖拽是独立功能（PromptWorkspace），本次未涉及。

### 模板变量卡片：移除保存按钮，失焦自动保存；「添加变量」改名「添加」（2026-08-23）

- **自动保存**：删除「保存模板变量」按钮——焦点离开卡片容器（编辑完点别处/收起/切换开关/点击删除）即自动持久化（`/preset-variables` + 重建）；保存成功静默、失败提示。
- **文案**：`VariablesEditor`「添加变量」按钮统一改名「添加」（配置卡片与模板变量卡片共用组件，同步生效）。
- 验证：typecheck / lint / test 全绿（272 pass/0 fail）。

### 停用模板变量时自动剥离配置中的 {{key}} 引用（2026-08-23）

- **行为**：`variablesEnabled=false`（开关停用）时，`writePreset` 除不生成 `variables.yml` 外，还把每条配置文本（`texts`/`text`/`params.text`）中的**预设变量引用** `{{key}}` 剥离为空——不再有字面残留，也不触发官方 `unknown prompt variable` 渲染报错。
- **保留**：内置变量（`{{DSH_HOME}}`/`{{WORKSPACE}}`/`{{CWD}}`）与配置自身 variables 的引用不受影响（剥离只针对预设变量键）。
- **测试**：停用时 `剧情{{wordsCloud}}字 {{DSH_HOME}}` → `剧情字 {{DSH_HOME}}`；启用后引用保留（引擎插值）（272 pass/0 fail）。

### 模板变量卡片增加插值开关（与其他模块卡片一致）（2026-08-23）

- **开关**：卡片 header 新增启用/停用 toggle（configEnable 样式，与其他模块卡片一致），控制"模板变量插值"——存 preset.yml 顶层 `variablesEnabled`（缺省 true），切换即时持久化 + 重建。
- **停用语义**：`writePreset` 不再生成 `variables.yml`——`{{key}}` 不再被替换（引擎无预设变量源）；展开态显示停用提示。注意：system-section 配置若文本残留 `{{key}}`，官方渲染会抛 unknown variable（用户主动停用时的已知行为，卡片 title 有提示）。
- **端点**：`/preset-variables` 读写增加 `enabled` 字段；`savePresetParams` 新增 `variablesEnabled` 参数（true = 删除键即缺省，false = 显式停用）。
- **测试**：停用不生成 variables.yml / 启用恢复（272 pass/0 fail）。

### 模板变量卡片彻底归类到配置列表下（可折叠 / 可删除 / 可新建）（2026-08-23）

- **位置**：模板变量卡片经 `PromptConfigList.beforeCards` 插槽渲染在配置列表区域内（列表头部之后、配置卡片之前），随页面滚动，不再独立于列表上方。
- **交互对齐配置卡片**：可折叠（chevron 展开/收起，默认收起）；可删除（header「删除 → 确认清空」，清空全部变量并持久化）；可新建（展开后 VariablesEditor「添加变量」）。
- 语义不变：非 promptConfig，保存仍走 `/preset-variables` 写 preset.yml 顶层 `variables` 段。
- 验证：typecheck / lint / test 全绿（271 pass/0 fail）。

### 模板变量编辑入口并入模块列表（B 方案）（2026-08-23）

- **调整**：「模板变量」从工作台独立卡片（ModelToolCards 下方）移入提示词配置模块列表（PromptConfigsEditor）顶部——与 world-book、人设、各提示词模块并列管理，样式统一（configCard）。
- 语义保持：预设级数据（非 promptConfig，不进配置列表保存路径），保存仍走 `/preset-variables` 写 preset.yml 顶层 `variables` 段。
- `PromptConfigsEditor` props 扩展（templateVariables / setTemplateVariables / saveTemplateVariables）；`PromptWorkspace` 移除旧独立卡片组件。
- 验证：typecheck / lint / test 全绿（271 pass/0 fail）。

### 预设级模板变量迁移到 preset.yml 顶层 variables 段（2026-08-23）

- **设计**：`params` 混着两类语义（引擎行为参数 + 模板变量）——模板变量迁移到顶层 `variables:` 段（对齐官方"变量表"概念），`params` 只留引擎行为参数（PARAM_KEYS）。
- **转换**：`convertStToPreset` 的 setvar/getvar 收集改写入顶层 `variables`（不再进 params）。
- **写入**：`savePresetParams` 新增 `variables` 参数——写顶层 `variables` 段 + 清理 params 同名旧键（保存即迁移）；params 空 key 跳过。
- **渲染**：`writePreset` 的 variables.yml 来源 = 顶层 `variables`（优先）+ 旧布局 params 内容键（兼容）；runtime 参数（promptText 等）不再进变量文件。
- **端点**：`/preset-variables` 读 = 顶层 variables + 旧 params 内容键合并（顶层优先）；写 = 顶层段。
- **测试**：writePreset variables.yml 断言更新（顶层优先 + 旧键兼容 + runtime 排除）；savePresetParams variables 写入（271 pass/0 fail）。
- **环境**：`beta-2-42` 预设已迁移（19 内容变量 → 顶层 variables，params 剩 14 个 UI 键，备份 `.bak-pt-vars-top-*`）。

### 修复 VariablesEditor「添加变量」失效（2026-08-23）

- **根因**：`VariablesEditor.commit` 过滤空 key 行——「添加变量」新增的 `['', '']` 待编辑行被立即丢弃，按钮点击无效果（配置卡片与模板变量卡片共用，均受影响）。
- **修复**：编辑器保留空 key 行（新增行可继续输入）；空 key 由保存端统一清理——`savePresetParams`（params 空 key 跳过 + promptConfigs 逐条清理 variables 空 key）、模板变量卡片保存前本地过滤。
- **测试**：`savePresetParams` 空 key 清理回归断言（271 pass/0 fail）。

### 模板变量单一编辑入口：variables.yml + 工作台「模板变量」卡片（2026-08-23）

- **问题**：writePreset 把预设级内容变量展开进每条配置的 `variables`，每个模块卡片的「variables（模板变量 {{key}} 插值）」重复显示同一批变量。
- **数据流重构**：预设级内容变量（非 `PARAM_KEYS` 的非空 string 键）→ 生成 `prompt-configs/variables.yml`（单一文件）；引擎 `loadPromptConfigFiles` 读入后合并进每条配置 variables（配置自身优先）；生成目录每条配置 yml 保持干净（卡片 VariablesEditor 只显示配置自身变量）。
- **UI**：工作台主会话页新增「模板变量」卡片（复用 `VariablesEditor` key-value 行编辑，ST 对应物 = 宏系统变量管理 `public/scripts/variables.js`），保存走新端点 `/preset-variables`（写激活预设 preset.yml 内容变量 + 重建）。
- **桥端点**：`BRIDGE_ENDPOINTS` 22→23（`presetVariables`），契约测试同步。
- **host 加载**：`prompt-configs.ts loadPromptConfigFiles` 跳过 `variables.yml`（非配置）。
- **测试**：引擎合并断言（变量文件不入配置列表、配置自身优先）、writePreset 生成 variables.yml、liangshen/custom 目录断言过滤变量文件（270 pass/0 fail）。

### 预设级内容变量展开进 variables（官方插值机制；修复 {{key}} 注入失败）（2026-08-23）

- **根因**：writePreset 把预设级内容变量合并进 `config.params`，但引擎插值（`interpolateVariables`/`interpolateStatic`）只读 `config.variables`——`{{JailbreakPrompt}}`/`{{wordsCloud}}`/`{{getvar::k}}→{{k}}` 不被替换；且 system-section 文本注册进官方 `ctx.systemPrompt` 后，残留 `{{key}}` 触发官方 `unknown prompt variable` 抛错 → **该段注入失败**（warn 静默）。
- **修复**：合并层从 `params` 改为 `variables`——预设级内容变量（非 `PARAM_KEYS` 的 string 键）展开进每条配置的 `variables`（官方插值源，配置自身优先）；`params` 只保留配置自身策略参数（strategies.mjs 消费）。
- **UI**：`StrategyParamsFields` JSON 回退分支在 params 为空时不再渲染「params（高级参数 JSON）」框，提示"本策略无高级参数；模板变量见上方 variables"——内容变量由既有 `VariablesEditor` 结构化编辑。
- **测试**：write-preset 断言内容变量进 variables（params 不含）、UI 管理键双不落（269 pass/0 fail）；实测 `{{JailbreakPrompt}}` 经 variables 插值成功。

### 配置 params 合并排除 UI 已管理键（JSON 高级参数框只留内容变量）（2026-08-23）

- **问题**：writePreset 把整包预设级 params 合并进每条 promptConfig 的 params（供 `{{key}}` 插值），模型设置/工具与深度/开关等 **UI 已有专门编辑入口**的键（`PARAM_KEYS`）也一并出现——「params（高级参数 JSON；本策略无固定字段）」框里冗余回写这些参数。
- **修复**：`PARAM_KEYS` 移至 `src/shared/param-keys.ts`（host 层不 import config 的分层纪律，单一来源）；`writePreset` 合并预设级 params 时排除 `PARAM_KEYS`，配置自身策略参数（第二层 `...config.params`）不受影响。
- **测试**：`write-preset.test.mjs` 新增断言——生成配置 params 不含 `firstTurnAnchor/modelProvider/guideText/usePtcMode/...` 等 UI 管理键、内容变量（如 `promptText`）保留合并（269 pass/0 fail）。

### ST 转换剥离采样参数（模型参数统一归「模型设置」UI）（2026-08-23）

- **根因**：convertStToPreset 把 ST 卡采样参数（`temperature` / `openai_max_tokens` / `reasoning_effort`）固化为顶层 `params.model*`，与「模型设置」UI 编辑的是同一份预设级参数——ST 卡固化值会在导入/重建时覆盖用户在模型设置里的设置。
- **剥离**：转换引擎不再写入 `modelTemperature` / `modelMaxTokens` / `modelReasoningEffort`（ST 源码对照：这三者是 ST 请求层采样参数，属会话运行时设置，非预设内容）；模型参数完全由模型设置 UI / 宿主默认管理。
- **测试**：`preset-package-import` 用例改为断言转换产物不含三键（268 pass/0 fail）。
- **环境配套**：已导入预设 `xiajin-tianqin-beta-2-42/preset.yml` 顶层 params 三键剥离（yaml 保留注释写回 + 备份），生成目录旧 `00-model-params.yml` 删除（writePreset 重建时会清空 prompt-configs 目录，无残留路径）。

### 预设 id 官方命名约束（修复官方客户端 resume 报 preset not found）（2026-08-23）

- **根因**：ST 导入预设 id 保留中文字符（`\u4e00-\u9fff`），目录建在官方 `USER_PRESET_DIR` 后被宿主 discovery 的 `PRESET_ID`（`/^[a-z0-9][a-z0-9-]*$/`）静默跳过；插件又把宿主 `agent-presets.default` 同步为该 id → 官方客户端 resume 会话报 `agent-presets: preset "夏瑾-天琴座-beta-2-42" not found`。
- **`stPresetId`**：ST 导入 id 生成抽为独立函数并导出——文件名 slug 化（去中文，满足官方 `^[a-z0-9][a-z0-9-]*$`）；纯中文名退化为 `st-<文件名短哈希>`（唯一且合法）；显示名 `name` 保留中文原名。
- **writePreset 校验收紧**：`presetTemplate` 从「可含中文的目录名」收紧为官方 agent-presets id（`^[a-z0-9][a-z0-9-]*$`），非法 id fail loud，防止再生成官方不可见目录。
- **宿主 default 同步防护**：`syncHostDefault` 同步前校验 id 合法，不合法 warn 跳过（不再写坏宿主 settings）。
- **测试**：新增 `test/host/sillytavern.test.mjs`（中文名 slug / 纯中文 hash / 英文 slug）；write-preset 拒绝中文/大写 templateName；`preset-package-import` 中文文件名用例同步新 id 形态。
- **注意**：已导入的中文 id 预设（如 `夏瑾-天琴座-beta-2-42`）需手动改名为合法 id 并同步 `settings.yaml`（`agent-presets.default` / `prompt-tool.presetTemplate`），否则插件重启后 writePreset fail loud。

### persona 注册层重构：router-first-turn 接管人设（2026-08-22）

- **token 参数名直观化**：组合模板占位符从 SCREAMING_SNAKE_CASE（`__USE_PTC_MODE__` 等）改为 camelCase（`__usePtcMode__` 等），与 `params` 键逐字对应（`USE_PTC_MODE`↔`usePtcMode` 心智映射消除）；`renderTemplateVariables` / `assertCompositionArray` / 测试检测正则统一支持大小写；`resolvePresetParams` 删除 SCREAMING_SNAKE 别名生成（`upperKey` 移除）；`__SUBAGENT_FLASH__`（rebuild 脚本旧名）同步为 `__subagentConfig__`。
- **人设彻底模块化（方案 B 落地）**：人设从 params 参数迁移为 promptConfigs 的 `persona-main` 模块（`layer: system-section` + `params.sectionName: deployment:persona`）——与普通模块同一存储/编辑/新建通道（模块列表「人设」徽标）；`complete` 保留且 UI 互斥（预设内仅一个，手写冲突官方 fail loud，与官方行为一致）；`suppressRuntimeContext` 经 wireSystemSections 透传（等价官方 includeRuntimeContext:false）；`router-first-turn.mjs` 整体退役（引擎文件、composition 行、`__MAIN_PERSONA__` token、FALLBACK_MODULES 引用全删）；`mainPersona` 参数删除，6 预设人设文本迁入 promptConfigs（anchored/minimal complete 独占系、standard/ptc/creative/liangshen 非独占）；子代理回退链改为「显式 subagentPersona → scope 链继承主会话 persona」；templates/20-system-section.yml 补 persona 用法；测试重写（persona 模块集成测试：shadow 注册/complete 独占/多 complete fail loud/suppressRuntimeContext/子代理不继承）+ 修复 prompt-configs 测试 DSH_HOME 隔离（paths 模块顶层缓存 DEFAULT_PRESET_DIR，必须动态 import）。
- **官方预设人设全量对齐**：standard → 官方 standard 原文（`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`，非独占）；ptc → 官方 code 原文（同 standard，PTC 保留）；minimal → 官方 minimal 原文（`You are a helpful software engineer assistant.`，complete 独占 + 抑制 runtime context 由组合默认提供）；creative → 官方 cordis（上条）。anchored / liangshen / custom 为自研预设无官方对应，保留自有设计。write-preset 测试新增三预设人设对齐断言。
- **creative 对齐官方 cordis（创造模式）**：`preset/creative/preset.yml` 人设替换为官方 cordis 创意文本（`{{model}}`/`{{cwd}}` 变量经 token 渲染保留、assemble 后由官方插值）；`usePtcMode` 改 false（官方 cordis 非 PTC）；配套 skills 补齐——`preset/creative/skills/cordis-plugin-development/` 与 `editing-cordis-compositions/`（官方原文复制，writePreset 随预设复制进生成目录，skill-filesystem `customSkillDirs` 解析）；write-preset 测试加变量保留与 skills 复制断言。
- **人设体系收敛为「主会话 / 子代理」两轴**（用户定稿）：完全放弃 Flash/Pro 模型档位分流——`mainPersona` 重定义为主会话人设（全模型通用，静态注册层 shadow + complete 独占），`proPersona` 参数取消（曾短暂引入后按用户决策回退）；子代理轴由既有 `subagentPersona`（显式 → 回退 mainPersona → 继承主会话）承担，与主会话天然隔离（scope 链不继承）。
- **修复真实宿主缺陷**：官方 `dsh-system-prompt` 的 `complete` 语义在 assembly waterfall 后恢复注册原文——旧实现的 waterfall 段替换（Flash/Pro 人设路由、mnemon 隐藏、plan 保留）在 `complete: true` 预设下被整体覆盖，**mainPersona 自定义从未真正到达模型**（桩 ctx 测试掩盖）。经官方源码核对 + 真实 cordis/dsh-system-prompt 集成验证（6 场景全绿）。
- **注册层实现**：`engine/router-first-turn.mjs` 改为官方 scope shadow 机制——同名注册 `deployment:persona` 遮蔽全局 persona，`section.text` 为函数 provider 按 `context.agent.options.model` 每次组装路由（Flash → `mainPersona`，Pro → 官方 RL 原句），首轮即正确、模型切换自动跟随；`complete: true`（默认）天然独占 system prompt，无需 waterfall 修改。
- **persona 行移除**：6 个预设（anchored/minimal/liangshen/standard/ptc/creative）的 `modules` 删除 `persona` 行与 `moduleConfigs.persona`（同名单注册冲突）；`includeRuntimeContext: false` 语义迁移为 `router-first-turn.suppressRuntimeContext`（anchored/minimal 开启）；standard/ptc/creative/liangshen 保持非独占（`complete: false`）；liangshen 补挂 router-first-turn 与 `params.mainPersona`。
- **配置收敛**：`hideSectionPrefixes` / `includeSubagents` 删除——mnemon 段隐藏由 complete 免费实现（原真实宿主上同样被覆盖，无回归）；子代理 scope 不继承 shadow（官方 scope 链），天然放行全局 persona，自定义走 tool-subagent 行 `subagentPersona`。
- **测试升级**：`anchored-presets.test.mjs` router 用例从桩 ctx 改为真实 cordis + dsh-system-prompt + dsh-scope 集成测试（Flash/Pro 路由、complete 独占、子代理放行、suppressRuntimeContext 等 6 用例）；devDependencies 新增 `@deepseek-ai/dsh-scope`。
- **回归**：typecheck / lint / 257 测试全绿。

### 适配 DSH v0.1.1-rc.1（2026-08-21）

- **依赖升级**：peerDependencies / devDependencies 全部 `^0.1.0-rc.8` → `^0.1.1-rc.1`（dsh-api-remotes、dsh-client-connection、dsh-client-runtime、dsh-client-ui-primitives、dsh-client-ui-settings、dsh-client-ui-slots、dsh-commands、dsh-host-webserver、dsh-settings、dsh-skill、dsh-system-prompt），pnpm-workspace.yaml minimumReleaseAgeExclude 同步更新。
- **兼容性核对**：插件 import 的 11 个符号（ClientContext / SettingsScope / IApiClient / ConnectionHandle / settingsNamespace 等）在 rc.1 全部保留且签名未变；上游类型变化均为增量（RpcFetch / ClientTransportHooks / IndexInjection 新增、sessions 可选字段、MarkdownRenderContext.inBlockquote）；`credentials/updated` 事件更名为 `credentials/reference-updated`（插件未使用，无影响）。
- **回归**：typecheck / lint / 235 测试全绿。

### UI 参数全覆盖：预设级参数可自定义（2026-08-20）

- **overrides 通道 8→15 项**：`fastModelPersona`（主对话快速模型人设，textarea）、`subagentPersona`（子代理独立人设，textarea）、`subagentToolFilterAllow/Deny`（工具集白/黑名单，逗号分隔 input）、`subagentMaxDepth`（递归深度，下拉：不设置/provider-managed/0/1/2/3/5）、`allowKinds`（注入 kind 白名单，逗号分隔 input）、`firstTurnWord`（锚定词，**自由文本输入**任意自定义文本）——全部经 prompt-tool.overrides.yml 随预设隔离，settings.yaml 保持纯净。
- **空值保护**：fastModelPersona 引擎必需非空（空串触发 router-first-turn 抛错）——空值不写 overrides 键，保留模板默认；allowKinds 空数组 = 白名单全拦（危险）——空值跳过；firstTurnWord 空回退模板默认 we；subagentMaxDepth 空 = 不设置（官方默认）。
- **链路**：WritePresetOptions / BuildCordisOptions / RuntimeOptions / Fields / store（load paramPatch + persistParamOverrides）/ applyParamOverrides 同步扩展；UI「消息批层入口」加锚定词、「功能设置」加主对话快速模型人设 + kind 白名单、「子代理设置」加独立人设 + 工具集白/黑名单 + 递归深度。
- **回归**：buildCordis fastModelPersona/allowKinds 覆盖断言 + writePreset firstTurnWord 透传/回退断言（210 pass）。

### 参数归类分层：作用域 × 维度（2026-08-20）

- **子代理参数归类**：参数统一为「作用域（主对话 / 子代理）× 维度（模型/人设/工具集/深度/相位/注入）」矩阵——preset.yml 顶层**独立 `subagent:` 段**（与 `params` 平级，不埋在主对话设置中；`modelProvider/modelName`、`persona`、`toolFilter.allow/deny`、`maxDepth`），引擎合并入口 `resolvePresetParams` 拍平为扁平键（`subagentModelProvider` 等），运行时/UI/overrides 继续消费扁平键，两套表示等价；主对话模型由 dsh 全局配置（插件只读），相位（`moduleConfigs.*.includeSubagents`）与注入（`promptConfigs[].subagents/promotion/modelScope`）保持既定段位。
- **命名脱离上游**：`subagentFlashProvider/Model` → `subagentModelProvider/ModelName`（UI 已为「模型服务商/模型名」）、`flashPersona` → `fastModelPersona`（快速模型路由人设）、`installSubagentFlashRoute` → `installSubagentModelRoute`、渲染 token `__FLASH_PERSONA__/__SUBAGENT_FLASH__` → `__FAST_MODEL_PERSONA__/__SUBAGENT_CONFIG__`；全链路 26 文件同步，无旧格式兼容。
- **相位补齐**：`moduleConfigs.router-first-turn.includeSubagents` 暴露（与 tool-bootstrap/context-gate 同段，router-first-turn 子代理首轮相位可配）。
- **回归**：`resolvePresetParams` 嵌套拍平测试（含空默认值不渲染、运行时扁平键优先）。

### 审查修复：官方对照归一（2026-08-20）

- **子代理完整自定义（官方 tool-subagent Config 参数化）**：`params` 新增 `subagentPersona`（per-child shadow，显式优先/固定路由回退 fastModelPersona/缺省继承主会话）、`subagentToolFilterAllow/Deny`（toolFilter 白/黑名单，数组或逗号/空格字符串）、`subagentMaxDepth`（0 禁止委派/provider-managed/正整数）——渲染进 tool-subagent/subagent_fork 行（`agentOptions` + `persona` + `toolFilter` + `maxDepth`）；任一字段非空即渲染对应行，全部缺省=官方默认；WritePresetOptions/BuildCordisOptions 同步透传；全预设冒烟（minimal 无 delegation 模块按官方不渲染）。

- **allowKinds 兜底对齐官方 pre-step 行为**：官方 deepseek-harness 的 `agent/pre-step` 默认无 kind 过滤（claimed + runtime-context 快照，kind 全集 user/plugin/tool/skill-catalog/skill-invocation/agent-instructions/goal）——`allowKinds` 未声明时不再写行、context-gate 不做 kind 过滤（官方行为）；显式声明（anchored 等）仍为白名单门控。配套修复 `renderTemplateVariables` 空值 token 独立行整行删除（原只删 token 残留 `key:` null）与两步替换的行定位错位。

- **anchored persona 语义修正（S 级）**：`complete: true`/`includeRuntimeContext: false`（minimal 语义）与 anchored 的 standard 结构（router-first-turn + planning + context-gate）冲突——官方 assemble 的 complete 恢复机制会抑制 plan-mode 段与 router-persona（Flash 路由人设），永久 runtime-context 抑制使 context-gate 晋升后恢复失效；改为 standard 语义（仅 text），实测 plan-mode/router-persona 保留；新增回归断言（module-configs.test.mjs）。
- **参数定义补全**：`firstTurnWord` 从 write-preset 硬编码 `'we'` 改为 `params.firstTurnWord`（默认 we，anchored preset.yml 显式声明）；`allowKinds` 兼容 YAML 数组写法（flow 序列化，原数组会被 String() 破坏为标量）；`loadPresetContent` 回退链按 `resolvePresetDir(template)` 解析（用户预设优先，index.ts 按当前 presetTemplate 读取）；anchored moduleConfigs 显式化 tool-bootstrap `includeSubagents/promoteOn`（与 context-gate 同步）。

- **writePreset 本地文件复制回归修复**：官方格式预设（agent.cordis.yml 引用 `./xxx.mjs` 相对路径模块）生成目录缺本地文件——恢复模板目录本地文件复制（跳过 preset.yml/agent.cordis.yml/preset.md/agents.md），`official-preset.test.mjs` 恢复 demo-local 断言。
- **merged/order 归一收尾**：executor merged 分组键统一 `merged:<position>`（删 mergeGroup 死引用与 `identity.field==='kind'` 死分支，注释 priority→order）；templates 全面 `priority`→`order`、删 `mergeGroup`（merged=同 position 拼接）；LAYER_LABELS/README 文案同步；writePreset 补 guideCustom 时 router-guide `modelScope=all` 覆盖（双实现漂移修复）。
- **双实现删除**：`buildDefaultPromptConfigs`/`buildPromptConfigFiles` 仅测试消费的旧默认四条构造删除，`prompt-configs.test.mjs` 改断言 writePreset 生成目录产物（12 测试改造为 9+1）。
- **存储分层收尾**：删 `seedSettingsOnce`（首次安装不再写 settings 大文本）与 `restoreOriginals` 死端点（客户端零消费，契约 12→11）；applyState 对 settings 空文本不再覆盖生成目录/模板内容；`settingsEntry` 合并为 `currentSource()` 单一组装；删除旧格式兼容 `normalizeFirstTurnText`/`LEGACY_FIRST_TURN_TEXT` 与 onRegistered legacy 迁移。
- **引擎清理**：`ALLOW_KINDS` 引擎默认统一 `[skill-invocation]`（与 context-gate 一致，anchored 显式声明保留）；删 `DEFAULT_BOOTSTRAP_TOOLS` 死常量与 `tools/execute` 空壳监听；`injectedMemo` 加 4096 会话上限；`custom-fallback` firstTurnWord 三元冗余简化；tool-bootstrap `agentBySession.set` 补 session 判空；router-first-turn 子代理放行参数化（`includeSubagents`）；delegation codex/claude 行对齐官方 `backgroundMode: one-shot`；anchored/liangshen preset.yml 的 promptConfigs 内联 params 删除（writer 从顶层 params 注入，单一配置源）。

### 架构重构（2026-08-20）

- 官方格式预设兼容：`.agent-presets/<id>/` 官方用户预设（preset.yml 仅 name/description/order 元数据 + 同目录 agent.cordis.yml）可导入/切换——`loadPresetSpec` id 回退目录名，`loadCompositionText` 无 modules/composition 时回退同目录 agent.cordis.yml；`listPresets`/`resolvePresetDir`/`userPresetsDir` 加入 lib 导出；隔离环境实测导入 liangshen 预设通过（清单可见、渲染 363 行、引擎齐全）；新增 `test/host/official-preset.test.mjs`（子进程隔离验证）。
- 模板审查合并 + instruction-hint 抽象完整化：①重叠合并——130/150 双 instruction-hint 模板合一（删 150，130 注释说明 strategy=instruction-hint 快捷写法等价）；②`createInstructionHintResolver` 支持 `params.text` 自定义提示文本（覆盖 agents-instruction.txt 与动态探测），与 env-facts/skill-catalog 同风格可传参（strategies 与 FILLERS 双路径均传 config）；③清理 130 模板死参数 `params.promoteOn/includeSubagents`（引擎无消费方，晋升语义由顶层 `promotion` 字段驱动）；模板 17→16。
- UI 重组：配置管理统一进工作台——新增「预设和配置」页（`PresetsPage`：预设切换/导入 + 全量提示词配置列表），主设置页（settings.section「提示词工具」）**移除**（PromptSettingsPage 删除，配置列表与预设切换全部并入工作台新页；功能设置的预设切换同步移入）。
- 审查清理：移除「从目录导入」提示词配置功能（与「提示词配置目录」promptConfigsDir 动态引用**功能重叠**——目录导入是静态快照且与源目录脱钩，动态目录更优）——删除 `/import-directory` 端点（契约 13→12）、client `importFromDirectory`/`api` prop 及关联代码；「内置模板」**保留**（六层+placeholder 起始素材，非功能重叠）。
- UI 四项：①模板下拉不再挤压说明（importBar 说明列 `minmax(160px,1fr)`）；②预设切换器组件化（`PresetSwitcher`）——主设置页（提示词配置）与功能设置共用；③**导入预设 = 预设定义**（`preset.yml` 配置文件 或 整个预设文件夹 `webkitdirectory`），bridge `/import-preset-package` 按相对路径写入用户预设目录（路径穿越防护），`listPresets` 合并包内+用户、用户同名覆盖，`resolvePresetDir` 用户优先；契约端点 12→13。修复 Node 26 下 `import()` query 不再强制重载 ESM 的测试失效（preset-defaults 改子进程验证 DSH_HOME 动态性）。
- 参数覆盖随预设隔离：新增生成目录内 `prompt-tool.overrides.yml`（writePreset 原子重建时保留），参数类设置（firstTurnAnchor/guideText/subagentFlash/bootstrapMaxTokens 等 8 项）由 UI 写入 overrides 而非 settings，运行时 `applyParamOverrides` 合并进模板 params；bridge 新增 `/param-overrides`（读+写）；settings.yaml 保持总开关纯净；契约端点 11→12。
- UI 预设切换器：/meta 端点附加可用预设清单（`listPresets()` 扫描 preset/ 目录），功能设置新增「预设模板」下拉（anchored + 官方四套），`store.setPresetTemplate` 写入 settings 并重建生成目录；参数类设置（firstTurnAnchor/guideText/subagentFlash 等）从 settings.yaml 移除，由各预设模板 params 提供默认（settings 仅保留总开关/技能/路径配置，用户环境 1.3KB）。
- 存储分层对齐官方：大文本内容（preset.md/AGENTS.md）移出 settings.yaml → 生成目录文件（writePreset 落盘 `preset.md`/`agents.md`）；settings.yaml 只存小配置（用户环境 10KB→2.1KB，web 打开不再全量传输/解析大字段）；旧 settings 值首启一次性迁移（onRegistered 落盘）；文本来源改为生成目录文件优先 → 模板 content 回退；bridge 新增 `/preset-content`（按需读文件）+ `/import-preset`（导入写入，触发重建）；UI 主设置 preset/agents 区改为「**导入配置文件**」+ 只读预览（不再内嵌编辑大文本）；契约端点 9→11。
- library 合并与差异参数化：删除 17 个与现有模块重复/可合并的 `official-*`（tool-pwsh/tool-fs/planning/compaction/delegation 等 11 个与现有一致、official-filesystem=bootstrap-filesystem、official-delegation 的 `__SUBAGENT_CONFIG__` token 对官方预设渲染为空可兼容）；**persona 差异参数化**——persona.yml 收敛为 standard 版（仅 text），anchored/minimal/creative 的差异（text/complete/includeRuntimeContext）由 preset.yml `moduleConfigs` 传递（纯数据可参数化）；`applyModuleConfigs` 支持行无 config 时创建节点；**`!!js` 表达式差异不参数化**（YAML tag 经 preset.yml 解析丢失，代码类差异保留独立文件 official-skill-filesystem-cordis）；保留 official-* 6 个（agent-instructions/tool-bash/tool-skill/tool-presentation/tool-cordis/persistent-shell，现有无对应或内容为本地定制）。
- 官方预设模块化导入：从 deepseek-harness 官方源码拆解 4 个预设为模块——`engine/compositions/library/official-*.yml`（23 个官方模块文件，按行块提取；persona/skill-filesystem 按预设分版本），`preset/{standard,minimal,ptc,creative}/preset.yml` 用 `modules:` 清单声明（官方行 + prompt-tool 本地附加行）由插件拼接；`manifest.loadCompositionText` 保留 `composition: ./xxx.yml` 相对路径能力（通用）；`presetTemplate` 切换即用。
- UI 审查建议落地：S1 自定义引导文本行灰显条件补 `!writePreset`（与输入禁用一致）；S2 Anchored Standard 模块行新增「编辑」按钮——受控聚焦（focusId+focusTick）展开下方配置卡片并滚动到可视区，同 id 重复点击可重触发。
- UI 预设分组：内置消息批配置模块行归类到「Anchored Standard(prompt-tool)」分组，并按实际生效配置**动态生成**（预设模板声明什么显示什么；模块缺失不渲染，切换模板自然跟随）；模块行 label 优先取配置 name。
- 修复 UI/TUI 配置计数显示：settings.promptConfigs 仅是用户覆盖层（默认空），实际生效配置在生成目录 `prompt-configs/`（引擎加载源）——新增 bridge 端点 `/prompt-configs` 返回实际生效配置（client 加载时以其为准并同步保存快照），TUI `status`/`config` 命令同样按生成目录优先；契约端点 8→9。
- 技能中心对齐官方策略（参考 dsh-web-ui skill-explorer）：① `listSkillFolders`/`readSkills` 支持 Windows junction/符号链接跟随（dirent.isDirectory() 对 junction 为 false 会漏扫），`SkillEntry`/`SkillCatalogEntry` 新增 `linked` 标记；② client `load()` 加 `loadSeq` 并发保护（慢的旧请求不覆盖新请求，last-good 保留旧数据）；③ Skills 设置新增「刷新技能列表」手动按钮兜底（watcher 失效场景）。
- 技能扫描收敛到官方规范：只有**含 SKILL.md 的一级子目录**才是技能——`readSkills` 跳过无 SKILL.md 的目录（不再生成"SKILL.md 不可读或不存在"坏条目），`listSkillFolders` 过滤点开头隐藏目录（`.git/.github` 等永远不是 kebab-case 技能名）；SKILL.md 存在但名称非法仍保留 `valid=false + issue` 供一键修复；二级子目录由 SKILL.md 引导链接，不参与扫描。
- 参数命名脱离上游影响：anchor 系列参数按功能含义全面改名——`anchorFirstTurn/anchorCustom/anchorText` → `firstTurnAnchor/firstTurnCustom/firstTurnText`，`anchorBuild/anchorInspect/anchorDeep` → `firstTurnBuild/Inspect/Deep`，`customAnchorWord/anchorWord` → `firstTurnWord`（合并）；策略 `anchor-auto` → `first-turn-anchor`；`anchor-fallback` 兼容别名移除（不再归一化，未知策略 fail loud）；`normalizeAnchorText/LEGACY_ANCHOR_TEXT` → `normalizeFirstTurnText/LEGACY_FIRST_TURN_TEXT`；CSS `.anchorInput` → `.firstTurnInput`。完整迁移（无旧格式兼容层），settings 旧键由用户保存时自然覆盖。保留：`anchored`（模板名）、`near-anchor`（配置 id/枚举值，功能含义已符合）、`matchesAnchorWord`（内部函数，功能含义符合）。
- 单一配置源收敛：preset.yml 新增 `moduleConfigs` 段，引擎组合模块行参数（custom-bash 超时/输出上限、router-first-turn 隐藏段前缀、run-code-env 环境变量白名单、context-gate 晋升语义）从 library 组合文件上收到 preset.yml，改参数只动一个文件；新增 `manifest.renderComposition()`（token 渲染 → 行级 config 合并完整链路）与 `applyModuleConfigs()`；修复 `[mnemon:]` 隐式 map 歧义（统一为 `["mnemon:"]`，消除 yaml 库与 cordis 解析器语义分歧）；新增 `test/host/module-configs.test.mjs` 4 条契约测试。
- 跨端契约单点化：新增 `src/shared/bridge-contract.ts`（`SETTINGS_BRIDGE_PREFIX` + 8 端点常量 + `BridgeErrorPayload`），host 注册与 client 消费共用同一来源，消除双定义；新增 `test/shared/bridge-contract.test.mjs` 契约测试（端点齐全、载荷形状、客户端消费路径）。
- 循环 import 修复：`PromptConfigCard` / `PromptConfigForm` / `Field` 等拆入新文件 `src/client/PromptConfigCard.tsx`，`ValidationErrorEntry` 归位 `prompt-tool-types.ts`，`PromptConfigsEditor ⇄ PromptConfigList` 不再互相引用。
- 常量归位：部署路径/序数常量从 `src/config.ts` 移入新文件 `src/host/paths.ts`，消除 host→config 反向依赖面。
- 死字段清理：client store 删除无消费方的 `deepseekAvailable` / `deepseekError`（`deepseekProviders` 保留，模型服务商下拉仍消费）。
- CSS 收敛：`.sectionActions` 单一化到 `PromptUi.module.css`。
- `parseFrontmatter` / `SkillFrontmatter` 从 `preset-core.ts` 归位到 skills 域新文件 `src/runtime/skills-parse.ts`（lib 入口继续导出，测试兼容）。
- 超长文件拆分：技能目录 watcher 拆入 `src/runtime/skills-watcher.ts`（index.ts 633→~560 行）；settings bridge 传输/解析层拆入 `src/client/prompt-tool-bridge.ts`（store 756→~450 行）。

### 深度重构（dev-expert × code-organizer-dsh-plugin）

- Schema 单一权威：`engine/schema.mjs` 导出 `getEngineMeta()`，settings bridge 新增 `/api/prompt-tool/settings/meta`，客户端枚举改为动态加载。
- UI 编辑面收敛：新增共享 `PromptConfigList`，主设置页与工作台复用同一套校验/保存/移动/复制/删除逻辑。
- 宿主适配层：新增 `src/client/host-surface.ts`，集中全部 DOM 选择器，并优先探测官方 workspace slot。
- `writePreset` 原子化：临时目录 + 整体 rename，失败保留旧生成目录。
- `web-surface` 不再修改同级 profile、不再 `process.exit(0)`，写前保留 `.bak` 备份。
- 技能副本版本化：新增 `skills/manifest.json` 与 `.prompt-tool-manifest.json`，包内技能升级时自动覆盖。
- 技能扫描缓存：新增 `createCachedSkillsReader()`，按 mtime/size 自动失效。
- 删除 `patchToolBootstrap` 死代码。
- `we-fallback` 彻底移除，规范策略名改为 `custom-fallback`；参数 `anchorWord` 改为 `customAnchorWord`，兼容旧参数。
- 锚点/引导策略参数彻底收敛到 `preset/anchored/preset.yml`：`src/config.ts` 默认引导文本改为从 preset 读取，`engine/strategies.mjs` 不再内置重复文案。
- 打包 `files` 移除 `plan.md` / `planv2.md` / `upstream`，纳入 `docs`。
- §7 anchored 预设提取：`anchor-auto / guide-auto / custom-fallback / anchor-fallback` 作为内置引擎策略，参数全部由 `preset/anchored/preset.yml` 单一配置下发；`promptConfigs` 迁到 `preset.yml`；`allowKinds` 参数化为 `__ALLOW_KINDS__`。
- 新增 `presetTemplate` 配置，工作台按模板隐藏 anchored 专属开关，向“模板扩展字段动态渲染”迈进一步。
- 新增静态测试锁定“宿主 CSS 选择器只允许出现在 `host-surface.ts`”，并清理 `sidebar-entry.ts` 中残留的 `[class*="logoRow"]`。
- 新增 settings bridge `/meta` 与 loopback 拒绝测试。
- anchored `buildCordis` 测试从 `test/host/preset-core.test.mjs` 迁移到 `test/presets/anchored/preset-core.test.mjs`。
- 将 `src/engine/` 重命名为 `src/host/`，避免与根目录运行时 `engine/` 混淆。
