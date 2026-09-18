# 第三轮审查修复：候选失效回归、状态文件缺失语义与测试强度

## 授权与基线

- 用户指令（2026-09-18）：对第三轮 OCR 复审报告选择「High + Medium + Low 全清」。
- 审查基线：`5bc6af3..47b4b0b`（三路委派 + 变异验证，reviewed 26/26，coverage 100%）。
- 代码基线：dev@47b4b0b；[旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-review-round3-47b4b0b-20260918.md)（与基线 `PLAN.md` 逐字节一致）。
- 结论分布：1 条 High（**本轮引入的回归**）、7 条 Medium、26 条 Low。三路交叉确认无问题的项（回收站布局与路径安全、快照比较稳定性、provider 语义等价、协议清理彻底性、schemastery 未知键行为）不在返工范围。

## 核心问题（High）

`src/host/skills-refresh.ts` 在 T10 把缓存失效拆成 `invalidateList`（总是）与 `invalidateCandidates`（仅状态快照变化）时漏了一条路径：**引用文件夹里新增 / 删除 / 改写技能不改变状态快照**（快照只来自 `skills.yml`）。官方 `SkillRegistry` 按 revision 缓存合并后的候选，只有 `control.invalidate()` 会推进 revision，而官方 skill-filesystem 的 watcher 只监听它自己的根（引用目录没有配成 `customSkillDirs`）。于是：

- 引用目录里新增的技能、改过的 `description` / `whenToUse` **进不了模型侧候选**，直到下一次无关失效；
- 插件自己的清单因指纹刷新**会**显示它 → 界面与模型两个真相；
- 基线 `5bc6af3` 每次事件都 `invalidateCatalog()`，所以这是本轮引入的回归；
- `test/host/skills-refresh.test.mjs` 与 `docs/skills-management.md` 还把这个错误不变量写成了契约。

修法：reloader 增加 `candidatesFingerprint` 依赖，由 `index.ts` 传入引用根指纹；快照变化**或**该指纹变化都失效候选缓存——精确到"引用目录真的变了"才让官方提供者重扫。

## 范围与不变量

- 不改宿主源码；不重启运行中的 DSH；不动真实技能根里的 87 个技能实体。
- 状态文件格式（v3）、端点集合、影子机制（rank 0）不变。
- 回收站仍是 `<根>/.system/prompt-tool/.trash`，落盘仍是「先暂存再原子切换」。
- 测试从 `D:/AI/workspase/_temp` 发起，隔离临时 `DSH_HOME`，结束后清理。
- 每处修复先能失败，再改实现。

## Wave 1：回归与正确性

<task type="auto">
  <name>T1：引用目录变化必须失效候选缓存（High）</name>
  <files>src/host/skills-refresh.ts、src/index.ts、test/host/skills-refresh.test.mjs、docs/skills-management.md</files>
  <action>reloader 增加 `candidatesFingerprint: () => string` 依赖并在内部记住上次值：状态快照变化或指纹变化时调用 `invalidateCandidates`，否则只失效清单缓存。index.ts 传入引用根指纹。测试用例②改为「引用目录指纹变化 → 必须失效候选」，并保留「两者都没变 → 不失效候选」的正向对照；文档把错误不变量改写为真实契约。</action>
  <verify>把 reloader 的分流改回「只看快照」时用例必须失败；引用目录里新增技能后，模型侧候选确实刷新（用真实 `SkillRegistry` + 插件 provider 的集成路径验证）。</verify>
  <security>只失效内存缓存，不写任何技能根。</security>
  <done>引用目录的增删改都能进模型侧候选，界面与模型不再两个真相。</done>
</task>

<task type="auto">
  <name>T2：状态文件缺失的语义显式化（Medium）</name>
  <files>src/host/skills-refresh.ts、test/host/skills-refresh.test.mjs</files>
  <action>`readSkillsState` 对文件不存在返回 `{ok:true, exists:false}`，当前 `exists` 被丢弃、静默按空状态处理。改为：首次发现文件消失时告警一次（说明屏蔽表与引用目录已按空状态处理），语义上仍视为用户重置；`degraded` 的复位只发生在成功且存在的读取上。</action>
  <verify>删除状态文件后内存状态被清空但留下一条告警；重复事件不重复告警；文件恢复后状态回归且不再告警。</verify>
  <security>不重建、不覆盖用户删除的文件。</security>
  <done>「文件消失」与「读失败」都不再静默。</done>
