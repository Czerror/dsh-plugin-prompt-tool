# ST 转译完整性修复计划：key 宏解析、条件字段补齐与边界显式化

- 编写日期：2026-09-17（UTC）。
- 状态：方案已编写并通过文档校验；**代码修复未开始**。按 `AGENTS.md`「编辑计划不等于授权执行修复」，本轮只交付本文件与旧计划归档。
- 固定实现基线：`dev@f3539fa`（R0–R6 交付与自审结论之后的提交）。
- 来源：`.scratch/prompt-tool-framework/issues/04-session-role-corruption.md` 的同类追查——以 ST 1.19.0 源码（`F:\ai\other\SillyTavern`，HEAD `7c3994196`）、参考项目 `D:\AI\GitHub\dsh-tavern`（`dsh-profile-tavern@1.8.0`）与真实素材 `F:\ai\other\AIcord\123`（17 个文件）复盘"是否还有其他 ST 转译问题"，结论见第 1.2–1.4 节。
- 本轮修复范围：**P1 + P2 + P3**，共 8 个核心任务（R7–R14），分入 4 个 Wave：
  - P1（K1）世界书 `keys` / `secondaryKeys` 的 ST 宏未解析；
  - P2（K2–K7）ST 有而我们未读的条件字段：`delayUntilRecursion`、`useGroupScoring`、`matchCreatorNotes`、`matchCharacterDepthPrompt`、`characterFilter`、`prompts[].system_prompt`、`automationId` / `outletName` 形态；
  - P3（K8–K9）边界显式化：`extensions.depth_prompt` 保留、token 预算 / `forbid_overrides` / AN·EM·outlet 位置文档化。
- 完成口径：R7–R14 通过 T11–T23 行为验收与最终门禁；H1（历史日志恢复）仍是单独授权的操作，不计入本轮完成率。

## 1. 来源、证据与边界

### 1.1 旧计划原文归档

旧根计划保存为 [plan-import-lifecycle-r0-r6-f3539fa.md](.scratch/prompt-tool-framework/archive/plan-import-lifecycle-r0-r6-f3539fa.md)。

- 原始 Git blob：`f3539fa:PLAN.md`，blob SHA `bc4c316d85ca06d3541370a7ee5e5100e4bdd884`。
- 归档字节与该 blob 相同（`git hash-object --no-filters` 实测一致）；不添加归档头、不修改旧勾选状态、不补写新结论。
- 归档中的相对链接按旧文件位于仓库根目录时解释；R0–R6 的完成声明以该归档与提交历史为准，本文件不重复。
- 已有更早归档（`plan-st-import-diagnostics-f93182b.md`、`plan-agents-files-20260914-archived-20260916.md`、`plan-module-list-refactor.md`、`plan-rc2-model-routing.md`）继续保留，不覆盖、不删除、不整理。

### 1.2 已核实的问题

行号对应 ST 1.19.0 与固定实现基线，实施前按符号重新定位。

#### P1：触发条件静默失效

| 编号 | 严重度 | 根因与位置 | 已取得证据 |
|---|---|---|---|
| K1 | P1 | `src/host/sillytavern.ts` 的「未定义自定义宏登记」只扫描 `config.text` / `config.texts` / `params.text`，**不扫描 `params.keys` / `params.secondaryKeys`**；引擎 `engine/st-world-book.mjs` 的键求值 `interpolateVariables(key, config.variables, session)` 拿不到 `{{user}}` 的值，键按字面量参与匹配 | 素材实测 **3 条**条目的 key 含 `{{user}}`（R7 实施时复核，原记录为 5 条；`V0.66.png` 的 `id=25`、`id=39` 各带该键，另 1 条在其他卡片），渲染后仍是字面量；其中 `V0.66.png#25`（`keys=["{{user}}"]`、`constant=false`、无副键）**完全失效**；`id=39` 另有字面冗余键 |

ST 依据：`world-info.js:4915` / `:4947` 匹配前对主键与副键执行 `substituteParams(key)`；`:337-366#matchKeys` 展开后按 `parseRegexFromString` 自动识别正则，否则字面（含 `matchWholeWords` 分支）；`script.js:408` 说明 `{{user}}` 来自 ST 全局 `name1` 与用户 persona，**卡片内不存在该值**。

#### P2：条件字段未读取（ST 有、我们没有）

| 编号 | 严重度 | 字段 | ST 依据与语义 | 素材实测 |
|---|---|---|---|---|
| K2 | P2 | `delayUntilRecursion` | `world-info.js:4860-4866`：非递归扫描中带该字段的条目**不激活**；递归扫描中若为数字且大于当前递归层数也抑制（`isSticky` 除外）；`:4755-4756` 参与递归候选构造；`:4104` 默认 0 | 字段存在、值全 0 |
| K3 | P2 | `useGroupScoring` | `world-info.js:423-500#getScore`：按主键/副键命中数打分，组内选择改为取最高分（而非权重随机）；`:4115` 默认 null（继承全局，全局默认 false） | 字段存在、值全 false |
| K4 | P2 | `matchCreatorNotes` | `world-info.js:4103` + 扫描 `:191,:193`（`globalScanData.creatorNotes`）→ 条目可匹配角色卡 `creator_notes` | 字段存在、值全 false |
| K5 | P2 | `matchCharacterDepthPrompt` | `world-info.js:4101` + 扫描 `:308-309`（`#globalScanData.characterDepthPrompt`）→ 条目可匹配角色卡 `extensions.depth_prompt.prompt` | 字段存在、值全 false |
| K6 | P2 | `characterFilter` | 真实形态是**嵌套对象** `entry.characterFilter = { names, tags, isExclude }`（`world-info.js:1279-1300` 的字段读取），不是三个顶层字段；语义：条目只对匹配的角色/标签生效 | 0 条使用 |
| K7 | P2 | `prompts[].system_prompt`、`automationId`、`outletName` | `prompts[].system_prompt` 标记"系统提示区条目"（素材 540 条中 48 条 true，其中 10 条 `role=user`）；`automationId`/`outletName` 是 ST 独立世界书条目的**顶层驼峰**字段，而我们只查蛇形 `automation_id` / `outlet_name` | `automationId` 字段每条都有但**非空值 0**；`outletName` 非空值 0；`forbid_overrides` 2 条 true |

#### P3：边界未显式化

| 编号 | 严重度 | 项 | ST 依据与语义 | 素材实测 |
|---|---|---|---|---|
| K8 | P3 | `extensions.depth_prompt` 完全未转换 | `char-data.js:73-76` 定义 `{ prompt, depth, role }`；`group-chats.js:459-464` 群聊注入；`world-info.js:191` 供世界书扫描 | **13 张卡带该字段**（现被整体丢弃，无来源元数据、无诊断） |
| K9 | P3 | token 预算 / `ignoreBudget` / `forbid_overrides` / AN·EM·outlet 位置 | `world_info_budget=25`（`world-info.js:73`）、`ignoreBudget`（`:4095`）、`forbid_overrides`（ST prompt 覆盖保护）；`world_info_position` 含 `ANTop:2 / ANBottom:3 / atDepth:4 / EMTop:5 / EMBottom:6 / outlet:7`（`:855-864`） | `ignoreBudget` 字段存在、值全 false；outlet 全空；AN/EM/outlet 位置由既有降级逻辑覆盖但文档未成表 |

### 1.3 已核实**无缺陷**（明确不修，避免误伤）

| 项 | 上一轮怀疑 | 核实结论（证据） |
|---|---|---|
| `selective` 默认值 | 认为我们 `entry.selective === true` 与 ST 模板默认 `true` 不一致 | **不成立**：ST 求值路径是 `entry.selective &&`（`world-info.js:4925`，注释 `//all entries are selective now`），`undefined`/`false` 都不过滤，与我们的 `=== true` 一致；`newWorldInfoEntryDefinition.selective.default = true`（`:4089`）只是新建条目模板默认值。素材 1919 条全部显式布尔（224 true / 1695 false），带副键的 4 条全 true |
| `use_regex` | 认为 key 的正则语义未接线 | **不成立**：ST 匹配器不消费该字段（`src/endpoints/characters.js:681` 的 `use_regex: true // ST keys are always regex` 只是导出时写死），真正规则是"键形如 `/pattern/flags` 才当正则"，我们 `engine/anchor-match.mjs` 在 `useRegex` 缺省时**已按同语义自动检测**（三态 true/false/缺省） |
| 世界书 logic / position / 默认值 | — | `world_info_logic`（AND_ANY/NOT_ALL/NOT_ANY/AND_ALL）与 `world_info_position` 逐一比对一致；`scan_depth` 默认 2、`case_sensitive`/`match_whole_words`/`recursive` 默认 false 一致 |
| 「无主键非常驻条目永不触发」 | 曾报内容丢失（V0.66 的 45/89、萧谴的 6/19） | **误报**：这些条目 `automationId` 为空、`constant=false`、无主键，ST 侧同样不触发，属等价转译 |
| 宿主消息不变量（issue 04 同类） | 是否还有别的形态写出不可加载日志 | 1919 条世界书 + 540 条 prompts + 1695 条大卡实测：注入消息 `id`/`role`/`source.kind`/`content` 全合法，官方 `Session.create(seed)` 重载通过；除已修的 H0 角色外无新发现 |

