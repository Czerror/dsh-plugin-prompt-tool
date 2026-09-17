# 第四轮审查修复：回归保护、指纹判据与提示语境

## 授权与基线

- 用户指令（2026-09-18）：对第四轮 OCR 复审报告选择「Medium + Low 全清」。
- 审查基线：`47b4b0b..9a5cccf`（三路委派；C 路在逐字节副本里做了 13 组变异 + AST 级检查）。
- 代码基线：dev@9a5cccf；[旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-review-round4-9a5cccf-20260918.md)（与基线 `PLAN.md` 逐字节一致）。
- 审查结论：**无 critical**；1 条被报为 high 的判定为**误报**（见下）；8 条 Medium、14 条 Low。
- 已确认成立的验证：本轮修的回归经 B 路实机探针与我的端到端探针**双重确认生效**；4 条新断言经变异全部可红；10 个测试文件无「脱离测试框架的断言」（AST 级核对）。

## 误报判定（不返工）

「候选指纹只覆盖引用目录，`~/.agents/skills` / 内置根 / 项目根的新技能也进不了模型侧」不成立：官方 `dsh-skill-filesystem` 自身的 roots 就包含这些路径（`packages/skill/skill-filesystem/src/index.ts:251/258/262`），`retainRoot` 为每个 root 建 watcher，命中即 `this.invalidate()`（:340/:590）。只有「用户引用的技能文件夹」不在官方 root 列表里，所以只有它需要我们的指纹——当前设计正确，不扩展。

## 问题清单

| 组 | 位置 | 结论 |
|---|---|---|
| M1 | `test/host/skills-refresh.test.mjs` | `candidatesFingerprint` 由测试常量注入，**`index.ts` 的真实接线零断言**（错接成 `() => skillsStateSnapshot` 后全量 1020/1020 仍绿） |
| M2 | `test/host/skills-import.test.mjs` | T3 的回滚语义（逐条 try/catch、stuck、回滚未完成文案）**全仓零测试**，回退成旧写法仍全绿 |
| M3 | `skills-scan.ts:146` + 其测试 | 指纹的 `size` 组件无覆盖（删掉仍全绿），且 mtime+size 可被「等长改写 + 还原 mtime」骗过 |
| M4 | `test/host/settings-bridge.test.mjs` | 表驱动「非字符串」行的消息来自**端点自身的 typeof 收敛**，区分不了 `assertImportableSource` 的类型分支 |
| M5 | `skills-refresh.ts:50-57` | 读失败分支提前 return，跳过候选指纹比对：坏状态文件窗口内引用目录增删技能不失效候选 |
| M6 | `skills-import.ts:97-109` | `stuck` 把「技能没放回」与「容器清理失败（技能其实已恢复）」混成一条误导性消息 |
| M7 | `skills-watcher.ts:20-41` | 单目录 watch 失败被空 `catch` 吞掉且无日志，而本轮把状态文件覆盖完全押在该 watcher 上 |
| M8 | `use-prompt-tool-store.ts:986` + `locales.ts:212` | 导入失败提示改成纯 `'{reason}'` 后传输层失败失去类别语境；`??` 不挡空串，空串会让通知整条不渲染 |
| L1 | `store:272`、`skill-status.ts:26`、`skills-scan.test.mjs:199` | 三处注释错误/含糊：`Math.max` 方向说反、`blockScopeFor` 参数语义含糊、「三个以上元素才不靠稳定性」论证有误（真正的判据是输入顺序≠id 顺序） |
| L2 | 6 个测试文件 | stub 仍保留已从契约删除的 `invalidateCatalog` 字段 |
| L3 | `skills-actions.ts:19-48` | `trashSkill` 未自带 folder 名校验；返回类型里 `folder` 与 `deletedAt` 无读取方 |
| L4 | 测试文案/命名 | `skills-actions` 用例说「只有 record.json」实际是空容器；`prompt-tool-view` 用例名比覆盖面宽（`skillFolders` 无 base 回退未钉住） |
| L5 | 一致性/文档 | `skills-import.test.mjs` 混用 lib/src；docs 108 行「清单**与候选**按六类根指纹」措辞不准；CHANGELOG 未提示历史回收站记录用 `at`；PLAN 上一轮把「已改注释」记成了实际没做的动作 |

