# 预设 id 安全化：与宿主内置预设重名时自动落到 `pt-` 前缀

## 授权与基线

- 用户指令（2026-09-18）「插件侧根治」：修掉「插件生成的用户预设与宿主内置（shipped）预设重名 → 被静默遮蔽 → 注入永不生效」。
  经互动提问确认三项取舍：①安全 id 用 **`pt-` 前缀**；②**不做工作台遮蔽标记**——在「拉取官方内置预设、装配成本项目预设时」就使用新名；
  ③等前一个任务（技能停用改为文件层调用策略）提交推送、工作树干净后再开工。
- 代码基线：dev@`233f6c9`（工作树干净，仅 `.scratch/` 未跟踪产物）。旧 PLAN 原文归档
  [plan-skills-file-policy-4c51176-20260918.md](.scratch/prompt-tool-framework/archive/plan-skills-file-policy-4c51176-20260918.md)
  （SHA-256 `711A3BAA1D2399AB964FEA47827FED07CA46757BF99B0A97C9B56E1A67478FCF`，与归档前 `PLAN.md` 逐字节一致）。
- 本轮范围：`src/shared/preset-ids.ts`（新）、`src/host/preset-id-safety.ts`（新）、`src/host/paths.ts`、`src/host/manifest.ts`、
  `src/host/write-preset.ts`、`src/index.ts`、`src/config.ts`、`src/runtime/settings-bridge.ts`、
  `src/client/data/prompt-tool-fields.ts`、`src/client/data/prompt-tool-view.ts`、`test/host/**`、
  `docs/architecture-params.md`、`CHANGELOG.md`。
- **不在本轮范围**：工作台遮蔽标记与任何 UI 文案（用户明确不要）；本机已存在的撞名目录（`.agent-presets/{standard,ptc,minimal}`）
  的批量迁移或删除（已由复制换名 `*-copy` 绕开，另行确认后清理）；读取其他部署根中的预设**内容**（保持 `docs/architecture-params.md:40-43` 的不变量，
  本轮只借用其 **id 名**用于避让）。

## 事实依据（读源码得到，作为不变量）

1. 宿主发现的根顺序：shipped（内置）根 prepend 在最前，用户根最后，**靠前的根赢同名 id**——
   `deepseek-harness/packages/preset/agent-presets/src/preset.ts:55-64`、安装包 `lib/types/index.js:187-189`；
   注释原话「a user directory named like a shipped preset is shadowed by it」。
2. 内置预设集合在 `profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets/{cordis,minimal,ptc,standard}`。
3. 插件**无法**从自身解析该包（`createRequire(...).resolve('@deepseek-ai/dsh-agent-presets/package.json')` → `MODULE_NOT_FOUND`）：
   插件以 link 进入 profile，Node 按真实路径向上解析，解析链不进 `profiles/node_modules`。
4. 权威判定通道是宿主服务 `agentPresets`：`list()`（`trust: 'system' | 'user'`）、`resolve(id)`、`settings()`
   （`deepseek-harness/packages/preset/agent-presets/src/index.ts:290-303`、`:322-360`、`:372-385`）；
   插件当前 `inject` 不含它（`src/index.ts` 顶部 `export const inject = ['skills', 'commands', 'llm', 'subagents']`）。
5. 模板名与输出目录名当前同值：`writePreset` 的 `templateName`（`src/host/write-preset.ts:258-274`），
   `outputId` 覆盖能力**已存在但从未被传**；模板查找 `resolveRenderablePresetDir` 是「用户目录优先 → 包内同名兜底」（`src/host/manifest.ts:267-274`）。
6. 包内模板目录只有 `preset.yml`（参数源 + 模块清单），组合本体由模块库渲染 ⇒ **改用户目录名不必动包内模板目录**，
   故 `test/` 里 72 处 `standard`（16 个文件）可保持不动。
7. 宿主 standing mount 重挂载判据是组合文件 `agent.cordis.yml` 的 mtime+size
   （`deepseek-harness/packages/preset/agent-presets/src/index.ts:776-806`）：改变激活预设 id 天然产生新装配。
8. `ensurePresetSeed`（`src/host/manifest.ts:365-381`）、`cloneBuiltinPreset`（`:385-413`）都以**模板 id** 作目标目录名，
   是产生撞名目录的两条真实路径；`writePreset` 是第三条（激活预设）。