### 1.4 复盘证据边界

- 复盘为**只读**：未修改 ST 源码、DSH 源码、参考项目与用户数据；临时探针建在 `D:\AI\workspase\_temp` 并已清理；仓库工作树保持干净。
- 素材只代表 `F:\ai\other\AIcord\123` 的 17 个文件；"素材实测 N 条"不宣称覆盖其他来源的全部形态。K4–K7 的字段在素材里多为默认值，实施后需用**合成夹具**补足行为证据。
- 参考项目 `dsh-tavern` 的对照只作旁证：它读取了 `delayUntilRecursion` / `useGroupScoring`（佐证 K2/K3），同样未处理 `matchCreatorNotes` / `matchCharacterDepthPrompt` / `characterFilter` / `use_regex`；它的世界书 AN/EM/atDepth 由**自建编排**实现，本项目受"pre-step / system-section 两层注入"的产品边界约束，不照搬。
- 本轮不复核 R0–R6 的验收结论；它们的证据在归档计划与提交历史中。

## 2. 用户决策与方案范围

### 用户已明确的决策

1. 追赶 issue 04 的同类问题，按"是否存在其他 ST 转译问题"出复盘结论，并据此创建本计划。
2. P1 的两个候选方案取 **B 含 A**：既登记可赋值变量（恢复能力），也产出诊断（可见性）。
3. **P2、P3 一并纳入本轮**（用户明确要求），不再只作候选记录。
4. `selective` 默认值与 `use_regex` 按第 1.3 节记录为"已核实无缺陷"，**不修**。
5. 本文件只写方案；**执行修复、改用户预设、历史日志恢复都需要用户后续单独授权**。
6. 不改 DSH 宿主与 ST 源码；不实现跨插入点的全局顺序、持久历史深度插入或完整 ST 消息编排。

### 2.1 方案取舍（P1）

| 维度 | 方案 A：保留原键 + 报告诊断 | 方案 B：登记为可赋值变量（含 A 的诊断） |
|---|---|---|
| 解决的问题 | 可见性（不再静默失效） | 可恢复性（赋值后真正恢复触发） |
| 是否改匹配行为 | 否 | 否（空值键被引擎 `filter(Boolean)` 丢弃，不会误触发） |
| 与 ST 等价性 | 仍不等价 | 更接近等价 |
| 成本 | 扫描 + 诊断 | 同一份扫描结果 + 登记（增量极小），A 是 B 的副产品 |

结论：**单做 A 只能"看见失效"，单做 B 不知道哪些键需要赋值**；两者共用同一份识别逻辑，因此合并为一条最小改动（B 含 A）。

### 2.2 P2/P3 的方案取舍

| 项 | 采用 | 不采用（及理由） |
|---|---|---|
| K2 `delayUntilRecursion` | 引擎求值：非递归 pass 抑制 + 数字层数门槛（对齐 `world-info.js:4860-4866`），并记录 `excluded: delay-until-recursion` 诊断 | 不实现 ST 的 `min_activations` 深度偏斜（默认关闭，独立特性） |
| K3 `useGroupScoring` | 抄 `getScore`（`:423-500`）实现评分，仅在**条目显式开启**时替换权重随机；未开启时保持现状 | 不把评分设为默认（ST 默认继承全局 false，改了会变更既有分组行为） |
| K4/K5 扫描开关 | 转换期登记 `creator_notes` / `depth_prompt` 变量；引擎在对应开关为 true 时把它们并入扫描文本（与既有 `matchCharacterDescription` 等同一形状） | 不默认扫描（ST 默认 false，多扫会改变触发面） |
| K6 `characterFilter` | 读取嵌套对象（含把旧的三字段误读改为对象形态）、保留到 `stWorldBook`、产出"按角色过滤不受支持"的 warning | 不实现真正的按角色过滤：本项目预设与角色是导入期绑定，没有"运行时切换角色"这一层，伪造过滤会产生错误的静默跳过 |
| K7 `system_prompt` | 保留事实到 `stSource.systemPrompt` 并产出 info 诊断；**层归属仍按 `role`**（先核实 ST 注入方式再定，见 3.9） | 不把 `system_prompt: true` 一律改判为 system-section：会改变素材 48 条（其中 10 条 role=user）的实际注入位置，需先有 ST 证据 |
| K7 `automationId` / `outletName` | 双形态读取（蛇形 + 驼峰）；`automationId` 非空且条目无键非常驻时产出"依赖 STscript 自动化"的 warning | 不实现 STscript 自动化触发（属"不实现完整 ST 消息编排"边界） |
| K8 `depth_prompt` | 读取并生成一条**禁用**的 pre-step 配置（来源标注 + 诊断），用户可手动启用；同时登记 `depth_prompt` 变量供 K5 扫描 | 不默认注入（ST 只在群聊自动注入，本项目无群聊；默认注入会造成"ST 不注入而我们注入"的反向不等价） |
| K9 预算等 | 文档化边界（`docs/SillyTavern.md` 新增边界表），不改行为 | 不实现 token 预算：需要官方 tokenizer 与上下文预算通道，超出本插件边界；不实现 `forbid_overrides`（DSH 无覆盖机制） |

### 2.3 有意不做

- 不在导入期猜测 `{{user}}` 的值（来自 ST 全局设置与 persona，卡内不存在；用 keys 里的同义词反推属猜测）。
- 不新增 DSH 侧"用户名"配置项或 UI 控件：既有「模板变量」编辑器已能承载。
- 不删改用户已导入的预设：登记与新诊断只作用于新的转换产物，旧产物需重新导入。
- 不改引擎匹配语义（`anchor-match.mjs` 的正则/整词/大小写规则）、不改世界书求值顺序、抽样与 sticky/cooldown 时间窗。
- 不把 key 里的**已登记**宏（`{{char}}` / `{{description}}` 等）纳入告警：ST 侧同样展开成文本，行为一致。
- 不处理 `ignoreBudget` 的实际预算逻辑与 ST 全局设置（`world_info_budget` / `budget_cap` / `min_activations` / `use_group_scoring` 全局开关）。

### 2.4 恢复路径的取舍（P1 设计前提）

引擎对键的求值只读取**配置级变量**（`config.variables`，由 `loadPromptConfigFiles` 把预设级 `variables.yml` 合并进每条配置）。因此：

- **默认（R7 采用）**：登记进**预设级 variables** → 用户在「模板变量」里赋值 → 写入 `variables.yml` → 重建后键生效。零引擎改动。
- **不采用（需单独同意才做）**：让键同时读**会话变量**（`session_var` 工具维护的运行时表），需要改 `engine/st-world-book.mjs` 的键求值并扩大语义面（键匹配从静态变为随会话变化）。

## 3. 修复设计

### 3.1 R7：把 key / secondaryKeys 纳入宏登记（K1）

- 位置：`src/host/sillytavern.ts#convertStToPresetWithReport` 内既有的「未定义自定义宏登记」循环（当前只遍历 `config.text` / `config.texts` / `params.text`）。
- 做法：对每条 `strategy === 'world-book'` 的配置，额外读取 `params.keys` 与 `params.secondaryKeys`，与正文共用**同一个** `MACRO_RE` / `RUNTIME_MACROS` / `BUILTIN_KEYS` / `knownKeys` 判定：
  - 命中运行时宏（`time`/`date`/`random`/`pick`/`roll`/`chance`/`lastusermessage` 等）或内置路径变量 → **不登记**（保持运行时求值）；
  - 已存在于变量表（`char`、卡片正文变量、用户已填的模板变量）→ **不覆盖**；
  - 其余未定义宏（如 `user`）→ 登记 `variables[宏名] = ''` 空占位。