</task>

<task type="auto">
  <name>T3：回滚失败不掩盖根因（Medium）</name>
  <files>src/host/skills-import.ts、test/host/skills-import.test.mjs</files>
  <action>`restore()` 逐条 try/catch：单条失败不中断其余条目，收集未恢复路径，把「回滚未完成，请在 <回收站路径> 手动恢复」并入失败消息；原始导入错误始终保留在消息里。</action>
  <verify>构造一条 rename 失败的条目后，其余条目仍被恢复，消息同时含原始错误与未恢复路径。</verify>
  <security>回滚只把内容放回原处，不删除用户数据。</security>
  <done>回滚失败可诊断，不再停在混合态且原因失真。</done>
</task>

## Wave 2：测试强度（Medium）

<task type="auto">
  <name>T4：rank 并列与指纹断言加强</name>
  <files>test/host/skills-scan.test.mjs</files>
  <action>rank 并列样本加到 3 个元素并补第三元素断言；`rootsFingerprint` 的「根不存在」用例改为断言精确值（kind|path|-），不再只断言两次调用相等。</action>
  <verify>删掉 `markWinners` 的 id 第二键、或让指纹返回随机串时，对应用例必须失败。</verify>
  <security>测试只用临时目录。</security>
  <done>排序次键与降级取值都有可失败的断言。</done>
</task>

<task type="auto">
  <name>T5：两个入口的回收站回归与用例精简</name>
  <files>test/host/skills-import.test.mjs、test/host/skill-block-shadow.test.mjs</files>
  <action>`importSkillsPackage` 用例补「旧版本进回收站」断言；影子 rank 用例删掉读同一常量的同义反复断言，保留权重更高的常量守卫并把 `SKILL_BLOCK_RANK` 钉成 0。</action>
  <verify>在 `importSkillsPackage` 覆盖路径前短路时新断言失败；把影子 rank 调大时守卫断言失败。</verify>
  <security>测试只用临时目录。</security>
  <done>两个导入入口的回收站行为与影子 rank 取值都有回归。</done>
</task>

<task type="auto">
  <name>T6：视图回退路径与注释</name>
  <files>test/client/prompt-tool-view.test.mjs、src/client/features/skills/skill-status.ts、src/client/features/skills/SkillRow.tsx</files>
  <action>补「顶层扩展字段优先、descriptor value / base 兜底」的用例；修正失准注释；`skillStatusTone` 的不可调用判定改用与页签一致的可用性谓词；把两个开关的 scope 计算抽成命名函数并注释「参数是点击后的目标屏蔽状态」，避免再被读反。</action>
  <verify>把回退优先级反转时新用例失败；徽章色调与页签口径一致。</verify>
  <security>只改展示与选择逻辑，不改屏蔽写入语义。</security>
  <done>回退路径有覆盖，开关语义可读。</done>
</task>

## Wave 3：Low 清理

<task type="auto">
  <name>T7：回收站事务与记录统一</name>
  <files>src/host/skills-import.ts、src/host/skills-actions.ts、test/host/skills-actions.test.mjs</files>
  <action>`moveToTrash` 失败时 best-effort 清理自己创建的容器再抛错；抽出共用的 `trashSkill(base, folder, { origin })`，导入与删除写入同一套字段（`folder` / `source` / `origin` / `deletedAt` / `files`）。</action>
  <verify>record 结构在两个入口一致；容器创建或改名失败后回收站不留「只有 record.json」的空条目。</verify>
  <security>回收站仍只落在插件自己的 `.system/prompt-tool` 下。</security>
  <done>同一回收站只有一种记录形状，失败不留垃圾。</done>
</task>

<task type="auto">
  <name>T8：指纹与 provider 收敛</name>
  <files>src/host/skills-scan.ts、src/host/skills-provider.ts</files>
  <action>指纹同时取 `mtimeMs` 与 `size`（仍是一次 stat）；删掉 `blockedCandidate` 无人传入的 `scope` 形参；`get()` 里不可达的 `?? skill.file` 化简为 `candidate.path`。</action>
  <verify>保留 mtime 但改变内容大小时指纹必须变化；typecheck 与 lint 全绿。</verify>
  <security>指纹只用于内存缓存。</security>
  <done>指纹不漏「保留 mtime 的写入」，provider 无死形参与死分支。</done>
