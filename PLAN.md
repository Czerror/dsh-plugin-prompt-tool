# 角色卡模块按需装配与回退（Ponytail 卡落地）

## 授权与基线

- 用户指令（2026-09-18）：把 ponytail 的功能做成「类角色卡」注入任意预设。经互动提问确认：
  ① 路径 A——手写 `.characters/<id>/converted.yml`（PresetSpec 片段）当卡，工作台「角色管理」列出并应用到任意预设；
  ② 6 个技能走全局技能根 `$DSH_HOME/skills`（跨预设可用），不做「卡携带技能」的代码扩展；
  ③ 模块改为**按卡的实际需要追加**（推翻现在固定的四件套）；
  ④ **移除时必须正确删除添加的引擎或模块**。
- 代码基线：dev@fb18c9a（工作树干净）；[旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-review-round4-fb18c9a-20260918.md)（SHA-256 与基线 `PLAN.md` 逐字节一致）。
- 本轮范围：`src/host/characters.ts`（apply / remove 的模块语义）、`test/host/characters.test.mjs`（更新既有断言 + 新增用例）、`docs/SillyTavern.md`、`CHANGELOG.md`；用户数据侧写 `ponytail` 卡与 6 个技能。
- **不在本轮范围**：ST 导入路径（`src/host/sillytavern.ts`）的模块清单、bridge 端点契约、引擎（`engine/`）、工作台 UI。

## 事实依据（读源码得到，作为不变量）

1. ST 转换生成的 `converted.yml` **本身就带 `modules` 声明**（`sillytavern.ts:728-731` 写入 `prompt-config-engine`、`character-tools`、`world-book-tools?`、`session-var-tools`、`tool-config-engine`、`tool-filter`），而 `applyCharacterToPreset` 从不读它，只按硬编码的四件套追加（`characters.ts:478-484`）。
2. `session-vars` 插值不依赖 `session-var-tools`：执行器每次都取会话变量快照，表为空时按声明值渲染（`engine/executor.mjs:184-192`、`engine/session-vars.mjs:26-29`）。该模块只注册 `session_var` 工具。
3. `tool-filter` 两个名单都空 = 不过滤、零开销（`engine/tool-filter.mjs:21`）；`toolFilterAllow/Deny` 是引擎参数（`shared/engine-params.ts:52-54`）。
4. `prompt-config-engine` 缺失 = `promptConfigs` 静默失效（无人检查，属既有缺口）。
5. 官方手写预设（无 `modules` 数组）在 `appendPresetModules` 里 fail loud（`manifest.ts:608`），维持现状。

## 目标语义

| 项 | 语义 |
|---|---|
| 卡声明 `modules` | **优先**：按声明追加（ST 卡行为不变） |
| 卡未声明 `modules` | 只追加必需项 |
| 必需项 | `prompt-config-engine` 始终；卡含 `world-book` 策略配置时加 `world-book-tools` |
| 追加记录 | `meta.characterModules[<cardId>]` 记下「本次由该卡新增的模块」（相对追加前差集），重复 apply 与已有记录求并集 |
| 移除回退 | 只回退记录里的模块；回退前做「仍需性」检查：其他卡记录仍引用、或预设内容仍需要（见下）→ 保留 |
| 仍需性判据 | `prompt-config-engine`：移除后仍有 `promptConfigs`；`world-book-tools`：仍有 `world-book` 策略配置；`session-var-tools`：仍有 `params.stMacros === true` 的配置；`tool-config-engine`：预设顶层仍有 `customTools`；`tool-filter`：`params.toolFilterAllow/Deny` 非空；`character-tools`：仍有 `chara-*` 前缀配置或仍导入着其他卡 |
| 无记录的老卡 | 移除时不回退模块（无从判断归属），保持既有行为，不误删 |

## Wave 1：模块装配与回退

