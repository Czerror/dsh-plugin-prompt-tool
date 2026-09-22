# B0 镜像守卫先行与文档修正 PLAN

总纲：`2026-09-22-plan-engine-convergence-master-84785df.md`。本支是全部支线的前置：把「必须手工同步」变成「漂移即红」，并修掉已发现的漂移与错误文档。

## 需求与授权

- 日期：2026-09-22；基线：`dev / 84785df`。
- 授权来源：总纲「按 8 支拆」拍板；用户对变量的判断经查证部分不成立后拍板「本轮只修文档」。
- 本支性质：**只加测试 + 改文档 + 修三处已漂移**，不改任何引擎行为。

## 审查结论

三处**已经发生**的漂移（不是理论风险）：

1. `test/host/engine-params-bridge.test.mjs:260` 的手抄镜像 `'tool-filter': new Set(['allow','deny','enabled'])` 缺 `includeSubagents`——引擎 `engine/tool-filter.mjs:34` 是 4 键。
2. `src/shared/bridge-contract.ts:280` 的 `LayerContract.content` 联合多出 `'observe'`——`engine/schema.mjs:201-217` 的 `LAYER_EDITING` 从不产生该值（实际取值：`text`×5 / `request` / `stream` / `tool-result` / `subagent-result`）。
3. `docs/engine-reuse.md:23` 称 `library`「原样切出 22 个模块」，实际 `git ls-files engine/compositions/library` = 24，与 `scripts/rebuild-composition.mjs:137-164` 的 `OFFICIAL_MODULES` 24 条一致。

四类**无人守卫**的镜像（全仓无测试比对）：

- `src/host/write-preset.ts:201-259` 的 `runtimeOf` 逐键清单（30 键逐键类型守卫 + `:209` 全键展开后又逐键再写一遍）。
- `src/index.ts:104-144` 的逐键装配（`:113` 全键循环后又 `:114-143` 逐键再赋一次）。
- `src/config.ts:53-98` 的首层必填清单。
- 组合源 yml 行默认值 vs `ENGINE_PARAM_DEFINITIONS[].defaultValue` 的一致性（`docs/architecture-params.md` 声明前者是「可配置默认值的唯一归属地」，后者仅作编辑草稿，但无人守卫）。

文档错误与过强表述（用户拍板只修文档）：

| 位置 | 问题 |
|---|---|
| `docs/architecture-params.md:130` | 称空值占位键「供内部世界书工具（`world_book_upsert`）动态登记与调整」；该工具（`src/runtime/world-book-tools.ts:134-151`）只写世界书条目与 memory，不写变量 |
| `docs/SillyTavern.md:95` | 把「裸 `{{key}}` 查变量」列在 ST 宏表内；ST 的裸 `{{key}}` 从不查变量（`MacroEngine.js:216-217` 未注册即原样保留），这是本项目扩展 |
| `docs/SillyTavern.md:89-99` | 称「兼容 `::default`」；ST 不支持（`variable-macros.js:99-116` 只接受一个参数），是本项目扩展 |
| `docs/SillyTavern.md:121-122` | 称键「按同一变量表求值（对齐 `substituteParams`）」过强：实际不含会话变量（`engine/st-world-book.mjs:114` 只传 `config.variables`），且键里的 `{{getvar::x}}` 一族不求值 |
| `docs/SillyTavern.md` 未复刻表（`:167-189`） | 六项无声明缺口未列入：`{{.x}}`/`{{$x}}` 简写与运算符、`{{if}}`/scoped/flag、`hasvar`/`deletevar`/`setvarkey`/`getvarkey` 及 global 别名共 8 个宏、scoped `{{setvar}}…{{/setvar}}`、键插值不含会话变量、原生 world-book 的 `keys` 不插值 |
| `CHANGELOG.md:1019-1020` | 与 `architecture-params.md:130` 同一错误表述；**不改历史条目**（CHANGELOG 记录当时版本），只在现行文档修正 |

## 影响面、依赖与护栏

- 涉及文件：四个测试文件（新增守卫）、三处漂移的修复点、五处文档。
- 无依赖；是 B1–B6 的前置。
- 硬约束：守卫必须**先红后绿**（能抓到三处既有漂移才算有效）；不改任何引擎行为；文档修正逐句对拍代码事实，不引入新承诺。

## Wave 1：守卫