</task>

<task type="auto">
  <name>T9：接线与可观测性清理</name>
  <files>src/index.ts、src/runtime/settings-bridge.ts、src/host/skills-refresh.ts</files>
  <action>把 `let invalidateSkills` 的声明提到 watcher / reloader 之前，消除隐式时序依赖；删掉与 `USER_SKILLS_DIR` 重复的 `dirname(skillsStateFile)` 递归监听；删掉 settings-bridge deps 里零调用的 `invalidateCatalog` 字段与实参；`degraded()` 访问器若仍只有测试消费则删除，测试改为断言告警次数与状态不变量。</action>
  <verify>typecheck / lint 全绿；watcher 仍能捕获状态文件变化（状态文件在用户技能根子树内）。</verify>
  <security>不减少实际监听覆盖面。</security>
  <done>接线无隐式时序、无重复监听、无死字段。</done>
</task>

<task type="auto">
  <name>T10：错误消息与夹具卫生</name>
  <files>src/client/data/use-prompt-tool-store.ts、src/client/locales.ts、test/fixtures/ui-v2-drafts.mjs</files>
  <action>导入失败提示去掉重复的类别前缀（服务端消息已含「技能导入失败：」）；真正把 fixture 的 `blockedSkills` 内联为局部值并删除模块级变量。</action>
  <verify>用户可见消息只有一层前缀；fixture 内不再有 `blockedSkills` 声明；浏览器用例仍通过。</verify>
  <security>不改写盘路径与载荷。</security>
  <done>提示不重复，夹具无残留降级变量。</done>
</task>

<task type="auto">
  <name>T11：测试细节与文档同步</name>
  <files>test/host/skills-refresh.test.mjs、test/host/skills-catalog.test.mjs、test/host/settings-bridge.test.mjs、test/shared/bridge-contract.test.mjs、docs/skills-management.md、CHANGELOG.md、PLAN.md</files>
  <action>`watcher.watch()` 移进 try 保证异常时也关闭；轮询超时的断言消息带上诊断信息；`skills-catalog` 注释去掉「根指纹」；`settings-bridge` 的纯空白与非字符串改表驱动按原因断言；契约测试补「describe 不下发 skillBlocked」的负向断言；文档与 CHANGELOG 同步本轮行为。</action>
  <verify>全量测试通过；注释与断言一致；文档描述与实现一致。</verify>
  <security>不夸大行为。</security>
  <done>测试细节与文档同实现对齐。</done>
</task>

## Wave 4：门禁与交付

<task type="auto">
  <name>T12：完整门禁与提交</name>
  <files>PLAN.md</files>
  <action>typecheck / lint / test / build / verify:host / git diff --check；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志；标注需用户重启 DSH。</action>
  <verify>门禁全绿；暂存只含本轮文件。</verify>
  <security>不停止 DSH；不提交 `.ai-memory`。</security>
  <done>第三轮修复交付完成。</done>
</task>

## 回滚

- 代码回滚：`git revert` 本轮提交回到 `47b4b0b`（本轮的 T1 是把上一轮拆细的失效恢复成"按指纹判定"，回滚无害）。
- 数据：本轮不迁移、不改状态文件格式；真实技能根 87 个实体与 0 链接的布局不变。

## Task Summary 与状态