<task type="auto">
  <name>T1：判据纯函数与卡声明解析</name>
  <files>src/host/characters.ts</files>
  <action>新增导出纯函数：`requiredCharacterModules(configs)`（必需项，含 world-book 判据）、`characterModuleStillNeeded(module, ctx)`（仍需性表）、`recordedCharacterModules(meta)`（读取记录，容错非法形状）；卡声明 `modules` 走白名单过滤（非字符串/空串丢弃），最终追加集 = 声明 ∪ 必需项。</action>
  <verify>纯函数可被直接单测；非法声明不抛错但被丢弃。</verify>
  <security>模块名仍由 `appendPresetModules` 校验，非法名 fail loud。</security>
  <done>判据集中一处，可测、无隐式状态。</done>
</task>

<task type="auto">
  <name>T2：apply 按需追加并记录来源</name>
  <files>src/host/characters.ts</files>
  <action>`applyCharacterToPreset` 改为：读 `spec.modules`（无则空）→ 并入必需项 → `appendPresetModules` 追加 → 把「追加前没有、追加后有的模块」并入 `meta.characterModules[cardId]`。幂等：重复 apply 不重复记录、不重复追加。</action>
  <verify>纯文本手写卡只得到 `prompt-config-engine`；带世界书的卡得到 `world-book-tools`；ST 卡仍得到它自己声明的六个。</verify>
  <security>只写 `$DSH_HOME` 下当前预设目录与角色卡库，沿用 `withPresetDoc` 原子写。</security>
  <done>追加行为由卡与内容决定，来源可追溯。</done>
</task>

<task type="auto">
  <name>T3：remove 正确回退模块</name>
  <files>src/host/characters.ts</files>
  <action>`removeCharacterFromPreset` 在删除 `chara-<id>-` 配置与 params 键之后，按记录回退模块：先算移除后的 `promptConfigs` 与 `params`，再逐个判断「其他卡仍引用」或 `characterModuleStillNeeded` → 保留，否则从 `modules` 删除；最后清理 `meta.characterModules[cardId]`（该键为空时删键）。无记录时不回退。</action>
  <verify>apply → remove 后模块回退到应用前状态；两张卡共用同一模块时移除一张不误删；预设自带模块永不被删。</verify>
  <security>只删本卡记录过的模块，不触碰其他模块。</security>
  <done>apply 与 remove 对称，符合用户「移除时要正确删除添加的引擎或模块」的要求。</done>
</task>

## Wave 2：回归测试

<task type="auto">
  <name>T4：模块装配与回退的行为回归</name>
  <files>test/host/characters.test.mjs</files>
  <action>更新既有断言（原「固定六件套」改为按声明的语义）；新增用例：①手写纯文本卡（无 `modules`）→ 只有 `prompt-config-engine`；②手写卡声明 `modules: []` → 同上；③手写卡含 world-book 配置 → 自动补 `world-book-tools`；④手写卡声明可选模块 → 按声明追加；⑤缺 `prompt-config-engine` 的预设被补齐；⑥remove 回退全部由卡引入的模块并清 `meta.characterModules`；⑦两张卡共用模块时只移除一张、模块保留；⑧重复 apply / 重复 remove 幂等；⑨老卡（无记录）remove 不回退模块。</action>
  <verify>把「按需」退回「固定四件套」时用例③⑨必红；把回退整段删掉时用例⑥必红。</verify>
  <security>测试只用临时目录与临时 `DSH_HOME`，结束后清理。</security>
  <done>装配与回退都有可失败的确定性回归。</done>
</task>

## Wave 3：Ponytail 卡与技能落地（用户数据）

<task type="auto">
  <name>T5：写 ponytail 卡</name>
  <files>$DSH_HOME/.agent-presets/.characters/ponytail/converted.yml（用户数据，不入库）</files>
  <action>手写 PresetSpec 片段：`modules: [prompt-config-engine]`；三条 `system-section` 配置同 `group: ponytail-level` + `exclusive: true`（lite / full / ultra，默认只启用 full），`audience` 缺省 = 主会话 + 子代理；正文用简体中文（保留 `ponytail:` 注释标记与必要术语的中文解释）；`params` 与 `variables` 留空以免污染目标预设。</action>
  <verify>经工作台「角色管理」可列出（`converted.yml` 可解析、`name` 非空）；应用后 `modules` 只多 `prompt-config-engine`；三条配置只生效一条。</verify>
  <security>只写角色卡库目录，不改任何预设文件。</security>
  <done>卡可被工作台列出并应用到任意预设。</done>