- 诊断：对含未解析宏的世界书条目各发一条 warning `note('st-key-macro', …, { entryId, field: 'keys' })`，文案说明"已登记空占位，可在「模板变量」赋值使其生效"，不记录正文。
- 运行期无需改动：未赋值 → 键渲染为空串 → 引擎 `filter(Boolean)` 丢弃 → 不误触发；赋值后 → 走既有匹配。
- `ST_CONVERTER_VERSION` 递增为 `st-to-preset/3`。

### 3.2 R8：`delayUntilRecursion` 与 `useGroupScoring`（K2/K3）

> 本节已按 3.9 核实点 1–2 的 ST 源码结论修正（2026-09-17），实现以修正后的语义为准。

- `delayUntilRecursion`：转换期把 `option('delay_until_recursion', 'delayUntilRecursion')` 写入 `params.stWorldBook.delayUntilRecursion`；引擎按 ST 的**层级池**语义求值（`world-info.js:4753-4762`、`:4860-4868`）：
  - 层级池 = 条目集合里所有真值去重升序（`true` 归一为 1），初始化即取走最小层级，层级只增不减；
  - `pass === 0`（非递归 pass）且该字段为真 → 记 `excluded: delay-until-recursion` 并跳过（sticky 命中除外，`constant` 也不例外）；
  - `pass > 0` 且「条目原始值 > 当前层级」→ 记同一原因并跳过；
  - pass 推进与 ST 一致：有新正文可递归时层级保持不变，否则在层级池仍有剩余时打开下一层（`:5129` 的判断不含全局 recursive）。
- `useGroupScoring`：转换期写入 `params.stWorldBook.useGroupScoring`；引擎在组选择分支里按 `filterGroupsByScoring`（`:5292-5328`）实现——组内存在显式开启的条目时整组按 `getScore` 等价实现（`:428-473`：只统计命中键数，`NOT_ALL`/`NOT_ANY` 不参与加分）计算分数，**只有开启评分的条目**会被「严格小于最高分」淘汰，未开启者不被淘汰但其分数计入最高分；组内有 sticky 命中时整组跳过评分；淘汰后才走既有的 groupOverride / 权重随机。
- 两项都必须补齐诊断原因码与差分测试（同一条目在开启/关闭下抽样次数与入选集合的差异必须可解释）。

### 3.3 R10：`characterFilter`（K6）

> 形态已按 3.9 核实点 5 修正：现有实现是**完全未读取**（不是误读三顶层字段），
> `characterFilterNames/Tags/Exclude` 只是 slash 命令的字段名（`world-info.js:4121-4123`，
> 且 `excludeFromTemplate: true`），存储形态始终是嵌套对象。

- 形态修正：读取 `entry.characterFilter`（对象 `{ names, tags, isExclude }`，`world-info.js:2125-2132` 规范化、`:4815-4843` 求值）。
- 处理：原样保留到 `params.stWorldBook.characterFilter`（不解释成行为），并对**实际启用过滤**的条目（`names`/`tags` 至少一个非空，与 ST 的判定条件一致）发 warning："ST 角色/标签过滤在本项目不受支持：该条目会对所有角色生效"。
- 不实现过滤（理由见 2.2）。

### 3.4 R11：`automationId` / `outletName` 双形态与显式诊断（K7）

- 读取改为 `option('automation_id', 'automationId')` 与 `option('outlet_name', 'outletName')`（extensions 蛇形 + 顶层驼峰）。
- `automationId` 非空时：写入 `params.stWorldBook.automationId` 并产出 warning"该条目依赖 STscript 自动化触发，本项目不执行自动化"；若该条目同时无主键且非 `constant`，warning 文案明确"因此不会自动注入"。
- `outletName` 非空时：沿用 `unsupported-controls` 诊断（内容不被误注入）。

### 3.5 R12：`prompts[].system_prompt`（K7）

> 已按 3.9 核实点 3 得出结论：`system_prompt` 是 ST 的**管理位**（标记内置/全局 prompt：
> 不可删除、不参与导出、不在 append 候选），发送角色与位置完全由 `role` 与 `prompt_order`
> 决定（`openai.js:1240-1257` 的运行时过滤、`:1187-1208` 的角色取用、`PromptManager.js:1723-1729`
> 的图标判定）；`forbid_overrides` 与它无运行时耦合（只保护 `main`/`jailbreak` 不被角色卡覆盖，
> `openai.js:1495-1513`）。因此采用下面的第一种处置。

- 核实结论：ST 仅把它作为"内置/全局 prompt"标记，**不改变发送角色** → 我们**保持按 `role` 分层**，只把 `systemPrompt: true` 写入 `params.stSource` 并产出 info 诊断。
- 不做层改判；素材 48 条（38 条 `role=system` + 10 条 `role=user`）的分类与定位由 T19 断言稳定。

### 3.6 R13：`depth_prompt` 保留与变量登记（K8）

- 读取 `body.extensions.depth_prompt`（`{ prompt, depth, role }`）：
  - `prompt` 非空 → 生成一条**禁用**的 pre-step 配置（`id: st-depth-prompt`、`enabled: false`、来源标注 `params.stSource`、`classification: 'degraded'`、原因码 `depth-prompt-group-only`），并在报告里列出，用户可手动启用；
  - 同时登记变量 `depth_prompt`（供 R9 的 `matchCharacterDepthPrompt` 扫描）与 `creator_notes`（供 `matchCreatorNotes`），两者都来自卡片全文（清洗后）。
- 不默认注入（理由见 2.2）；旧卡重新导入才生效。

### 3.7 R9：扫描开关接线（K4/K5）

- 转换期把 `matchCreatorNotes` / `matchCharacterDepthPrompt` 写入 `params.stWorldBook`（`option('match_creator_notes', 'matchCreatorNotes')` 等）。
- 引擎在构造扫描片段时（现有 `matchCharacterDescription` / `matchCharacterPersonality` / `matchScenario` / `matchPersonaDescription` 同一位置）按开关并入 `config.variables.creator_notes` / `config.variables.depth_prompt`。
- 未开启时不并入（不得改变既有触发面）；R13 未落地时这两个开关保持关闭即可独立发布（但本计划按 R13 → R9 顺序执行）。

### 3.8 R14：边界文档化（K9）

- `docs/SillyTavern.md` 新增"未复刻的 ST 能力与降级对照"表：token 预算（`world_info_budget` / `budget_cap` / `ignoreBudget`）、`forbid_overrides`、`min_activations`、全局开关（`use_group_scoring` / `case_sensitive` / `match_whole_words` / `recursive` 的 ST 全局默认）、位置枚举 `ANTop/ANBottom/atDepth/EMTop/EMBottom/outlet` 的降级结果与诊断码、`vectorized` / `outlet` / `automationId` / `triggers` 的不支持口径。
- 表格每行必须与实现一致（引用实际诊断码），不得把"已降级"写成"等价"。

### 3.9 实施前必须核实（每个任务的第一步）

| # | 核实点 | 位置 | 影响的任务 |
|---|---|---|---|
| 1 | `getScore` 的完整合并规则（各 `selectiveLogic` 分支如何合成最终分数、同分时如何取舍） | `world-info.js:423-500` | R8 |
| 2 | `delayUntilRecursion` 与 `min_activations` 的交互、`isSticky` 例外边界、递归层计数起点 | `world-info.js:4755-4880` | R8 |
| 3 | `prompts[].system_prompt` 在 prompt manager 中的注入方式与 `forbid_overrides` 的关系 | `openai.js`（prompt manager 段） | R12 |
| 4 | `globalScanData` 的实参填充点：`creatorNotes` / `characterDepthPrompt` 分别取自哪个字段 | `script.js` / `openai.js` 的 `getWorldInfoPrompt` 调用 | R9、R13 |
| 5 | `characterFilter` 的求值时机与"当前角色"来源（是否只在群聊生效） | `world-info.js`（判定段）与 `group-chats.js` | R10 |
| 6 | R0–R6 之后的引擎写区现状（`runPreStepBatch` / `selectWorldBook` 签名与诊断快照结构） | `engine/executor.mjs`、`engine/st-world-book.mjs` | 全部 |

核实结论必须写进对应任务的 Task Summary；与本节冲突时以 ST 源码为准并同步本节。

## 4. 任务拆解与执行

格式依据：用户指定的 `D:\AI\CC-switch\skills\dev-expert\SKILL.md`，子技能 `references/task-decomposition-and-execution.md`。
遵循需求分析 → 原子任务拆解 → Wave 分组 → 上下文隔离 → 执行/自测/复核/Task Summary → 项目记忆记录。
任务卡使用 XML 的 name、files、action、verify、security、done 字段，并补充 depends_on 与 rollback。