```xml
<task type="auto">
  <name>T1：补四类镜像守卫（先红）</name>
  <files>test/host/engine-params-bridge.test.mjs；test/shared/engine-param-schema.test.mjs；test/host/write-preset.test.mjs（或新增 test/shared/mirror-guards.test.mjs）</files>
  <action>分两组加断言。**第一组：三处已知漂移各自的针对性守卫**（R11 要求——它们与第二组的检查对象不同，修漂移不会让第二组转绿，必须分开）：(a) 测试里的手抄 ALLOWED 镜像与 `engine/*.mjs` 的 `ALLOWED_KEYS` **双向**校验（对治 `test/host/engine-params-bridge.test.mjs:260` 缺 `includeSubagents` 那类）；(b) bridge 契约的 `LayerContract.content` 联合与实际 `LAYER_EDITING` 产生的取值**闭合成同一值域**（对治 `src/shared/bridge-contract.ts:280` 多出的 `'observe'`）；(c) `docs/engine-reuse.md` 的 library 模块计数与 `git ls-files engine/compositions/library` / `OFFICIAL_MODULES` 实际条数一致（对治「文档说 22、实际 24」）。**第二组：四类新增镜像守卫**——(1) `src/host/write-preset.ts` 的 `runtimeOf` 逐键清单与 `ENGINE_PARAM_KEYS` 双向相等（键集合与类型守卫分支都覆盖）；(2) `src/index.ts` 的逐键装配覆盖 `ENGINE_PARAM_KEYS`；(3) `src/config.ts` 首层必填清单与参数目录一致；(4) `engine/compositions/source/local/*.yml` 出现的键必须在目录中登记，且目录中声明为 module 绑定的键必须能在某个 yml 或参数桥找到落点（二者本不必须同值，故断言的是「有登记、有落点」而非值相等）。</action>
  <verify>**两组分别证明有效，不得混为一谈**（R11）：第一组三条必须**先红后绿**——在当前代码下各自命中对应的那处已知漂移，修完 T2 后转绿；第二组四条用**定向变异**验证——逐条人为删一个键（或改一处落点），断言该守卫确实报红，再复原。修好第一组不等于第二组有效。</verify>
  <security>纯测试改动，不触碰写盘、权限与网络；守卫只读源码与目录，不修改被检查对象。</security>
  <done>四类守卫存在，且对当前代码处于红/绿状态明确（能抓漂移的必须先红）。</done>
</task>
```

```xml
<task type="auto">
  <name>T2：修三处已漂移</name>
  <files>test/host/engine-params-bridge.test.mjs；src/shared/bridge-contract.ts；docs/engine-reuse.md</files>
  <action>① src/host/engine-params-bridge.test.mjs:260 的 tool-filter 镜像补 includeSubagents，与 engine/tool-filter.mjs:34 一致；② src/shared/bridge-contract.ts:280 的 content 联合删除 'observe'（引擎不产生该值）；③ docs/engine-reuse.md:23 的「22 个模块」改为 24，并核对同段其它数字。</action>
  <verify>T1 的守卫全部转绿；既有 test/shared/bridge-contract.test.mjs 与 test/host/composition-library.test.mjs 保持通过。</verify>
  <security>镜像修正只补事实，不放宽容差；不得为了让守卫变绿而放宽断言。</security>
  <done>三处漂移修复，守卫全绿。</done>
</task>
```

## Wave 2：文档修正

```xml
<task type="auto">
  <name>T3：修正错误与过强的文档表述</name>
  <files>docs/architecture-params.md；docs/SillyTavern.md</files>
  <action>按「审查结论」表逐条改：architecture-params.md:130 改为「空值占位键供世界书条目正文以 {{key}} 引用；登记发生在 ST 导入期与工作台编辑」；SillyTavern.md:95 把裸 {{key}} 行标注为本项目扩展；:89-99 把 ::default 标注为扩展；:121-122 补「键插值不含会话变量、getvar 族不求值」；未复刻表补六项无声明缺口（各写清 ST 行为、本项目处理、是否降级）。CHANGELOG 历史条目不修改。</action>
  <verify>每处改动与代码事实逐句对拍（给出对应 engine/src 行号）；git diff --check 退出 0；核对文档内相对链接与章节锚点有效。</verify>
  <security>纯文档；不写入凭据、本地绝对路径或用户私有数据；不新增未实现的能力承诺。</security>
  <done>文档与代码事实一致，不再承诺不存在的能力。</done>
</task>
```

## Wave 3：工具契约守卫与约束上提

```xml
<task type="auto">
  <name>T4：三个模型工具的返回分支 schema 全覆盖回归，并上提宿主约束到文档</name>
  <files>test/host/tool-contract.test.mjs（或并入既有测试）；docs/architecture-params.md（或对应权威文档）；src/runtime/{character-tools,world-book-tools,session-var-tools}.ts（只读核对）</files>
  <action>(1) 依官方插件教程的实证（`tool-plugin-tutorial-draft.md:303`）：「`execute()` 返回不符合 `output.schema` 的值时，宿主把调用**归一化为错误**，而不是把无效数据交给模型」——为三个模型工具的**每一条 return 分支**（成功、错误、边界分支）建立 schema 校验回归，确保没有分支会被宿主归一化。(2) 把已写在代码注释里的宿主约束**上提**到项目文档：一是 `tools:sdk` 段的 description 受 `{{var}}` 变量校验、文本中不得出现双花括号字面量（现仅记录在 `src/runtime/session-var-tools.ts:21-23`）；二是 `exec` 上可用的字段（`signal`，以及本项目实际依赖的 `agent?.session`）。</action>
  <verify>回归对三个工具的每条分支逐一断言 schema 通过；故意构造一条越界返回作为负例，确认该回归能抓到它。文档上提后，与代码注释、实际行为三处一致。</verify>
  <security>只加测试与文档，**不改工具实现**；负例不得写入真实会话或用户预设。</security>
  <done>三工具返回分支的 schema 覆盖有回归；两条宿主约束从代码注释上提到项目文档。</done>
</task>
```

## 回滚与检查点

`git revert` 本支提交即可；T1 新增的守卫若在后续支线中暴露问题，允许单独回退 T1 而不动 T2/T3，但需记录原因。

## 状态

- [x] T1 四类镜像守卫。
- [x] T2 修三处已漂移。
- [x] T3 文档修正。
- [x] T4 三工具返回分支 schema 回归 + 两条宿主约束上提文档。
- [x] 附：T4 回归实测出的**两个真实缺陷已修**（经用户单独授权，超出本 PLAN 原「不改工具实现」的边界，单独记入验收记录）。

## 验收记录

执行日期 2026-09-22；分支 `dev`，起点 HEAD `65e236d`。全部改动**未提交**（用户要求写完不自行提交，等裁决）。

**T1/T2 守卫先红后绿**：新增 `test/shared/mirror-guards.test.mjs`（第一组三条）与 `test/host/engine-params-bridge.test.mjs` 扩展（第二组）。
- 先红证据（三条各自命中对应漂移）：①`tool-filter: 手抄镜像缺键`（缺 `includeSubagents`）②`content 联合含引擎从不产生的取值`（`'observe'`）③`22 !== 24`。
- T2 修完转绿；同文件另三条新守卫（`runtimeOf` 全键透传、`reloadPresetParams` 全键回读、yml 键归属）均为绿。
- **执行中修掉一条既有空转守卫**：原「非 writer 键必须有参数桥消费」因 `WRITER_PARAM_KEYS === ENGINE_PARAM_KEYS` 而 `continue` 覆盖全部键、循环体从不执行；改为按实际样本集（`BRIDGE_SAMPLES`）校验。
- **发现待 B2 处理项**：`prompt-config-engine` / `tool-config-engine` / `subagent-tool-policy` 三个模块行确实没有 `ALLOWED_KEYS`（即 B2 T4 的待办），yml 键归属守卫按 `pendingWhitelist` 显式登记并透明报告，B2 补完白名单后自然收紧。

**T2 三处漂移**：手抄镜像补 `includeSubagents`；`src/shared/bridge-contract.ts` 的 `content` 联合删 `'observe'`（删前查证无代码依赖：`test/engine/prompt-config-engine.test.mjs:30` 断言的是 `params.action.values`，与 `content` 无关；`typecheck` 通过作为硬证据）；`docs/engine-reuse.md` 的 library 计数 22 → 24。

**T3 文档修正**：`docs/architecture-params.md:130` 改正「供 `world_book_upsert` 动态登记与调整」的错误归属（反证：`src/runtime/world-book-tools.ts:141-158` 的 execute 只做 build → upsert → writeNote → rebuild，不碰变量表）；`docs/SillyTavern.md` 四处过强表述按 ST 源码逐条对拍并标注「本项目扩展」，未复刻表补六项缺口并加基线说明。复核抽查两处 ST 证据（`macros/engine/MacroEngine.js:215-218` 未注册宏 `return raw`、不查变量；`macros/definitions/variable-macros.js:99-116` 的 `getvar` 只声明 1 个 `unnamedArgs`）**均属实**。

**T4 工具契约回归**：新增 `test/host/tool-contract.test.mjs`，经真实 `Context` + `ToolRuntime` 全流水线覆盖三工具 16 条 return 分支，含一条故意构造的越界返回负例（绿，证明判定口径有牙齿）。**该回归抓到两条真实缺陷**，已在用户单独授权下修复：
1. `character_list` 库非空必失败 —— items 契约未声明 `hasAvatar`（`src/host/characters.ts:495` 无条件返回该字段），宿主归一化为错误（原始报错 `"value.characters[0].hasAvatar" is not a declared property (additionalProperties: false)`）；修法：`src/runtime/character-tools.ts` 的 items.properties 补 `hasAvatar: { type: 'boolean', required: true }`。
2. `world_book_list` 含任一无 keys 条目即整表失败 —— 原实现显式产出 `keys: undefined`，宿主在校验 `output.schema` 前先做 lossless JSON 快照（原始报错 `value is not lossless JSON`）；修法：改为条件展开省略该属性（已查证 schema 里 `keys` 并非 required）。
- 红绿证据：修 src 前 `25 pass / 2 fail / exit 1` → 修后 `27 pass / 0 fail / exit 0`。

**T4 文档上提（两条约束）**：
- `exec` 字段清单：按官方 `@deepseek-ai/dsh-tools` 的 `ToolRunContext`（`lib/types/index.d.ts:198-294`）与 `@deepseek-ai/dsh-agent` 的 `Agent.session`（`lib/types/runtime-types.d.ts:139-143`）写入 `docs/engine-reuse.md` 新增节。
- `tools:sdk` 段的 `{{var}}` 校验：**查证后与代码注释不符** —— `sdkSection()` 对该段显式设 `interpolate: false`（`@deepseek-ai/dsh-tools` 的 `lib/index.js:2743-2758`），装配端对 `interpolate === false` 的 section 保留字面文本（`@deepseek-ai/dsh-system-prompt` 的 `lib/index.js:105-116`），且 `dsh-tools` 只注册 `tools:sdk` 与 `tools:ptc-only` 两个工具类 section、都不从 `description` 构造文本 → 当前实现**不会**触发该校验。文档按实测如实记录冲突与两种待定解释，**未照搬注释**；`src/runtime/session-var-tools.ts:21-23` 的注释是否修订待用户裁决。

**门禁（全部通过）**：`typecheck` exit 0；`lint` 0 warnings / 0 errors（281 files）；`test` **1319 tests / 1319 pass / 0 fail** exit 0；`build` 由 `scripts/run-tests.mjs` 内含执行且多次成功；`git diff --check` exit 0。

**未验证项**：①`session_var` 的未知 action 分支在实现内不可达（`defineTool` 参数枚举先拒），按「字面返回值形状合契约 + 参数层先拒」两条断言覆盖，未执行到该行本身。②未做逐键定向变异证明（src 属只读授权对象，改用同一 schema 的 mutant 工具做等效证明）。③T3 的 ST 基线是工作副本 `1.19.0-2-g7c3994196`（staging 分支，与 PLAN 记录的 commit `7c399419` 前缀一致），「新宏引擎默认开启」取自该副本 `power-user.js:302`，未对照 release tag；ST 行为均为源码静态核对，未实机渲染验证。

**交付凭据**：提交 `5e03ac8`（11 files changed, 781 insertions(+), 35 deletions(-)），已推送 `origin/dev`（`65e236d..5e03ac8`）；推送后本地 `HEAD` 与 `origin/dev` 同为 `5e03ac8`。暂存范围只含本支文件，未包含 8 份未开工的支线 PLAN 与用户既有未跟踪 `skills/`。

## 实施取舍与已知边界

- yml 行默认值与 `defaultValue` **本就不必然相等**（前者是运行时真源、后者是编辑草稿），因此 T1 第 (4) 类断言的是「键有登记、有落点」，不是「值相等」。
- 未复刻的六项缺口只补文档、**不在本轮补实现**；补进去是为了让「未复刻」可查，而不是承诺补齐。

## 测试现场与清理限制

本轮未创建临时目录或文件；测试在本支执行时使用独立 `DSH_HOME` 与临时目录并清理。