</task>

<task type="auto">
  <name>T6：导入 6 个技能到全局技能根</name>
  <files>$DSH_HOME/skills/{ponytail,ponytail-review,ponytail-audit,ponytail-debt,ponytail-gain,ponytail-help}/SKILL.md（用户数据，不入库）</files>
  <action>逐字移植 ponytail 仓库的 6 个技能；`description` 追加中文触发词（过度设计 / 最简方案 / 能不写就不写等）以便中文提问命中；不引入任何脚本依赖（这些技能只用 grep / 读文件）。</action>
  <verify>技能名均为 kebab-case；工作台技能页可见；`standard` / `ptc` / `creative` 预设（装配 `tool-skill`）模型可见。</verify>
  <security>不改动技能根里既有的 87 个技能；不覆盖同名目录。</security>
  <done>6 个技能跨预设可用。</done>
</task>

## Wave 4：文档与交付

<task type="auto">
  <name>T7：文档同步</name>
  <files>docs/SillyTavern.md、CHANGELOG.md</files>
  <action>角色卡一节写明新的模块语义（声明优先、必需项兜底、记录来源、回退规则与仍需性判据），并注明 ST 导入路径本轮不变、两条路径的差异；CHANGELOG 记录行为变化与「移除现在会回退模块」。</action>
  <verify>文档描述与实现逐条对得上；路径与命令可核验。</verify>
  <security>不夸大行为，未做的（批量应用、卡携带技能、UI 命令切换）明确列为未做。</security>
  <done>文档不再与产物脱节。</done>
</task>

<task type="auto">
  <name>T8：门禁、变异验证与提交</name>
  <files>PLAN.md、.ai-memory/</files>
  <action>typecheck / lint / test / build / git diff --check；对「按需装配」与「回退」各做一组反向变异，证明新用例守得住；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志。</action>
  <verify>门禁全绿；变异各自精确红掉对应用例；暂存只含本轮文件。</verify>
  <security>不停止运行中的 DSH；`.ai-memory` 不入库。</security>
  <done>本轮交付完成。</done>
</task>

## 回滚

- 代码：`git revert` 本轮提交回到 `fb18c9a`；被改动的只有 `characters.ts` 的两个函数与测试。
- 数据：用户侧的卡与技能是新增文件，删除目录即可回退；若卡已应用到某预设，先在工作台「移除」再删库（移除会回退模块）。
- 已应用过卡的历史预设不受影响：模块已在磁盘上，回退只作用于「之后」的应用与移除。

## Task Summary 与状态

- 当前：T1–T8 全部完成（T8 的 `test` 门禁含 1 条**既有失败**，见「门禁结果」）。

### 执行记录

- **T1（判据纯函数）**：`src/host/characters.ts` 新增 `CHARACTER_MODULES_KEY`、`recordedCharacterModules`（非法形状容错）、
  `declaredCharacterModules`（卡声明过滤去重）、`requiredCharacterModules`（`prompt-config-engine` 始终 + 有 world-book
  配置时 `world-book-tools`）、`CharacterModuleContext` / `characterModuleStillNeeded`（消费者判据，未知模块保守保留）、
  `modulesClaimedByOtherCards`（其他已导入卡的记录 ∪ 声明的并集）；`src/index.ts` 导出这些符号供测试消费。
- **T2（apply 按需装配 + 记录）**：追加集 = 卡声明 ∪ 必需项；把「追加前没有、追加后有」的差集并与
  `meta.characterModules[cardId]` 合并写回。ST 卡因自带六件套声明，装配结果与改造前逐项一致（既有断言保留并补记录断言）。
- **T3（remove 回退）**：按记录回退模块，保留条件 = 其他卡仍引用（记录或 `converted.yml` 声明）或消费者仍在
  （`promptConfigs` / world-book 配置 / `params.stMacros` / `customTools` / 非空工具名单）；随后清理
  `meta.characterModules[cardId]`，该键为空时删父键；老卡无记录则不回退。