### 需求概述

把 ST 转译从"结构可用"推进到"条件与边界可复核"：键里的宏能被赋值救回、ST 的条目级条件开关被真实读取或明确拒绝、未复刻能力成表可查。所有改动都在既有 host/engine 边界内，不新增服务、不复制 ST 运行时。

| Wave | 任务 | 前置条件与执行顺序 |
|---|---|---|
| Wave 4：文档规划 | D1 | 归档旧计划、编写本方案、记录用户决策并完成文档校验；**不是代码修复** |
| Wave 5：P1 触发条件 | R7 | 用户明确授权实施；独立可交付 |
| Wave 6：P2 条件字段 | R8 → R10 → R11 → R12 | R8 只动 engine；R10/R11/R12 与 R7 共用 `sillytavern.ts`，必须串行 |
| Wave 7：P3 与扫描接线 | R13 → R9 | R9 依赖 R13 登记的变量；R13 与 Wave 6 的 host 改动串行 |
| Wave 8：边界文档与集成 | R14 → 验收 | R14 汇总 R7–R13 的实际诊断码与行为 |
| 独立恢复操作 | H1 | 防复发生效且用户单独授权目标与恢复方式后才执行，不混入代码 Wave |

### 4.1 Wave 5

```xml
<task id="R7" type="auto">
  <name>把世界书 key/secondaryKeys 纳入宏登记并产出可见诊断</name>
  <depends_on>用户明确授权实施；无其他业务依赖（R0–R6 已交付）</depends_on>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；test/engine/st-world-book.test.mjs；test/host/st-preview-report.test.mjs（报告字段确有需要时）；docs/SillyTavern.md；CHANGELOG.md</files>
  <action>按 3.1 节扩展既有「未定义自定义宏登记」循环到 params.keys / params.secondaryKeys，共用同一份排除集（运行时宏、内置路径变量、已登记变量）与同一 variables 表；对含未解析宏的世界书条目发一条 warning 诊断；递增 ST_CONVERTER_VERSION 并同步文档。</action>
  <verify>T11/T12/T13/T14：转换期登记与诊断、运行期"未赋值不触发 / 赋值后命中 / 不误触发"、字面键与 `{{char}}` 不回归、secondaryKeys 与畸形宏边界；定向测试 + 完整门禁全绿。</verify>
  <security>不执行宏、不重跑选择器、不写用户预设；诊断不记录正文；只新增 variables 键，不覆盖用户已有值，不改写盘结构与权限规则。</security>
  <rollback>反向提交；旧转换产物不受影响，用户既有预设与变量不被修改。</rollback>
  <done>含未解析 key 宏的条目在预览里可见、在模板变量赋值后能命中，字面键与已登记宏行为不变，文档同步且完整门禁通过。</done>
</task>
```

### 4.2 Wave 6

```xml
<task id="R8" type="auto">
  <name>引擎支持 delayUntilRecursion 与 useGroupScoring</name>
  <depends_on>用户授权实施；先完成 3.9 的核实点 1–2</depends_on>
  <files>src/host/sillytavern.ts（字段写入）；engine/st-world-book.mjs；engine/st-world-book.d.mts（类型需要时）；test/engine/st-world-book.test.mjs；docs/engine-reuse.md</files>
  <action>按 3.2 节写入并在求值中消费两个字段：非递归 pass 抑制 + 数字层数门槛；条目显式开启评分时用 getScore 等价实现替换权重随机。补齐稳定原因码与诊断字段。</action>
  <verify>T16：非递归 pass 不激活、层数门槛生效、sticky 例外、开关关闭时行为与既有断言逐条一致；评分开启时同组选择结果与 ST 算法逐例对齐（用抄写的算法做对拍夹具）。</verify>
  <security>不改变未开启条目的求值路径；抽样次数、sticky/cooldown 时间窗与入选集合的差异必须可解释；诊断不持久化正文。</security>
  <rollback>反向提交；两字段只在新导入产物上出现，旧预设行为不变。</rollback>
  <done>两个开关在开启与关闭两种状态下都有行为证据，诊断原因码稳定，完整门禁通过。</done>
</task>

<task id="R10" type="auto">
  <name>角色过滤字段按真实形态读取并显式拒绝</name>
  <depends_on>用户授权实施；与 R7 串行（同一文件）</depends_on>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.3 节把误读的三个顶层字段改为读取 entry.characterFilter 对象，原样保留到 stWorldBook 并产出"按角色过滤不受支持"的 warning；未使用该字段时不产生诊断。</action>
  <verify>T17：对象形态（names/tags/isExclude）完整保留；使用该字段的条目有一条 warning；未使用时零诊断；既有世界书断言不回归。</verify>
  <security>不实现过滤、不据此跳过条目（避免静默丢失）；保留原始字段供复核。</security>
  <rollback>反向提交，只影响诊断与保留字段。</rollback>
  <done>形态读取与诊断都有断言，文档写明不支持口径，完整门禁通过。</done>
</task>

<task id="R11" type="auto">
  <name>automationId / outletName 双形态读取与自动化依赖诊断</name>
  <depends_on>用户授权实施；与 R7/R10 串行</depends_on>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.4 节改为蛇形 + 驼峰双读；非空 automationId 产出 warning（无键非常驻时文案明确"不会自动注入"）；outletName 沿用 unsupported-controls。</action>
  <verify>T18：两种拼写都能读到；非空值触发诊断；空值与缺省零诊断；素材回归（非空值 0）不新增噪音。</verify>
  <security>不执行自动化、不把 automationId 当作注入依据；不改变条目启用状态。</security>
  <rollback>反向提交，只影响读取面与诊断。</rollback>
  <done>双形态与诊断均有断言，文档同步，完整门禁通过。</done>
</task>

<task id="R12" type="auto">
  <name>prompts[].system_prompt 按核实结论处理并保留事实</name>
  <depends_on>用户授权实施；先完成 3.9 的核实点 3；与 R7/R10/R11 串行</depends_on>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；test/host/st-preview-report.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.5 节先核实 ST 注入方式，再选择"仅保留事实 + info 诊断"或"改判 system-section + degraded"；无论哪种都把 systemPrompt 事实写入 params.stSource 并保证 48 条素材条目分类稳定。</action>
  <verify>T19：素材 48 条（38 role=system + 10 role=user）在两种结论下都有稳定分类与可复核定位；层归属变化（若采用改判）有前后对照断言；报告计数与 stWarnings 同源。</verify>
  <security>不改写正文；不做未经验证的层改判（先有 ST 证据再改）。</security>
  <rollback>反向提交；若采用改判，回滚后恢复按 role 分层。</rollback>
  <done>核实结论写入 Task Summary，分类与诊断有断言，文档说明与实现一致，完整门禁通过。</done>
</task>
```

### 4.3 Wave 7

```xml
<task id="R13" type="auto">
  <name>depth_prompt 保留为禁用配置并登记扫描变量</name>
  <depends_on>用户授权实施；与 Wave 6 的 host 改动串行；先完成核实点 4</depends_on>
  <files>src/host/sillytavern.ts；test/host/st-compatibility.test.mjs；test/host/st-preview-report.test.mjs；docs/SillyTavern.md</files>
  <action>按 3.6 节读取 body.extensions.depth_prompt，生成一条禁用配置（来源标注 + degraded + 原因码 depth-prompt-group-only），并登记 depth_prompt / creator_notes 变量；不默认注入。</action>
  <verify>T20：13 张素材卡各自的 depth_prompt 都被保留且 enabled=false；不注入（pre-step 结果不含它）；报告列出该条目；变量登记可被后续扫描开关使用。</verify>
  <security>不执行宏、不改卡片、不默认注入；来源正文只进禁用配置，不进模型上下文。</security>
  <rollback>反向提交；旧产物不含该配置，行为回到"丢弃"。</rollback>
  <done>保留、不注入、可复核三件事都有断言，文档同步，完整门禁通过。</done>
</task>

<task id="R9" type="auto">
  <name>matchCreatorNotes / matchCharacterDepthPrompt 扫描接线</name>
  <depends_on>R13（变量登记）；R8（同一引擎文件，串行）</depends_on>
  <files>engine/st-world-book.mjs；src/host/sillytavern.ts（字段写入）；test/engine/st-world-book.test.mjs；test/host/st-compatibility.test.mjs；docs/engine-reuse.md</files>
  <action>按 3.7 节：转换期写入两个开关；引擎在既有角色字段扫描处按开关并入 creator_notes / depth_prompt 变量；未开启时不并入。</action>
  <verify>T21：开关开启时条目能因 creator notes / depth prompt 命中；关闭时不命中且扫描文本与既有断言逐字一致；扫描窗口与深度语义不变。</verify>
  <security>不默认扫描、不改变既有触发面；不执行宏、不持久化扫描文本。</security>
  <rollback>反向提交，回到不扫描状态。</rollback>
  <done>开启/关闭双向行为都有断言，文档同步，完整门禁通过。</done>
</task>
```

