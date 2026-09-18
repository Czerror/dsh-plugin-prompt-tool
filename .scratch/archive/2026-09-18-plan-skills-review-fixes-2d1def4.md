# 注册层屏蔽的审查修复：安全洞、缓存失效、口径与测试补强

## 授权与基线

- 用户指令（2026-09-17）：对 OCR 审查报告（`5dd0a2a..15dd1b4`）选择「High + Medium + Low 全清」。
- 基线：dev@15dd1b4，工作树干净（除 gitignored `.ai-memory`）。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-registration-block-15dd1b4-20260917.md)（blob `37e0ef8b4911b75a59a51e8ef6fc175fb338bec6`，与基线 `PLAN.md` 逐字节一致）。
- 审查轮次只读、未改任何文件；本轮才是修复授权，范围以本文件为准。

## 审查结论摘要

上一提交把技能管理改成「注册层屏蔽」：插件为被屏蔽的技能名返回 rank 0 的影子候选，注册表按 rank 升序合并同名候选时官方候选被丢弃；模型目录过滤 `isModelInvocable`，`skill` 工具加载时再次拒绝。方向经实测成立，真实环境已回到「技能实体原地 + 注册层屏蔽」。

但该轮留下三类问题，本轮全部处理：

| 编号 | 严重度 | 结论 |
|---|---|---|
| H1 | High（安全） | 空路径导入把进程 cwd 整树复制进技能根，已在隔离 cwd 复现 |
| H2 | High | 该端点的 400 断言与实现相反，靠共享 cwd 污染偶然变绿 |
| H3 | High | 影子屏蔽这一核心机制**零测试**，文档引用的两个测试文件不存在 |
| M1–M7 | Medium | 「已停用」口径、开关连点竞态、引用目录缓存不刷新、中文分组泄漏、三处恒真断言 |
| L1–L13 | Low | 类型谎言、只算不用、busy 语义、死开关、弱守卫、孤儿 i18n/CSS/state、测试卫生 |

## H1 复现记录（修复依据）

隔离 cwd `_temp/probe-empty-path`（目录名恰为 kebab-case）下调用 `importSkillsDirectory(target, '')`：

- `resolve('')` 退化为 `process.cwd()`，`basename(cwd)` 恰好通过 `SKILL_NAME_PATTERN`；
- 返回 `{ok:true, count:2}`，把 cwd 下 `secret-dir/SKILL.md` 与 `probe.mjs` 复制进技能根；
- 端点 handler 只校验 `typeof path === 'string'`，空串直接放行。

结论：**任意可读文件都能被做成模型可加载的技能**，且 loopback 端点上本机任意页面可触发。

## 范围与不变量

- 只改本插件；不改宿主源码；不重启运行中的 DSH。
- 影子机制与状态文件格式（v3）**不变**：本轮不引入新状态、不改 `skills.yml` 结构、不改端点集合。
- 修复不得削弱既有安全边界：loopback/Host/Origin 校验、请求体上限、写盘归属校验、system 目录只读。
- 测试一律从 `D:/AI/workspase/_temp` 发起，使用隔离临时 `DSH_HOME` 与独立临时目录，结束后清理，不依赖共享状态与执行顺序。
- 每处修复先能失败（或先证明现状错误），再改实现。

## Wave 1：安全与热更新正确性

<task type="auto">
  <name>T1：空路径与相对路径导入拒绝（H1）</name>
  <files>src/runtime/settings-bridge.ts、src/host/skills-import.ts、test/host/settings-bridge.test.mjs</files>
  <action>`importSkillsDirectory` 入口拒绝非字符串、空串与纯空白来源，并要求绝对路径后再 `resolve`；`skills-import-directory` handler 在调用前同样校验 `trim()` 非空且 `isAbsolute`，不合法直接 400 且零读盘。错误消息区分「路径为空」与「必须是绝对路径」。</action>
  <verify>空串、纯空白、相对路径、非字符串四类载荷一律 400 且技能根无任何新增；绝对路径合法目录仍可导入；断言不依赖 cwd 内容（用隔离临时目录构造来源）。</verify>
  <security>拒绝一切把进程工作目录当作导入源的路径形态；不因校验放宽而允许目录穿越。</security>
  <done>空路径导入不再可能，端点与实现双层拒绝且有行为回归。</done>