- 当前：T1–T12 全部完成并验证。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` 1020/1020 ✓ / `build` ✓ / `verify:host` ✓ / `git diff --check` ✓。

### 执行记录

- **T1（High）**：`createSkillsReloader` 增加 `candidatesFingerprint` 依赖（index.ts 传引用根指纹），
  状态快照或该指纹任一变化就 `invalidateCandidates`；测试用例②改为「引用目录指纹变化必须失效候选」，
  并保留「两者都没变 → 不失效候选」的正向对照；文档把原先写错的契约改正。
- **T2（Medium）**：`exists === false` 显式处理——按用户重置接受空状态，但首次发现时告警一次
  （「技能状态文件不存在，已按空状态处理」），文件回来后自动恢复且重复事件不重复告警。
- **T3（Medium）**：`restore()` 逐条 try/catch，返回放不回去的路径；失败消息同时含原始原因与
  「回滚未完成，请在回收站手动恢复：<路径>」，不再让回滚异常掩盖根因。
- **T4（Medium）**：rank 并列补到三个元素并加第三条断言（删掉排序次键时正序与反序都会失败）；
  根指纹的「根不存在」用例改为断言精确值 `custom|<path>|-`。
- **T5（Medium）**：`importSkillsPackage` 补回收站断言（容器数、旧正文、`origin`）；
  影子 rank 用例删掉同义反复，保留 provider 实际产出的 rank 断言并把 `SKILL_BLOCK_RANK` 钉成 0。
- **T6（Medium）**：补「顶层 → descriptor value → base」优先级用例；`skillStatusTone` 改用与页签一致的
  可用性谓词；`SkillRow` 把 scope 计算抽成 `scopeAfterToggle(side)`，并注明「参数是点击后的目标屏蔽状态」——
  上一轮 A 路把这段读成了死端，注释就是防这个。
- **T7（Low）**：抽出 `trashSkill(base, folder, origin)` 供删除与覆盖导入共用，记录字段统一为
  `folder` / `source` / `origin` / `deletedAt` / `files`；失败时清理自己创建的容器（新增用例用
  「源目录不存在」触发）。
- **T8（Low）**：指纹同时取 `mtimeMs` 与 `size`；删掉 `blockedCandidate` 无人传入的 `scope` 形参；
  `get()` 里不可达的 `?? skill.file` 化简。
- **T9（Low）**：`invalidateSkills` 声明提前到 watcher/reloader 之前；watcher 去掉与 `USER_SKILLS_DIR`
  重复的 `dirname(skillsStateFile)`；删除 settings-bridge 里零调用的 `invalidateCatalog` 依赖与实参；
  删除无消费者的 `degraded()`（测试改断言告警次数与状态不变量）。
- **T10（Low）**：导入失败提示去掉重复前缀（locale 值直接是 `{reason}`，store 直接用服务端消息）；
  fixture 真正内联了 `blockedSkills`（上一轮声称做了但没做，PLAN 描述与代码不符，本轮补上）。
- **T11（Low）**：`watcher.watch()` 移进 try；轮询超时断言带上诊断信息；`settings-bridge` 的四类非法路径
  改表驱动按原因断言；契约测试补「describe 不下发 `skillBlocked` / `skillsDirExists`」负向断言；
  store 的两处注释补上守卫与下溢兜底的意图；文档与 CHANGELOG 同步。
- **过程中的一次自身失误**：T11 调整 `skills-catalog.test.mjs` 注释时，edit 的 `old_string` 带走了行尾换行，
  把紧随其后的 `test(...)` 吞进注释行，导致该用例脱离测试框架（断言变成模块顶层语句）。发现后立即修复，
  该文件测试数恢复为 4 条并通过全量验证。
- **审查误报记录**：A 路的「两端屏蔽后开关是死端、无法恢复」经逐组合推演与冒烟测试
  `ui-v2-page-smoke.test.mjs:440-478`（`user→all→model→none` 往返）证伪；A 路的
  「`skillStatusTone` 口径不一致」在当前数据下与既有条件等价（`skill.blocked ||` 已覆盖）。

[✔] Wave 1 / T1：引用目录变化失效候选
[✔] Wave 1 / T2：状态文件缺失语义
[✔] Wave 1 / T3：回滚失败不掩盖根因
[✔] Wave 2 / T4：rank 并列与指纹断言
[✔] Wave 2 / T5：回收站回归与用例精简
[✔] Wave 2 / T6：视图回退路径与开关可读性
[✔] Wave 3 / T7：回收站事务与记录统一
[✔] Wave 3 / T8：指纹与 provider 收敛
[✔] Wave 3 / T9：接线与可观测性清理
[✔] Wave 3 / T10：错误消息与夹具卫生
[✔] Wave 3 / T11：测试细节与文档同步
[✔] Wave 4 / T12：门禁与提交