### 4.4 Wave 8

```xml
<task id="R14" type="auto">
  <name>未复刻能力与降级对照文档化</name>
  <depends_on>R7–R13 全部完成（要引用真实诊断码与行为）</depends_on>
  <files>docs/SillyTavern.md；CHANGELOG.md；README.md（仅当行为变化需要使用者知晓时）</files>
  <action>按 3.8 节新增边界对照表：token 预算 / ignoreBudget / forbid_overrides / min_activations / ST 全局开关 / 位置枚举降级 / vectorized·outlet·automationId·triggers 的不支持口径；每行引用实际诊断码并标注"降级/不支持/等价"。</action>
  <verify>T22：文档每行与实现一致（逐项用源码位置或测试断言核对）；无"已降级却写成等价"的表述；链接与路径有效。</verify>
  <security>只改文档，不改行为；不把用户数据或素材正文写入文档。</security>
  <rollback>反向提交，仅文档回退。</rollback>
  <done>对照表与实现逐项对齐，CHANGELOG 记录本轮范围，完整门禁（含 diff --check）通过。</done>
</task>
```

### 4.5 执行与冲突规则

- 默认串行执行；只有用户或适用技能明确要求代理时才委派，先声明目标、独占写区与验收，主线程复跑后采信。
- 写区冲突：`src/host/sillytavern.ts` 被 R7/R10/R11/R12/R13 共用，`engine/st-world-book.mjs` 被 R8/R9 共用，`docs/SillyTavern.md` 被 R7/R10/R11/R12/R13/R14 共用——这些文件**不得并行落码**。
- 每任务先读现有实现、`grep` 全部调用方（`params.keys` / `secondaryKeys` / `knownKeys` / `stWorldBook` / `note(` / `getScore` 对应实现）并检查工作树，再写最小红灯测试；修复后跑定向测试与完整门禁。
- 3.9 的核实点未完成前，不得按推测实现（尤其 R8 的评分算法与 R12 的层归属）。
- 同一诊断方向连续失败 3 次停止扩展，记录原因与替代路径；不能用跳过失败断言满足 done。
- 完成勾选要求行为矩阵、原始命令/退出码与实际输出齐全；整套测试全绿不能替代新回归。
- Task Summary 原地追加到本节，包含完成状态、修改文件、验证证据、置信度、关键决策、偏差说明、遗留问题与下一步；执行后先自测、复核、记录 summary，再更新文末状态；部分完成、失败和受阻仍标 `[ ]` 并说明原因。
- 本地 `daily.md` 只记修改记忆，不放第二份任务账本；本文件的状态与提交是恢复检查点。

### 4.6 Task Summary：D1 文档交付

- **完成状态**：文档编写与校验完成；R7–R14 未开始，H1 未授权。
- **修改文件**：本轮仅 `PLAN.md` 与旧计划归档 `.scratch/prompt-tool-framework/archive/plan-import-lifecycle-r0-r6-f3539fa.md`。
- **验证证据**：归档与 `f3539fa:PLAN.md` 的 blob `bc4c316d85ca06d3541370a7ee5e5100e4bdd884` 字节一致（`git hash-object --no-filters`）；本文件本地链接、8 个 XML 任务字段与依赖、验收编号 T11–T23、文末状态与 package scripts 校验通过；UTF-8 无 BOM、`git diff --check` 通过。
- **置信度**：高。第 1.2 节每项都带 ST 源码行号或素材实测；第 3.9 节把尚需核实的 6 处明确列出，不把推测写成方案。
- **关键决策**：范围取 P1+P2+P3；P1 采用 B 含 A；K6 只保留不实现过滤；K8 保留为禁用配置不默认注入；K3 只在条目显式开启时生效；`selective`/`use_regex` 已核实无缺陷不改。
- **偏差说明**：复盘期间曾把"无主键非常驻"误报为内容丢失、曾误判 `selective` 与 `use_regex`，均已在第 1.3 节更正；未运行业务测试或构建（纯文档）。
- **遗留问题**：R7–R14 待授权；3.9 的 6 处核实点未做；素材对 K4–K7 的覆盖为默认值，需合成夹具补行为证据；H1 未授权。

### 4.7 Task Summary：R7（Wave 5）

- **完成状态**：完成。T11–T14 行为断言通过；`typecheck` / `lint` / `test`（936/936）/ `build` 全绿。
- **修改文件**：`src/host/sillytavern.ts`（宏登记循环扩展到键 + `worldBookSources` 映射 + `ST_CONVERTER_VERSION` → `st-to-preset/3`）；`test/host/st-compatibility.test.mjs`（T11/T13/T14）；`test/engine/st-world-book.test.mjs`（T12）；`test/host/st-preview-report.test.mjs`、`test/fixtures/character-import.mjs`、`test/client/import-preview-browser.test.mjs`（转换器版本同步）；`docs/SillyTavern.md`；`CHANGELOG.md`。
- **验证证据**：
  - 定向：`node --test test/host/st-compatibility.test.mjs test/engine/st-world-book.test.mjs` → `pass 29 / fail 0`；改动前先跑红灯，T11/T13/T14 三条以 `undefined !== ''` 失败。
  - 完整门禁（隔离 cwd `D:\AI\workspase\_temp`）：`pnpm typecheck` 退出 0、`pnpm lint` 退出 0（0 warning / 0 error）、`pnpm test` → `tests 936 / pass 936 / fail 0`、`pnpm build` 退出 0。
  - 行为证据：`keys=['{{user}}']` 的条目 `spec.variables.user === ''`；`report.diagnostics` 含一条 `st-key-macro`（`entryId='25'`、`field='keys'`、severity=warning）；`report.summary.needsReview === 1`；`spec.meta.stWarnings` 含同文案。运行期未赋值时消息 `'Alice'` 与 `'{{user}}'` 都不注入；`variables.user='Alice'` 后 `'Alice'` 命中 `lore-25`、`'Bob'` 不命中、重复求值幂等；`params.keys` 原文未被改写。
  - 边界证据：仅 `secondary_keys` 含宏时 `field='secondaryKeys'`；`{{USER}}`/`{{user}}` 只登记一个键；`{{time}}`/`{{DSH_HOME}}`/`{{random::a,b}}` 零诊断零登记；畸形引用（`{{`、`{{}}`、`{{a{{b}}`）不抛错（`b` 按最内层宏宽容登记）；250 条含宏条目时诊断截断为 200 且 `report.truncated === true`。
- **核实点**：3.9 无 R7 依赖项。实施前按符号重新定位了宏登记循环（`src/host/sillytavern.ts`）、`buildWorldBookEntry` 的 params 键集（`src/host/worldbook.ts`）与引擎键求值 `interpolateVariables(...).filter(Boolean)`（`engine/st-world-book.mjs:95-96`），确认「未赋值不误触发」无需引擎改动。
- **关键决策**：①诊断判定基准取**登记开始时的变量表快照**（`declaredKeys`），而不是「本次是否新登记」——否则同一宏在第二个条目出现时不再产出诊断，素材 5 条受影响条目只有 1 条可见，不满足 R7 的 done 标准。②复用 `note()` 原有的 `code + entryId` 去重：每个条目一条 warning，`field` 记录首个命中字段，`keys` 与 `secondaryKeys` 不重复刷屏。③诊断文案固定且不含键正文，只说明失效原因与恢复路径。④用显式 `Map<配置 id, 来源条目 id>` 关联，不按 `lore-` 前缀反推。
- **偏差说明**：`ST_CONVERTER_VERSION` 升为 `st-to-preset/3`，连带同步 3 处测试夹具的版本字符串（`st-preview-report.test.mjs` 是硬断言，另两处是报告形状夹具）；`lib/` 由 `pnpm build` 重新生成。未做真实浏览器 smoke（T23 集成留到 Wave 8）。
- **遗留问题**：旧转换产物不含新登记与新诊断，需用户重新导入才生效（不自动回写用户 `preset.yml`）。

### 4.8 Task Summary：Wave 6（R8 / R10 / R11 / R12）