## 范围与不变量

- 不改宿主源码；不重启运行中的 DSH；不动真实技能根里的 87 个技能实体。
- 状态文件格式、端点集合、影子机制（rank 0）、回收站位置与字段集不变。
- 指纹仍是「一次 stat 拿全部字段」，不引入逐文件读全文。
- 测试从 `D:/AI/workspase/_temp` 发起，隔离临时 `DSH_HOME`，结束后清理；变异验证只在副本里做。

## Wave 1：回归保护与正确性

<task type="auto">
  <name>T1：候选接线的行为回归（M1）</name>
  <files>test/host/skills-candidates-refresh.test.mjs（新）、test/host/skills-refresh.test.mjs</files>
  <action>新增端到端用例：真实 `SkillRegistry` + 插件 `createSkillsProvider` + 真实 `createSkillsReloader` + 真实引用目录与真实 `rootsFingerprint`——往引用目录里放一个新技能后触发 reload，断言注册表候选里出现它；把 `invalidateCandidates` 换成 no-op 时必须失败。同时在 reloader 用例旁注明其证明边界（只到契约层）。</action>
  <verify>删掉 reloader 的 `invalidateCandidates` 调用、或把指纹接成常量时，该文件必须失败。</verify>
  <security>只用临时目录，不碰真实技能根。</security>
  <done>「引用目录变化 → 模型侧候选刷新」有端到端回归。</done>
</task>

<task type="auto">
  <name>T2：回滚语义回归（M2）</name>
  <files>test/host/skills-import.test.mjs、src/host/skills-import.ts</files>
  <action>用「两个顶层、第二个目录名非法」构造：第一个顶层已进回收站后第二个抛错，断言旧技能被放回原处、目标里没有半成品、失败消息含「回滚未完成」。按 M6 把 `stuck` 拆成「未放回」与「容器清理失败」两类并分别表述。</action>
  <verify>把 catch 回退成旧的 `restore(); throw error` 时用例必须失败；两类失败的消息可区分。</verify>
  <security>回滚只把内容放回原处，不删除用户数据。</security>
  <done>回滚路径有可失败的回归，失败消息不再误导。</done>
</task>

<task type="auto">
  <name>T3：指纹判据与 size 回归（M3）</name>
  <files>src/host/skills-scan.ts、test/host/skills-scan.test.mjs</files>
  <action>指纹加入 `ctimeMs`（同一次 stat、不可被 `utimes` 还原），保留 `mtimeMs` 与 `size`；补用例：等长改写正文并 `utimesSync` 把 mtime 还原后，指纹必须变化。注释说明这是启发式判据与它的覆盖边界。</action>
  <verify>去掉 `size` 或 `ctimeMs` 任一项时新用例失败；普通改写、增删技能仍能失效。</verify>
  <security>只读扫描，指纹仅用于内存缓存。</security>
  <done>「等长改写 + 还原 mtime」不再漏失效。</done>
</task>

<task type="auto">
  <name>T4：读失败也比对指纹、watcher 失败可见（M5 + M7）</name>
  <files>src/host/skills-refresh.ts、src/runtime/skills-watcher.ts、test/host/skills-refresh.test.mjs</files>
  <action>reloader 统一出口：读失败同样走一次候选指纹比对（该失效就失效）后再返回；watcher 在单个目录 attach 失败时告警一次（注入可选 `onError`，由 index.ts 接到 `warn`），并保留下次 `watch()` 的重试语义。</action>
  <verify>坏文件期间改引用目录后候选缓存仍被失效；watch 失败时收到一次告警且不抛错。</verify>
  <security>不因监听失败而中断插件加载。</security>
  <done>读失败窗口与监听失败都不再静默。</done>
</task>