- **T4（回归）**：`test/host/characters.test.mjs` 从 7 条扩到 16 条，覆盖纯文本卡零追加、声明优先、世界书自动补、
  回退与记录清理、两张卡共用模块不夺走、预设自带模块不动、`tool-filter` 消费者保护、重复应用与移除幂等、判据纯函数。
- **T5（ponytail 卡）**：`$DSH_HOME/.agent-presets/.characters/ponytail/converted.yml`（用户数据，不入库）：
  `modules: [prompt-config-engine]` + 四条 `system-section` 配置——`ponytail-rules`（常驻公共规则，order 190）
  与三条 `group: ponytail-level` / `exclusive: true` 的档位（full 默认启用，lite / ultra 默认禁用，order 200/201/202）。
  只读校验：`listCharacterCards` 能列出该卡（`hasAvatar: false`、`imported: false`）。
- **T6（技能）**：6 个技能写入 `$DSH_HOME/skills/{ponytail,ponytail-review,ponytail-audit,ponytail-debt,ponytail-gain,ponytail-help}/SKILL.md`
  （用户数据，不入库）：正文忠实移植，`description` 补中文触发词；主技能与 `ponytail-help` 增加 DSH 适配段
  （档位由预设提示词配置的互斥组控制，本项目没有 `/命令` 通道）。运行时技能目录已识别全部 6 个。
- **T7（文档）**：`docs/SillyTavern.md` 角色卡一节新增「应用与移除的模块语义（2026-09-18）」；`CHANGELOG.md` 新增同题一节。
- **T8（门禁与变异）**：见下。

### 反向变异验证（证明新用例守得住）

| 变异 | 期望失败 | 实测结果 |
|---|---|---|
| apply 退回固定四件套（按需逻辑失效） | 装配与回退相关用例 | **恰好 8 条红**，其余 8 条绿 |
| remove 的回退整段短路 | 回退用例 | **恰好 1 条红**，其余 15 条绿 |
| `characterModuleStillNeeded` 的 `tool-filter` 分支改成「两侧名单都非空才算需要」 | 消费者保护用例 + 判据纯函数 | **恰好 2 条红**，其余 14 条绿 |

三组变异均已回退，回退后角色卡测试 16/16 通过。另有第四组在开发中真实发生：`modulesClaimedByOtherCards`
未读其他卡的 `converted.yml` 声明时，「另一张已导入卡也声明同一模块时不夺走」当场变红——该用例正是为这个缺口写的。

### 门禁结果

- `typecheck` ✓ / `lint` 0 warning 0 error ✓ / `build` ✓ / `git diff --check` ✓。
- `test`：1036/1037。唯一失败是 **`test/host/skills-scan.test.mjs:247`「等长改写并还原 mtime 也必须让指纹变化」**，
  与本轮改动无关，**用户决定本轮不修、如实记录**。证据：独立探针显示本机 Windows 上 `writeFileSync` 写入数据后
  `ctimeMs` 不变（`utimesSync` 才更新 ctime），该断言三次重跑稳定失败；本轮改动文件不含 `skills-scan`。
  实际影响有限：引用目录的内容变化由插件 watcher 事件兜底，指纹只在 watcher 覆盖不到时才是唯一判据。

### 未做（明确不在本轮范围）

- 卡携带技能：角色卡应用仍不复制 `skills/`，技能走全局技能根（跨预设可用）。
- 批量应用到多个预设、`/命令` 式档位切换：切换仍在工作台的提示词配置页完成。
- ST 导入路径的模块清单按需化：其宏与状态变量确实需要 `session-var-tools`，本轮保持原样。

[✔] Wave 1 / T1：判据纯函数与卡声明解析
[✔] Wave 1 / T2：apply 按需追加并记录来源
[✔] Wave 1 / T3：remove 正确回退模块
[✔] Wave 2 / T4：模块装配与回退的行为回归
[✔] Wave 3 / T5：写 ponytail 卡
[✔] Wave 3 / T6：导入 6 个技能到全局技能根
[✔] Wave 4 / T7：文档同步
[✔] Wave 4 / T8：门禁、变异验证与提交