- **完成状态**：完成。T16–T19 行为断言通过；`typecheck` / `lint`（0 warning）/ `test`（943/943）/ `build` 全绿。
- **3.9 核实结论**（依据 ST 1.19.0 源码，行号经只读复核修正）：
  1. **`getScore`（`world-info.js:428-473`，唯一调用点 `:5307`）**：只统计命中数，不做 tie-break、永不返回 -1（唯一提前返回是主键数组为空时的 `0`）。设 `P`/`S` 为主/副键命中数、`NS` 为副键总数：主键为空 → `0`；`NS === 0` → `P`；`AND_ANY(0)` → `P + S`；`AND_ALL(3)` → `S === NS ? P + S : P`；`NOT_ALL(1)`/`NOT_ANY(2)`/其他 → `P`（源码注释「Only positive logic influences the score」，否定逻辑只影响激活判定）。
  2. **`filterGroupsByScoring`（`:5292-5328`）**：组级门控是「全局开关为真 **或** 组内至少一条 `useGroupScoring` 为真值」；组内有 sticky 时整组跳过（`:5300-5305`）；`scores = group.map(getScore)`、`maxScore = Math.max(...scores)`，只有 `useGroupScoring ?? false` 为真的条目会被 `scores[i] < maxScore` 淘汰——**显式 `false`/`null` 的条目不被淘汰，但其分数仍计入 `maxScore`**（`:5307-5317`）。淘汰后才走 `groupOverride` 与权重随机（`:5444-5473`）。
  3. **`delayUntilRecursion`（`:4753-4762`、`:4860-4868`、`:5128-5133`）**：语义是**层级池**而不是 pass 序号——池 = 所有真值去重升序（`true` 归一为 1），初始化即 `shift` 取走最小层级，层级只增不减。门控为 `真值 && !isSticky && (scanState !== RECURSION || 条目原始值 > 当前层级)`：非递归 pass 一律抑制（`constant`/`@@activate`/外部激活都在其后，同样被抑制），sticky 是唯一例外。层级推进只在「本 pass 没有递归新正文」且池仍有剩余时发生，且该判断不含全局 `world_info_recursive`。`min_activations` 独立、默认 0，与延迟层级不叠加。
  4. **`prompts[].system_prompt`（核实点 3）**：只是「内置/全局 prompt」的管理位（不可删除、不参与导出、不在 append 候选），发送角色与位置由 `role` 与 `prompt_order` 决定（`openai.js:1240-1257`、`:1187-1208`；`PromptManager.js:1723-1729` 只用于图标）。`forbid_overrides` 与它无运行时耦合（`openai.js:1495-1513` 只保护 `main`/`jailbreak` 被角色卡覆盖）。
  5. **`characterFilter`（核实点 5）**：嵌套对象 `{ names, tags, isExclude }`（`:2125-2132` 规范化）；`names` 是**头像文件名去扩展名**、`tags` 是标签 id；`isExclude: false` 是白名单（names 与 tags 之间 AND）、`true` 是黑名单（OR）；`names`/`tags` 为空数组时不启用该维度（`:4816`/`:4826` 的 `length > 0` 前置），`tags` 分支还有 `if (tagKey)` 缺口。求值时机在 `disable`/`triggers` 之后、sticky/cooldown/delay 与 `constant` 之前。`characterFilterNames/Tags/Exclude` 只是 slash 命令字段名（`:4121-4123`，`excludeFromTemplate: true`），不是存储形态。
- **修改文件**：`engine/st-world-book.mjs`（层级池与延迟门控、评分淘汰、扫描材料惰性缓存与 matcher 抽取）；`src/host/sillytavern.ts`（两个条件字段写入、`characterFilter` 读取、`automationId`/`outletName` 双形态与诊断、`systemPrompt` 事实与 info 诊断）；`test/engine/st-world-book.test.mjs`（T16 + ST 算法抄写夹具）；`test/host/st-compatibility.test.mjs`（T16/T17/T18/T19）；`test/host/preset-package-import.test.mjs`（`main` 配置断言补 `stSource`）；`docs/SillyTavern.md`、`docs/engine-reuse.md`、`CHANGELOG.md`。
- **验证证据**：定向 `node --test test/engine/st-world-book.test.mjs test/host/st-compatibility.test.mjs test/host/st-preview-report.test.mjs` → `pass 26 / fail 0`（各任务先跑红灯）。行为证据：单层级无递归驱动时延迟条目不激活（`[]`）、有递归驱动时在下一 pass 解锁、层级 `1`/`3` 逐个打开后两条都注入；sticky 命中绕过延迟门控且无 `delay-until-recursion` 记录；评分对拍夹具 `[1,2,1] → [false,true,false]` 与引擎一致，诊断记录 `lore-1(1,2)`、`lore-3(1,2)`，关闭评分时回到权重随机且入选不变；`characterFilter` 嵌套对象完整保留、启用时一条 warning、空数组与非法形态零诊断；`automationId` 驼峰与蛇形都读到、无主键非常驻时文案含「不会自动注入」、空值零噪音；`system_prompt` 两条 info 且层归属 `main=system-section`/`aux=pre-step` 不变。
- **关键决策**：①延迟层级用**层级池**语义（源码为准），并同步修正 3.2 节原稿的「pass 序号」写法。②延迟条目在层级满足时参与递归 pass，不受自身 `recursive` 限制——ST 的门控不要求全局 recursive（`:4860`/`:4865` 无该条件）。③评分只淘汰显式开启的条目，未开启者的分数仍计入最高分（照抄 `:5313-5317`）。④扫描材料改为按 pass 惰性构造并缓存（`scanOf`），评分复用同一份材料，`matcherOf` 的签名与原实现一致，因此不改变未开启条目的求值路径与 `Math.random` 调用次数。⑤评分构造异常时跳过整组评分并 warn，不改变入选集合。⑥`characterFilter` 只保留不实现（预设与角色在导入期绑定，没有运行时切换角色这一层），且**不据此跳过条目**以避免静默丢失。
- **偏差说明**：①本项目的键已插值且 `filter(Boolean)`，而 ST 的 `getScore` 用原始 key（含空串、不 trim）——评分与匹配共用同一份键，一致性优先于逐字复刻（已在文档写明）。②3.3 节原稿称「现有代码读三顶层字段」，实测是**完全未读取**，已同步。③`preset-package-import.test.mjs` 的 `main` 配置断言因 R12 新增来源事实而更新。④`ST_CONVERTER_VERSION` 保持 `st-to-preset/3`（本轮统一版本），注释扩展为涵盖条件字段读取与诊断。
- **遗留问题**：素材对 K4–K7 的字段多为默认值，`matchCreatorNotes` / `matchCharacterDepthPrompt` 的行为证据由 R9 用合成夹具补；旧产物需重新导入才有新字段与诊断。

### 4.9 Task Summary：Wave 7（R13 / R9）