<task type="auto">
  <name>T5：导入失败提示的语境与兜底（M8）</name>
  <files>src/client/features/skills/SkillsPage.tsx、src/client/data/use-prompt-tool-store.ts、src/client/locales.ts</files>
  <action>恢复类别语境并杜绝空串：locale 值改回「导入技能目录失败：{reason}」，调用点剥掉服务端已有的「技能导入失败：」前缀并用 `trim() || 'settings bridge unavailable'` 兜底；store 的两条失败路径共用同一段文案逻辑，`??` 换成 trim 判断。</action>
  <verify>传输层失败、业务失败、空 message 三种输入下提示都非空且带类别；中英字典键成对。</verify>
  <security>只改提示文本。</security>
  <done>失败提示既有语境又不会静默消失。</done>
</task>

## Wave 2：Low 清理

<task type="auto">
  <name>T6：注释与命名纠错（L1 + L4）</name>
  <files>src/client/data/use-prompt-tool-store.ts、src/client/features/skills/skill-status.ts、src/client/features/skills/SkillRow.tsx、test/host/skills-scan.test.mjs、test/host/skills-actions.test.mjs、test/client/prompt-tool-view.test.mjs</files>
  <action>改正 `Math.max` 与 `blockScopeFor` 的注释；把 `skills-scan` 的 rank 用例注释改为「乱序样本才能压到次键」（实测 2 元素反序即可）；`SkillRow` 顶部取一次 `modelBlocked` / `userBlocked` 派生 `checked` 与 `scopeAfterToggle`；修正 `skills-actions` 用例文案为「空容器」；`prompt-tool-view` 用例名收窄并补 `skillFolders` 忽略 base 的负向断言。</action>
  <verify>注释与代码行为一致；收窄后的用例在对应变异下仍会失败。</verify>
  <security>不改行为。</security>
  <done>注释不再误导，用例名与覆盖面一致。</done>
</task>

<task type="auto">
  <name>T7：死字段、契约漂移与校验（L2 + L3）</name>
  <files>src/host/skills-actions.ts、6 个测试文件、test/host/skills-import.test.mjs</files>
  <action>`trashSkill` 内部复用 `SKILL_NAME_PATTERN` 校验 folder（direct 调用不合法名直接拒绝），返回类型删掉无人读取的 `folder` 与 `deletedAt`；从 6 个测试 stub 删除已从契约移除的 `invalidateCatalog`；`skills-import.test.mjs` 统一从 `src` 导入（与 `skills-actions.test.mjs` 一致）。</action>
  <verify>typecheck / lint 全绿；`trashSkill('../x')` 被拒绝且不移动任何目录；stub 里不再有该字段。</verify>
  <security>校验只收紧不放宽。</security>
  <done>导出函数自带边界校验，测试 stub 与契约一致。</done>
</task>

<task type="auto">
  <name>T8：文档与计划对齐</name>
  <files>docs/skills-management.md、CHANGELOG.md、PLAN.md</files>
  <action>docs 区分「清单缓存按六类根指纹」与「候选缓存按引用来源指纹」；CHANGELOG 说明历史回收站记录用 `at` 且不被读取（不做迁移）；PLAN 修正上一轮把「已改注释」记成实际未做的动作，并如实记录本轮各项。</action>
  <verify>文档描述与实现一致；PLAN 记录与代码逐条对得上。</verify>
  <security>不夸大行为。</security>
  <done>文档与计划不再与产物脱节。</done>
</task>

## Wave 3：门禁与交付

<task type="auto">
  <name>T9：完整门禁与提交</name>
  <files>PLAN.md</files>
  <action>typecheck / lint / test / build / verify:host / git diff --check；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志；标注需用户重启 DSH。</action>
  <verify>门禁全绿；暂存只含本轮文件。</verify>
  <security>不停止 DSH；不提交 `.ai-memory`。</security>
  <done>第四轮修复交付完成。</done>
</task>

## 回滚

- 代码回滚：`git revert` 本轮提交回到 `9a5cccf`。
- 数据：本轮不迁移、不改状态文件格式；指纹改动只影响内存缓存判据。

## Task Summary 与状态