9. 现有 `'standard'` 兜底字面量：`src/index.ts:121/281/504/713/730`、`src/host/write-preset.ts:260`、
   `src/host/manifest.ts:177`、`src/config.ts:28,79`、`src/client/data/prompt-tool-fields.ts:80`、
   `src/client/data/prompt-tool-view.ts:102`、`src/runtime/settings-bridge.ts:640,1833`。

## 目标语义

| 场景 | 行为 |
|---|---|
| 激活预设 id 与内置重名（历史 settings） | 归一化为 `pt-<id>`，写回 `prompt-tool.presetTemplate` 与宿主 `agent-presets.default`，重建 |
| 工作台「新建」选内置同名模板 | 目标目录名取安全 id（`standard` → `pt-standard`），bridge 返回实际 id，UI 显示该 id |
| 首次种子化 | 撞名模板复制成安全名，**不再产生**永不被挂载的目录 |
| `writePreset` 输出目录撞名 | fail loud（明确文案），不静默写入无效目录 |
| 用户自建的非撞名预设（`creative`、`anchored`、`standard-copy`…） | 原样保留，不归一化、不改名 |
| 包内模板名 | 保持 `standard`/`ptc`/`minimal`（模板名≠输出名，靠 `outputId` 分离） |

## Wave 1：安全 id 判据与占用探测

<task type="auto">
  <name>T1：共享常量与判据模块</name>
  <files>src/shared/preset-ids.ts（新）、src/host/preset-id-safety.ts（新）、src/host/paths.ts</files>
  <action>`shared/preset-ids.ts` 导出 `SAFE_PRESET_PREFIX = 'pt-'` 与 `DEFAULT_PRESET_ID = 'pt-standard'`（host 与 client 共用，避免跨层依赖）。
  `host/preset-id-safety.ts` 导出纯函数 `safePresetId(id, occupied)`（占用则加前缀）、`templateNameFor(id, hasTemplate)`（包内精确命中优先，否则剥 `pt-` 前缀再查，仍无则原样）、
  `assertOutputIdSafe(outputId, occupied)`（撞名抛错，文案指向「换个 id 或在工作台新建一个预设」），以及 `detectShippedPresetIdsFromDisk(home)`：
  探测 `profiles/node_modules/@deepseek-ai/dsh-agent-presets/presets`、`profiles/*/node_modules/...`、pnpm 结构 `profiles/node_modules/.pnpm/@deepseek-ai+dsh-agent-presets@*/...`，
  只读目录名；任何异常或未命中返回空集（退回今天的行为）。</action>
  <verify>纯函数可单测；探测在临时 `DSH_HOME` 上可造出「有/无/结构异常」三种结果。</verify>
  <security>只列目录名，不读其他根的预设内容（保持 `docs/architecture-params.md:40-43` 不变量）。</security>
  <done>判据集中一处、可测、失败可降级。</done>
</task>

## Wave 2：生成路径落到安全名

<task type="auto">
  <name>T2：种子化与新建改用安全 id</name>
  <files>src/host/manifest.ts</files>
  <action>`ensurePresetSeed(root, occupied)` 与 `cloneBuiltinPreset(id, autoSuffix, presetRoot, occupied)` 增加可选占用集合参数（默认空集 = 现状）：
  目标目录名一律取 `safePresetId(模板 id, occupied)`，返回实际 id；撞名模板不再复制成被遮蔽目录。</action>
  <verify>临时预设根 + 内置集合 `{standard,ptc,minimal}` ⇒ 种子化产出 `pt-standard`/`pt-ptc`/`pt-minimal` 与安全的 `creative`/`custom`；
  新建 `standard` ⇒ 返回 `pt-standard`；传入空集时行为与今天一致。</verify>
  <security>只写预设根目录，不触碰包内模板与其他根。</security>
  <done>两条撞名来源消失。</done>
</task>

<task type="auto">
  <name>T3：writePreset 模板与输出分离 + 输出撞名校验</name>
  <files>src/host/write-preset.ts、src/index.ts（rebuildPreset 调用点）</files>
  <action>`writePreset` 增加 `occupiedPresetIds?: ReadonlySet<string>`，对最终 `outputId` 走 `assertOutputIdSafe`；
  调用方 `rebuildPreset()` 改为 `presetTemplate: templateNameFor(激活 id)` + `outputId: 激活 id`（模板名与输出名分离，模板仍指包内 `standard`）。</action>
  <verify>激活 id 为 `pt-standard` 且用户目录无该目录时，模板解析落到包内 `standard`，输出目录为 `pt-standard`；
  `outputId` 命中内置集合时抛错且不写盘。</verify>
  <security>写盘仍是「临时目录 + 原子 rename」，失败不留半成品。</security>
  <done>第三条撞名来源消失，且包内模板名不变。</done>