- **完成状态**：完成。T20/T21 行为断言通过；`typecheck` / `lint`（0 warning）/ `test`（946/946）/ `build` 全绿。
- **3.9 核实结论（核实点 4：`globalScanData` 填充点）**：唯一构造点是 `script.js:4626-4634`；`creatorNotes` ← `data.creator_notes`（`script.js:3427-3430`），`characterDepthPrompt` ← `data.extensions.depth_prompt.prompt`（`script.js:3423-3426`），二者都包 `baseChatReplace`。六个字段在 `WorldInfoBuffer.get`（`world-info.js:294-320`）按各自的 `match*` 开关**拼进同一个扫描串**（`JOINER = '\n\x01'`），随后作为唯一 haystack 参与子串/正则匹配，不是单独比较；缺省实参 `defaultGlobalScanData`（`:186-194`）全为空串，开关因此失效。C 类边界（本轮不做，留给 R14 文档化）：`extension_settings.note.allowWIScan` 为真时深度提示词会经 extension-prompt 通路**无条件**拼进扫描文本（`:4719-4726`、`:318-320`），与 `matchCharacterDepthPrompt` 无关且可能重复出现；`charDepthPrompt`/`creatorNotes` 的 resolver 不检查群卡覆盖。
- **修改文件**：`src/host/sillytavern.ts`（`creator_notes` 变量登记、`depth_prompt` 禁用配置与 `depth_prompt` 变量登记、两个扫描开关写入）；`engine/st-world-book.mjs`（扫描字段开关接入 `creator_notes` / `depth_prompt`）；`test/host/st-compatibility.test.mjs`（T20）；`test/engine/st-world-book.test.mjs`（T20 不注入、T21 开关双向）；`docs/SillyTavern.md`、`docs/engine-reuse.md`、`CHANGELOG.md`。
- **验证证据**：定向 `node --test test/engine/st-world-book.test.mjs test/host/st-compatibility.test.mjs` → `pass 39 / fail 0`。行为证据：带 `extensions.depth_prompt.prompt` 的卡产出 `st-depth-prompt` 配置且 `enabled === false`、`layer/role/position = pre-step/user/before-all`、`params.stSource.field = 'extensions.depth_prompt'`、报告条目 `degraded` + `['depth-prompt-group-only']`、`summary.disabled === 1`；运行时该配置存在但**不出现**在 `runPreStepBatch` 的注入消息里，同批的 `lore-1` 正常注入；`variables.depth_prompt`/`variables.creator_notes` 已登记，无该字段的卡片零配置零变量。开关双向：`match_creator_notes`/`match_character_depth_prompt` 开启时两条条目分别因 creator notes 与 depth prompt 命中并注入，关闭时同一批条目零注入，且既有 `match_character_description` 行为不变。
- **关键决策**：①`depth_prompt` 保留为**禁用**配置而不是直接丢弃或默认注入——ST 只在群聊注入，本项目无群聊，默认注入会造成反向不等价；禁用配置同时满足「内容不丢」「可复核」「用户可启用」。②两个扫描开关只在**显式开启且变量为字符串**时并入扫描文本，因此未开启时扫描文本与既有断言逐字一致（不改变触发面）。③变量登记与配置生成共用同一份清洗结果（`clean`），避免正文与变量两份文本漂移。④不实现 `allowWIScan` 的 extension-prompt 通路（属 ST 扩展机制，超出本插件边界），列入 R14 的边界对照表。
- **偏差说明**：`ST_CONVERTER_VERSION` 仍为 `st-to-preset/3`（本轮统一版本）；`depth_prompt` 配置的 `order = -50` 落在示例对话（-60）与开场白（-40）之间，禁用状态下不影响注入顺序。
- **遗留问题**：旧卡片需重新导入才生成 `st-depth-prompt` 与两个变量；`allowWIScan` 与群聊注入的差异在 R14 表中标注为「未复刻」。

### 4.10 Task Summary：Wave 8（R14）与最终集成验收

- **完成状态**：完成。T22 文档逐项核对、T15 保持项与 T23 集成验收均通过；最终门禁 `typecheck` / `lint` / `test`（948/948）/ `build` / `verify:host` / `git diff --check` 全绿。
- **修改文件**：`docs/SillyTavern.md`（新增「未复刻的 ST 能力与降级对照」表 + 本轮的字段行）；`README.md`（使用者可见的行为变化三条）；`CHANGELOG.md`（本轮汇总）；`test/host/st-integration-r14.test.mjs`（新增 T23 端到端）。
- **T22 验证证据**：对照表 20 行逐项用源码位置或实现断言核对——`st-worldbook-position`（`position-downgraded`）、`st-worldbook-depth`（`depth-collapsed`）、`st-worldbook-controls`（`unsupported-controls`）、`st-worldbook-automation`（`automation-dependent`）、`st-worldbook-character-filter`（`character-filter-unsupported`）、`st-depth-prompt`（`depth-prompt-group-only`）、`st-extension-scripts`、`st-prompt-system-flag`（info）、`st-prompt-triggers` 全部与 `src/host/sillytavern.ts` 的实现一致（`note`/`noteInfo` 调用点与 `entryCodes` 逐条对照）；「等价」行只保留 `selective` 缺省语义、`use_regex` 自动识别、logic/position 默认值与 `system_prompt` 管理位四处，其余全部标「降级 / 保留事实 / 不支持 / 未复刻」，无「已降级却写成等价」。链接与路径有效。
- **T15 保持项证据**：`selective` 缺省语义、`use_regex` 自动识别、logic/position 映射、概率/分组/sticky 时间窗、原子写盘与权限校验的既有断言全部保持（946 → 948 条仅新增本轮用例，无既有断言被放宽或删除；唯一修改是 `preset-package-import.test.mjs` 的 `main` 配置期望补上 R12 新增的 `stSource` 来源事实）。
- **T23 集成证据（真实素材 17 文件，只读隔离探针，已清理）**：
  - 转换：17/17 成功、0 失败；共 806 条报告条目、698 个生成配置、74 个变量；诊断分布 `st-worldbook-role` 214、`st-worldbook-depth` 94、`st-prompt-role` 23、`st-extension-scripts` 16、`st-prompt-system-flag` 14、`st-first-mes-role` 13、`st-alternate-greetings-role` 10、`st-key-macro` **3**、`st-prompt-depth` 1；`st-worldbook-character-filter` / `st-worldbook-automation` / `st-worldbook-controls` **均为 0**（素材这些字段的非空值为 0，无新增噪音）。
  - `{{user}}` 键条目实测 **3 条**（`V0.66.png` 的 `id=25`、`id=39`，另有 1 条在其他卡片），与 R7 的 `st-key-macro` 诊断数一致；PLAN 1.2 原记录的「5 条」已在 1.2 节更正。
  - `extensions.depth_prompt`：13 张卡带该字段（与 PLAN 一致），但 **`prompt` 全为空白** → 按「非空才生成」的判定不产出配置、不登记变量（零噪音，行为正确）；`creator_notes` 同样为空。
  - 端到端：`V0.66.png` 走真实导入 → 转换 → 真实 `runPreStepBatch`。未赋值时 20 条注入且 `lore-25`/`lore-39` **都不出现**；把 `user` 赋值为 `Alice` 后 22 条注入且**两条同时出现**（同一宏的两条条目一起恢复）。注入批次经官方 `@deepseek-ai/dsh-session` 持久化后重载成功（21/23 条派生消息），角色集合只有 `user`。
  - 合成夹具端到端（`test/host/st-integration-r14.test.mjs`）：覆盖 R7–R13 的全部新形态，转换 → 真实 pre-step 协调器注入 → 官方会话重载；`lore-25`（未赋值键宏）、`lore-26`（延迟到递归）、`st-depth-prompt`（禁用）不注入，`lore-28`（creator notes 扫描）、`lore-27`（评分组单成员）、`lore-29`（角色过滤保留）、`lore-30`（自动化保留）、`AUX-USER`（system_prompt 不改层归属）与 `GREETING` 正常注入。
- **关键决策**：①对照表以「实现 + 真实诊断码」为准逐行核对，不引用素材正文；②README 只写使用者需要知道的三条行为变化（条件字段支持面、键宏恢复路径、depth_prompt 禁用配置），字段级细节留在 `docs/SillyTavern.md`；③真实素材验证走只读隔离探针（`D:\AI\workspase\_temp` 建临时 preset 根，结束即删），仓库内只保留不依赖用户素材的合成夹具测试。
- **偏差说明**：①1.2 节 K1 的「素材实测 5 条 `{{user}}` 键条目」经复核为 **3 条**，已更正。②素材 `depth_prompt` 的 `role` 是字符串（如 `system`）而非数字，实现按原值保留、不做归一（不影响禁用配置的判定）。③未做真实浏览器 smoke 与真实模型调用（PLAN 6 节要求：只用隔离环境与合成素材）。
- **遗留问题**：H1（历史会话恢复）未授权、未执行；`allowWIScan` 扩展提示词扫描与群聊注入保持「未复刻」并在表中标注；旧转换产物需重新导入才有本轮的新字段、新变量与新诊断。

## 5. H1：历史会话恢复（单独授权，默认不执行）

此操作拥有真实用户日志写入风险，不能因 R7–R14 完成或用户要求"修插件"而自动执行。先完成防复发，再由用户确认明确的会话文件清单与角色降级代价。

1. **只读盘点**：核对实际运行版本、日志格式及目标会话当前是否仍写入；使用匹配版本的正式帧解析与 Session 校验，任何解压/解析异常都记为失败。
2. **授权与静止窗口**：用户明确同意把违规事件中的 `assistant` 角色改为 `user`，确认目标与备份位置；本代理不停止、不重启服务。
3. **不可变备份**：保存原始字节与哈希，备份不得覆盖；修复前重读并比较版本，变化即退出；只修已确认 `user/message` 内的非法角色。
4. **最小变换**：不删除事件、不改变 seq/引用/正文/时间/未知字段；不把事件改成 `assistant/message`（envelope、结算字段与语义不同）。
5. **离线验证**：正式 zstd 帧解析与校验规则先在副本验证；用宿主实际加载器验证整份日志与请求派生；逐条比较允许字段外完全不变。
6. **替换与回退**：仅在文件仍静止且哈希相同、全部验证通过后原子替换；失败保留原文件与备份。
7. **结果记录**：列成功/失败/未处理文件、校验与备份位置、重入策略；记录不含会话正文或凭证，不纳入仓库与 `.ai-memory`。