- 当前：T1–T9 全部完成并验证。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` 1028/1028 ✓ / `build` ✓ / `verify:host` ✓ / `git diff --check` ✓。

### 执行记录

- **T1（M1）**：新增 `test/host/skills-candidates-refresh.test.mjs`——真实 `SkillRegistry` + 插件 provider +
  真实 reloader + 真实引用目录的端到端回归（新增技能 / 改写描述 / 删除技能 3 条 + 「不失效候选就看不到」的
  负向对照）。过程中发现负向对照必须先查一次 list 建立缓存，否则首次 list 本来就会重扫、对照失去意义——已修正。
- **T2（M2 + M6）**：补「覆盖导入中途失败」用例（第一个顶层已进回收站、第二个目录名非法 → 旧技能必须放回、
  目标不留半成品、回收站不留残留）；`restore()` 改为把「技能未放回原处」与「回收站残留空容器」分开报告。
- **T3（M3）**：指纹判据加入 `ctimeMs`（`utimes` 改不动它）。**做端到端用例时真实复现了缺口**：
  「旧描述」→「新描述」等长改写落在同一毫秒，mtime+size 指纹不变 → 候选描述不刷新；加 `ctimeMs` 后通过。
- **T4（M5 + M7）**：reloader 改成统一出口——读失败也走一次候选指纹比对；watcher 增加可选 `onError`，
  无法监听的目录报告一次（重复挂载不重复告警），index.ts 接到 `warn`。
- **T5（M8）**：导入失败提示恢复「导入技能目录失败：」类别前缀，调用点剥掉服务端同义前缀并用
  `trim() || 'settings bridge unavailable'` 兜底；store 与非 store 两条路径口径一致。
- **T6（L1 + L4）**：改正三处注释（`Math.max` 的下溢方向、`blockScopeFor` 的参数含义、rank 并列的判据）；
  `scopeAfterToggle` 提为 `skill-status.ts` 的模块级纯函数（SkillRow 改为消费它）并补「两端屏蔽后仍能逐端恢复」
  的往返用例；`skills-actions` 用例文案改为「空容器」；`prompt-tool-view` 用例名收窄并补 `skillFolders`
  忽略 base 的负向断言。
- **T7（L2 + L3）**：`trashSkill` 自带 `SKILL_NAME_PATTERN` 校验（`'../escape'` 被拒绝且不创建回收站目录）
  并去掉无人读取的 `folder` / `deletedAt` 返回字段；6 个测试 stub 删除已从契约移除的 `invalidateCatalog`；
  `skills-import.test.mjs` 统一从 `src` 导入（新增断言不再依赖构建产物）。
- **T8（L5）**：docs 把「清单缓存按六类根指纹」与「候选缓存按引用来源指纹」分开表述；CHANGELOG 记录
  覆盖导入历史记录用 `at` 且不做迁移；PLAN 修正上一轮把「已改注释」记成实际未做的动作。
- **T9**：门禁全绿；提交前做了四组**反向变异**，逐条证明新修复被测试守住（见下表）。

### 反向变异验证（证明修复不会悄悄退化）

| 变异 | 期望失败 | 实测结果 |
|---|---|---|
| 指纹去掉 `ctimeMs` | 指纹单测 + 候选端到端 | **恰好这 2 条红**，其余 14 条绿 |
| 读失败分支提前 `return` | 状态文件损坏用例 | **恰好 1 条红**，其余 5 条绿 |
| 回滚调用换成空结果 | 覆盖导入中途失败用例 | **恰好 1 条红**，其余 6 条绿 |
| watcher 去掉 `onError` + 开关参数写反 | 各 1 条 | **恰好 2 条红**（分属两个文件），其余 10 条绿 |

四组变异均已回退，回退后全量 1028/1028 通过，并用 grep 确认无变异残留。

[✔] Wave 1 / T1：候选接线行为回归
[✔] Wave 1 / T2：回滚语义回归与 stuck 分类
[✔] Wave 1 / T3：指纹判据与 size 回归
[✔] Wave 1 / T4：读失败比对与 watcher 失败可见
[✔] Wave 1 / T5：导入失败提示语境与兜底
[✔] Wave 2 / T6：注释与命名纠错
[✔] Wave 2 / T7：死字段、契约漂移与校验
[✔] Wave 2 / T8：文档与计划对齐
[✔] Wave 3 / T9：门禁与提交