</task>

## Wave 3：激活预设归一化与服务桥接

<task type="auto">
  <name>T4：runtime 归一化与宿主服务同步</name>
  <files>src/index.ts、src/config.ts、src/runtime/settings-bridge.ts、src/client/data/prompt-tool-fields.ts、src/client/data/prompt-tool-view.ts</files>
  <action>runtime 持有 `occupiedPresetIds`（启动用 `detectShippedPresetIdsFromDisk` 兜底），以 `ctx.inject(['agentPresets'], …)` 拿官方服务后
  用 `settings()` 的 `trust === 'system'` 覆盖/补充并二次归一化；`normalizePresetTemplate(id)` = `safePresetId`，在首次加载、settings 变化、
  工作台切换三处生效，变化时写回 `NS.presetTemplate` + `syncHostDefault()` + `rebuildPreset()`；全部 `'standard'` 兜底字面量改为 `DEFAULT_PRESET_ID`（含 client 两处）。</action>
  <verify>有宿主服务时以服务为准；服务不可用时退回磁盘探测；两者皆空时不归一化（行为同今天）；历史 settings 为 `standard` 时归一化为 `pt-standard` 并写回。</verify>
  <security>写 settings 只走既有 `settings.mutate`（字段级 set），不动其他键；不改宿主内置预设。</security>
  <done>激活路径不再可能停在被遮蔽 id 上。</done>
</task>

## Wave 4：回归测试

<task type="auto">
  <name>T5：判据与三条生成路径的行为回归</name>
  <files>test/host/preset-id-safety.test.mjs（新）、test/host/user-presets.test.mjs、test/host/write-preset.test.mjs</files>
  <action>新增纯函数用例（安全 id、模板反查含 `pt-` 剥前缀与精确优先、磁盘探测的成功/缺失/异常三态）；
  行为用例：种子化与新建落到安全名且原目录不被改、空占用集时行为不变、`writePreset` 输出撞名抛错且不写盘、
  `pt-standard` 激活时模板解析落到包内 `standard`。</action>
  <verify>把 `safePresetId` 短路（永远返回原 id）时新增用例必红；把 `outputId` 传参去掉时模板/输出分离用例必红。</verify>
  <security>全部用临时目录与临时 `DSH_HOME`，结束清理，不依赖执行顺序。</security>
  <done>三条生成路径与判据都有可失败的确定性回归。</done>
</task>

## Wave 5：文档与交付

<task type="auto">
  <name>T6：文档同步</name>
  <files>docs/architecture-params.md、CHANGELOG.md、README.md</files>
  <action>`architecture-params.md` 第 2 节补「预设 id 安全化」：根顺序与遮蔽事实、`pt-` 前缀规则、模板名与输出名分离、
  探测降级链；CHANGELOG 记行为变化（撞名自动改名 + 输出撞名报错）；README 预设一节一句话说明。</action>
  <verify>文档描述与实现逐条对得上；路径与命令可核验。</verify>
  <security>不夸大：未做的（UI 标记、存量目录迁移）明确列为未做。</security>
  <done>文档不再与产物脱节。</done>
</task>

<task type="auto">
  <name>T7：门禁、变异与提交</name>
  <files>PLAN.md、.ai-memory/</files>
  <action>typecheck / lint / test / build / `git diff --check`；对「安全 id」与「模板/输出分离」各做一组反向变异；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志。</action>
  <verify>门禁全绿；变异精确红掉对应用例；暂存只含本轮文件。</verify>
  <security>不停止运行中的 DSH；`.ai-memory` 与 `.scratch` 不入库。</security>
  <done>本轮交付完成。</done>
</task>

## 回滚

- 代码：`git revert` 本轮提交即可（纯插件代码改动，无用户数据迁移）。
- 数据：归一化只会把**激活预设 id**改写成 `pt-<id>`；若期间已生成 `pt-*` 目录，删目录 + 把 settings 改回旧 id 即回到基线。
- 已完成的用户侧复制换名（`standard-copy` 等）不受影响、不回滚。

## Task Summary 与状态