未获授权、宿主版本或完整校验器未确认、日志仍变化或任一校验失败时，H1 保持未执行。

## 6. 行为验收矩阵

| 测试 | 对应任务 | 必须失败于旧实现、通过于新实现的观察结果 |
|---|---|---|
| T11 | R7 / K1 转换期 | `keys` 含 `{{user}}`：`spec.variables.user === ''`；一条 `st-key-macro` warning 且定位到条目；`params.keys` 内容不被改写 |
| T12 | R7 / K1 运行期 | 未赋值时该键不参与匹配、条目不误触发；赋实际值后含该值的消息能命中并注入；重复求值幂等 |
| T13 | R7 / 不回归 | 字面键触发结果与既有断言一致；`{{char}}` / 卡片正文变量 / 用户已填模板变量不被覆盖；warning 进入 `needsReview` 与 `meta.stWarnings` 并在预览卡可见 |
| T14 | R7 / 边界 | `secondaryKeys` 同样登记；宏名大小写不敏感；运行时宏与内置路径变量不登记；畸形引用（`{{`、`{{}}`、嵌套）不抛错；诊断上限与 `truncated` 语义不变 |
| T16 | R8 / K2·K3 | 非递归 pass 抑制、数字层数门槛、sticky 例外；开关关闭时求值路径与既有断言逐条一致；评分开启时同组选择与 ST 算法对拍一致 |
| T17 | R10 / K6 | `characterFilter` 嵌套对象完整保留；使用时有 warning；未使用时零诊断 |
| T18 | R11 / K7 | 蛇形与驼峰都能读到；非空 `automationId` 产出 warning（无键非常驻时含"不会自动注入"）；空值零噪音 |
| T19 | R12 / K7 | 素材 48 条 `system_prompt=true` 条目分类稳定且可定位；若采用层改判，前后对照有断言 |
| T20 | R13 / K8 | 13 张卡的 `depth_prompt` 都保留为 `enabled=false` 配置；不注入；报告列出；变量可供扫描使用 |
| T21 | R9 / K4·K5 | 开关开启时因 creator notes / depth prompt 命中；关闭时不命中且扫描文本与既有断言逐字一致 |
| T22 | R14 / K9 | 边界对照表每行与实现一致，无"降级写成等价"；诊断码与实际一致 |
| T15 | 全部 / 保持项 | `selective` 缺省语义、`use_regex` 自动识别、logic/position 映射、概率/分组/sticky、原子写盘与权限校验不回归 |
| T23 | 全部 / 集成 | 真实素材 17 文件与合成夹具（K4–K7 形态）端到端：转换 → 引擎 pre-step → 官方 `Session.create` 重载通过；样例 `V0.66.png#25` 形态"未赋值不触发 → 赋值后触发" |

真实 HTTP/浏览器 smoke 只用隔离 DSH_HOME、随机端口、合成素材，不调用真实模型或读取生产会话；素材回归用只读副本，不写用户 DSH_HOME。

## 7. 验证命令与证据要求

所有 shell 使用 `D:\App\PowerShell\7\pwsh.exe`。测试与脚本从隔离 cwd 执行。

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
$env:TEMP = 'D:\AI\workspase\_temp'
$env:TMP = $env:TEMP

# 只改本次文档：
git -C $Repo diff --check
git -C $Repo hash-object --no-filters `
  "$Repo\.scratch\prompt-tool-framework\archive\plan-import-lifecycle-r0-r6-f3539fa.md"
# 结果必须为 bc4c316d85ca06d3541370a7ee5e5100e4bdd884

# 代码任务（lib 是 host 测试输入，先构建）
pnpm --dir $Repo build
node --test "$Repo\test\host\st-compatibility.test.mjs" `
  "$Repo\test\engine\st-world-book.test.mjs" `
  "$Repo\test\host\st-preview-report.test.mjs"

# 每个代码任务与最终集成门禁
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
pnpm --dir $Repo verify:host
git -C $Repo diff --check
```

- 证据最少包含命令、退出码与通过/失败计数；行为证据额外记录输入消息、开关状态、赋值前后的命中结果与实际注入条目标识。
- 临时文件与隔离环境结束后清理；不启停运行中的 DSH 服务，不写用户 DSH_HOME。
- 生成分发快照（`engine/compositions/library/`、`engine/vendor/yaml/`）有变化才运行 `rebuild:composition` / `sync:yaml`；按任务范围提交，绝不手工编辑或删除。
- 新会话按本文件任务状态恢复；R0–R6 的 932/932 与 47 包只作为基线，不能复用为本轮验收结论。

## 8. 发布、回滚与停止条件

### 本次文档交付

- 本轮只新增本文件与旧计划归档；`AGENTS.md`、领域文档、生成目录与用户预设都不改。
- 仅暂存这两个文件，中文 Conventional Commit，普通推送 `origin/dev`；不切 `main`、不创建 PR、不提交本地记忆。推送失败保留提交并报告。
- 文档变更不需要重启 DSH、重建预设或重新链接 profile；D1 不代表任何代码任务开始。

### 代码交付（授权后）

- 按 Wave 顺序独立提交，反向提交回退；不 reset/clean 用户工作树。
- runtime/engine/bundle 变化按现有重建与物化通道发布；需要用户重启 DSH 时明确提示，由用户安排；不得自行刷新生产目录或重启服务。
- 旧产物不受影响：已导入预设不会自动获得新登记、新诊断与新字段，需重新导入才生效——交付说明必须写明，不自动回写用户 `preset.yml`。
- 行为变化（新增 variables 键、warning/info 诊断、字段保留与禁用配置）需明确告知；「模板变量」赋值后的生效路径依赖既有重建流程，不新增通道。
- 完成条件：R7–R14 的 T11–T23、最终门禁与合成夹具证据齐备；报告修改文件、证据、提交、分支与限制。H1 未授权必须注明"未执行"。

### 本次停止条件

完成 D1 文档交付与提交推送后停止。R7–R14 保持未开始，H1 保持待单独授权。

## 9. Wave 与任务完成状态

`[✔]` = 已完成且对应验证通过；`[ ]` = 未完成。进行中、部分完成、失败或受阻均保持 `[ ]`，原因记录在 Task Summary。
Wave 只有在全部必需子任务验收通过后才能标记 `[✔]`；文档 Wave 完成不代表代码修复完成。

- [✔] **Wave 4：文档规划**
  - [✔] D1：旧计划原文已归档（与 `f3539fa:PLAN.md` 字节一致），P1+P2+P3 方案、用户决策、任务卡与状态清单已编写并通过文档校验。
- [✔] **Wave 5：P1 触发条件**
  - [✔] R7：世界书 `keys` / `secondaryKeys` 的未解析宏登记为可赋值变量并产出可见诊断（T11–T14）。行为矩阵与门禁证据见 4.7。
- [✔] **Wave 6：P2 条件字段**
  - [✔] R8：`delayUntilRecursion` 与 `useGroupScoring` 求值支持（T16）。核实结论与行为证据见 4.8。
  - [✔] R10：`characterFilter` 按真实形态读取并显式拒绝（T17）。
  - [✔] R11：`automationId` / `outletName` 双形态读取与自动化依赖诊断（T18）。
  - [✔] R12：`prompts[].system_prompt` 按核实结论处理并保留事实（T19）。
- [✔] **Wave 7：P3 与扫描接线**
  - [✔] R13：`depth_prompt` 保留为禁用配置并登记扫描变量（T20）。核实结论与行为证据见 4.9。
  - [✔] R9：`matchCreatorNotes` / `matchCharacterDepthPrompt` 扫描接线（T21）。
- [✔] **Wave 8：边界文档与集成**
  - [✔] R14：未复刻能力与降级对照文档化（T22）。逐项核对与真实验收证据见 4.10。
- [✔] **最终集成验收**：T11–T23、完整门禁与合成夹具证据通过；真实素材 17 文件只读端到端通过，未验证项（浏览器 smoke、真实模型调用、H1）已在 4.10 明确披露。
- [ ] **独立恢复 H1**：历史日志恢复，尚未授权；不计入代码修复完成率。

当前进度：文档 1/1，代码修复 **8/8（R7–R14 全部完成）**，最终集成验收通过；`selective` 默认值与 `use_regex` 已核实无缺陷不改；H1 未授权、未执行。