</task>

<task type="auto">
  <name>T2：引用目录变化必须刷新清单（M3）</name>
  <files>src/index.ts、src/host/skills-refresh.ts（新）、test/host/skills-refresh.test.mjs（新）</files>
  <action>watcher 回调无论状态快照是否变化都执行 `invalidateCatalog()`；仅在快照变化时重读状态与重挂 watcher（引用目录集合可能变）。修正注释：文件系统事件与状态变化是两件事。</action>
  <verify>在引用目录里新增 / 删除技能后，同一 cwd 的清单不再返回缓存旧值；状态文件未变时不清空状态对象；重复事件幂等。</verify>
  <security>不清空用户文件；只失效内存缓存。</security>
  <done>引用目录的增删能反映到清单，状态重挂语义不变。</done>
</task>

<task type="auto">
  <name>T3：屏蔽开关的并发语义（M2 + L3）</name>
  <files>src/client/data/use-prompt-tool-store.ts、src/client/features/skills/*、client tests</files>
  <action>`setSkillBlocked` 与其它技能写操作统一：进入时置 busy、结束（含失败）复位；用即时生效的 ref 守卫丢弃忙期内的重复点击，避免两次连点都用旧 props 重算整个 scope 后互相覆盖。</action>
  <verify>忙期内的第二次调用不发出第二个请求；失败后 busy 复位且可重试；成功路径仍触发清单刷新。</verify>
  <security>客户端不拼写盘路径；失败保留原开关状态与错误提示。</security>
  <done>连点不再产生覆盖写，busy 语义与其它技能写操作一致。</done>
</task>

## Wave 2：口径、国际化与死代码

<task type="auto">
  <name>T4：「已停用」口径按端拆分（M1）</name>
  <files>src/client/features/skills/skill-status.ts、src/client/features/skills/SkillsPage.tsx、src/client/locales.ts、client tests</files>
  <action>新增「两端都被屏蔽」判定；`blocked` tab 只收两端停用的技能，只关一端不再同时出现在「用户 / 模型」与「已停用」；状态徽章按端区分文案（模型端已停用 / 用户端已停用 / 已停用），中英双语补齐。</action>
  <verify>四类技能（未屏蔽、只关模型、只关用户、两端关）在三个 tab 的归属唯一且计数自洽；徽章文案与 `blockedModel`/`blockedUser` 一致。</verify>
  <security>仅展示层口径，不改屏蔽写入语义。</security>
  <done>筛选口径互斥完备，徽章如实反映按端屏蔽。</done>
</task>

<task type="auto">
  <name>T5：分组标题与来源筛选走 i18n（M4）</name>
  <files>src/client/features/skills/skill-status.ts、src/client/features/skills/SkillsPage.tsx、client tests</files>
  <action>`groupBySource` 不再回传中文标签，只回传来源类型与优先级；界面统一用 `skills.source.<kind>` 键渲染分组标题与来源筛选选项，英文界面不再出现中文。</action>
  <verify>英文 locale 下分组标题与筛选项全部为英文；分组顺序仍按官方优先级；空分组不返回。</verify>
  <security>不引入新的硬编码文案。</security>
  <done>技能页文案全部来自 locale 表。</done>
</task>

<task type="auto">
  <name>T6：客户端类型与孤儿清理（L1、L2、L11–L13）</name>
  <files>src/client/data/prompt-tool-fields.ts、src/client/data/prompt-tool-view.ts、src/client/locales-prompts.ts、src/client/ui/controls.module.css、src/client/data/workspace-browse-state.ts</files>
  <action>删除与服务端载荷不符且无人消费的 `skillBlocked: string[]` 字段；删除只计算不使用的 `skillsRootExists` 及其注释；删除孤儿 i18n 键、孤儿 CSS 类与浏览状态里的死字段。</action>
  <verify>删除后 typecheck 与 lint 全绿；grep 确认无残留引用；被删键在源码中不存在。</verify>
  <security>只删死代码，不动任何被引用的导出。</security>
  <done>死类型、死字段、死样式清零。</done>
</task>

## Wave 3：测试补强

<task type="auto">
  <name>T7：核心机制回归测试与文档引用（H3 + H2）</name>
  <files>test/host/skills-scan.test.mjs（新）、test/host/skill-block-shadow.test.mjs（新）、test/host/settings-bridge.test.mjs、docs/skills-management.md</files>
  <action>补「六类官方技能根的一层发现 + 同名裁决 + 来源标注」与「影子女候选压制官方候选」两组行为回归；影子测试用真实注册表合并路径断言 rank 0 胜出、按端调用标志生效、`get()` 不返回正文、删除记录即恢复；空路径载荷断言改为不依赖 cwd 内容的真断言。</action>
  <verify>两个新测试文件存在且被文档引用一致；影子测试在移除 rank 0 取值时会失败（负向对照 rank 250 压不过）；空路径用例单独运行也通过。</verify>
  <security>测试使用隔离临时 DSH_HOME 与临时目录，不改真实环境。</security>
  <done>核心机制有可失败的行为回归，文档引用的文件真实存在。</done>
</task>

<task type="auto">
  <name>T8：恒真断言与测试卫生（M5–M7 + L4–L10）</name>
  <files>test/host/bridge-contract.test.mjs、test/host/editor-state.test.mjs、test/host/client-wiring-contract.test.mjs、test/host/skills-config.test.mjs、test/host/skills-catalog.test.mjs、test/host/ui-v2-page-smoke.test.mjs、test helpers/fixtures</files>
  <action>把三处恒真断言改为真断言（技能字段确实进入 / 不进入快照、锚点确实存在）；移除 fixture 里没有实现的死开关；补 `createSkill` 半成品目录回滚分支覆盖；yaml 语料守卫从「至少 2 条」提升为与用例表一致的下限；恢复被测试改动的环境变量；清理重复注释与 src/lib 混用导入。</action>
  <verify>每条改后断言在人为破坏实现时确实失败；全套测试通过；不残留被修改的进程级环境变量。</verify>
  <security>测试不写真实用户目录。</security>
  <done>不再有恒真断言与死开关，测试对实现变化敏感。</done>
</task>

## Wave 4：门禁与交付

<task type="auto">
  <name>T9：完整门禁、文档与提交</name>
  <files>README.md、docs/skills-management.md、docs/ui-architecture.md、CHANGELOG.md、PLAN.md</files>
  <action>同步行为变化到权威文档与 CHANGELOG；运行 typecheck / lint / test / build（必要时 verify:host）/ diff --check；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志。</action>
  <verify>全部门禁通过且输出留档；git 暂存只含本轮文件；文档中的路径、命令、端点全部有效。</verify>
  <security>不提交 `.ai-memory`；不停止 DSH。</security>
  <done>修复交付完成，真实环境需用户重启 DSH 后生效。</done>
</task>

## 回滚

- 代码回滚：`git revert` 本轮提交即可回到 `15dd1b4`；本轮不改状态文件格式，不需要数据回滚。
- 行为回滚：T1/T2 的加固若误伤合法导入，只需放宽 `importSkillsDirectory` 的绝对路径校验，端点拒绝空路径的部分必须保留。
- 状态文件 `skills.yml`（v3）在本轮不变；真实环境 87 个技能目录与 0 链接的布局不变。

## Task Summary 与状态

- 当前：T1–T9 全部完成并验证。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` 1010/1010 ✓ / `build` ✓ / `verify:host`（官方包 47 个，失败 0）✓ / `git diff --check` ✓。

### 执行记录

- **T1（H1）**：`importSkillsDirectory` 增加空路径与绝对路径校验，`skills-import-directory` 端点同样前置拒绝。
  修复前 `path: ''` 会把整个 cwd 复制进技能根；修复后空串、纯空白、相对路径、非字符串四类载荷一律 400，
  断言改为「技能根无任何新增」，不再依赖 cwd 名字恰好不是 kebab-case。
- **T2（M3）**：刷新策略抽到 `src/host/skills-refresh.ts`（`createSkillsRefresh`）：文件系统事件无条件失效清单缓存，
  只有状态快照变化才重挂 watcher；新增 `test/host/skills-refresh.test.mjs` 锁住「状态未变也必须失效」。
- **T3（M2 + L3）**：`setSkillBlocked` 置 busy 并用即时 ref 守卫丢弃忙期内的重复提交，与其它技能写操作语义一致。
- **T4（M1）**：新增 `skillFullyBlocked`，「已停用」页签只收两端都关的技能；徽章按端区分并补齐中英字典键。
- **T5（M4）**：`groupBySource` 不再回传中文标签，分组标题与来源筛选统一走 `skills.source.<kind>`；
  冒烟测试的来源分组断言改为在页面内用同一个 `t` 求值，不再写死文案。
- **T6（L1/L2/L11–L13）**：删除客户端 `skillBlocked`（服务端发对象数组而类型写成 `string[]`，且无人消费）与
  `skillsRootExists`（只算不用）、孤儿字典键 `skills.selectHint`、孤儿样式 `.skillOrderButtons`、
  浏览状态里的死字段 `skills.selected`。
- **T7（H3 + H2）**：新增 `test/host/skills-scan.test.mjs`（一层发现、技能根顺序、有效性、同名裁决、清单投影）与
  `test/host/skill-block-shadow.test.mjs`（真实 `SkillRegistry`：影子压过 100–600 六档、按端调用标志、
  `get()` 永不返回正文、rank 250 对照、引用候选）；`docs/skills-management.md` 的回归表指向真实存在的文件并补上刷新策略一行。
  核对中修正了我自己的两处错误认知：同层 rank **升序**小者胜（250 压得过 400、压不过 100），
  以及 `registry.list()` 返回的摘要**不含 rank**。
- **T8（M5–M7 + L4–L10）**：bootstrap 技能事实改用非空数据断言透传；参数快照断言改为「键集合恰好等于参数键」；
  客户端接线锚点改用真实存在的 `pt-skills-library` 并先断言锚点存在；`rejectSkillBlock` 死开关删除、
  `rejectSkillsFolders` 补失败路径用例；创建技能补符号链接用户根用例并如实注释回滚分支的触发条件；
  yaml 语料守卫从「至少 2 条」改为「每个真实 SKILL.md 都必须产出语料」；恢复被测试改动的 `DSH_HOME`；
  清理重复注释与 src/lib 混用（顺带把 `settings-bridge` 的构造器参数属性改成显式字段赋值，
  让该文件可被 Node 直接类型剥离导入，测试不必再依赖构建产物）。
- **T9**：门禁全绿；CHANGELOG 与 `docs/skills-management.md` 同步本轮行为变化。

[✔] Wave 1 / T1：空路径导入拒绝
[✔] Wave 1 / T2：引用目录缓存失效
[✔] Wave 1 / T3：开关并发语义
[✔] Wave 2 / T4：已停用口径
[✔] Wave 2 / T5：分组 i18n
[✔] Wave 2 / T6：死代码清理
[✔] Wave 3 / T7：核心机制回归与文档引用
[✔] Wave 3 / T8：恒真断言与测试卫生
[✔] Wave 4 / T9：门禁与交付