- 当前：T1–T7 执行中（执行记录与门禁结果在本节回填）。

### 执行记录

- **T1（判据与探测）**：新增 `src/shared/preset-ids.ts`（`SAFE_PRESET_PREFIX` / `DEFAULT_PRESET_ID`，host 与 client 同源）
  与 `src/host/preset-id-safety.ts`：`safePresetId`、`templateNameFor`（包内精确命中 → 剥一次 `pt-` → 原样）、
  `assertOutputIdSafe`（撞名 fail loud 并给出安全替代）、`detectShippedPresetIdsFromDisk`（hoisted / 各 profile / pnpm
  三条候选路径，只列目录名，异常与缺失一律返回空集 = 退回不避让）。
- **T2（生成路径）**：`ensurePresetSeed(root, occupied)` 与 `cloneBuiltinPreset(id, autoSuffix, presetRoot, occupied)`
  目标目录名走 `safePresetId`（默认参数保持空集 ⇒ 旧调用语义不变）；bridge 的 `presetClone` 端点经新回调
  `getOccupiedPresetIds` 拿到占用集合，返回实际 id 供界面显示。
- **T3（写入路径）**：`writePreset` 新增 `occupiedPresetIds`，输出目录命中即 fail loud；`rebuildPreset()` 改为
  `presetTemplate: templateNameFor(激活 id)` + `outputId: 激活 id`（模板名与输出名分离）；补建循环与
  `materializeImportedPreset` 显式传 `outputId`。
- **T4（归一化）**：runtime 持有 `occupiedPresetIds`（启动磁盘探测兜底，`ctx.inject(['settings','agentPresets'])`
  就绪后用 `settings()` 的 `trust === 'system'` 覆盖并二次归一化）；`normalizePresetTemplate` 在初次加载、
  settings 变化、宿主 `agent-presets.default` 跟随三处生效，改写时写回插件 settings（一次）并重建；
  `config.ts` 两处默认值与 client 两处默认值改用 `DEFAULT_PRESET_ID`。
  经核实**保持原样**的两处 `'standard'`：`settings-bridge.ts` 的激活目录兜底（语义是包内模板名）与导出预设端点的
  缺省 id（同样是模板名），改动它们反而会让 `resolvePresetDir` 找不到模板。
- **T5（回归）**：新增 `test/host/preset-id-safety.test.mjs`（判据 3 条 + 探测 3 条）；`user-presets.test.mjs` 补 3 条
  （种子化落安全名、空占用集合保持旧语义、克隆撞名与递增）；`write-preset.test.mjs` 补 2 条（输出撞名不写盘、
  模板名与输出名分离且 `configsDir` 指向输出目录）。
- **T6（文档）**：`CHANGELOG.md` 新增本轮条目；`docs/architecture-params.md` 第 2 节新增「预设 id 安全化」小节
  （根顺序事实、判据与探测降级链、三条路径、模板/输出分离）；`README.md` 预设参数体系一节补两句。
- **T7（门禁与变异）**：见下。

### 反向变异验证（证明新用例守得住）

| 变异 | 期望失败 | 实测结果 |
|---|---|---|
| `safePresetId` 短路（永远返回原 id） | 安全 id 相关用例 | **恰好 4 条红**（判据 2 + user-presets 2），其余 54 条绿 |
| `writePreset` 忽略 `options.outputId`（输出名 = 模板名） | 模板/输出分离用例 | **恰好 3 条红**（新增 2 条 + 既有 `outputId` 语义用例），其余 55 条绿 |

两组变异均已回退；回退后全量 1055/1055 通过。

### 门禁结果

- `typecheck` ✓、`lint` 0 warning 0 error ✓、`build` ✓、`test` **1055/1055** ✓、`git diff --check` ✓（仅一条 CRLF 提示，非错误）。
- 未做（明确不在本轮范围）：工作台遮蔽标记；存量撞名目录（`standard`/`ptc`/`minimal`）的迁移或清理。

[✔] Wave 1 / T1：共享常量与判据模块
[✔] Wave 2 / T2：种子化与新建改用安全 id
[✔] Wave 2 / T3：writePreset 模板与输出分离 + 输出撞名校验
[✔] Wave 3 / T4：runtime 归一化与宿主服务同步
[✔] Wave 4 / T5：判据与三条生成路径的行为回归
[✔] Wave 5 / T6：文档同步
[✔] Wave 5 / T7：门禁、变异与提交
