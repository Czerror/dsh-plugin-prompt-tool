# 第二轮审查修复：导入覆盖、根覆盖失效、状态回落与测试证明力

## 授权与基线

- 用户指令（2026-09-18）：对第二轮 OCR 复审报告选择「再全清一轮（High + Medium + Low）」。
- 审查基线：`15dd1b4..2d1def4`（三路委派，只读，reviewed 30/30 + 补审 1，coverage 100%）。
- 代码基线：dev@5bc6af3（审查期间自查提交：`importFiles` 技能根绝对路径校验）。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-review-fixes-2d1def4-20260918.md)（与基线 `PLAN.md` 逐字节一致）。
- 审查结论：无 critical；1 条数据丢失、2 条 High（均在新测试的证明力）、10 条 Medium、13 条 Low。三路交叉确认的成立项（影子机制、`get()` 不误匹配正文、注册表缓存三条失效路径、构造器参数属性改写等价、字典键成对）不在本轮返工范围。

## 本轮问题清单

| 组 | 位置 | 结论 |
|---|---|---|
| A | `src/host/skills-import.ts:151-158` | 目录导入固定 `overwrite=true`：覆盖同名技能时旧目录被 rename 后 `rmSync` **永久删除**，UI 无「将覆盖」确认，成功提示不含覆盖信息；`createSkill` 对同名却是拒绝 |
| B | `src/index.ts:304-321,357-373` | watcher 只监听状态目录与引用文件夹，**不含用户技能根、项目根、agents 根、内置根**：手工增删后管理页清单长期陈旧 |
| C | `src/host/skills-refresh.ts:24-31` | 状态文件读失败时回落默认状态并被 `accept`：瞬时坏文件窗口内屏蔽全部失效、引用目录全消失，且持续刷 warn |
| D | `use-prompt-tool-store.ts:1037-1057` | 忙期守卫静默 `return false`（调用方丢弃返回值、无提示）；`skillsBusy` 是五个写操作共用的单一布尔，可能被其它操作的 finally 提前复位 |
| E | `skill-status.ts:19-21,30-35` | 技能自身声明两端都不可调用但未被插件屏蔽时，三个页签都不收（只在「全部」），计数相加不等于总数 |
| F | `src/shared/skills.ts:17-24` | `SKILL_SOURCES[].label` 已零引用，与 locale 文案双真相 |
| G | `bridge-transport.ts:16`、`settings-bridge.ts:683` | `skillsDirExists` 与 `skillBlocked` 无客户端消费方却仍透传，与 CHANGELOG 声明不齐 |
| H | `test/host/skills-refresh.test.mjs` | 只测纯策略函数，`src/index.ts` 真装配零覆盖；`state()`/`snapshot()` 断言走替身自写回的闭包 |
| I | `test/host/skills-scan.test.mjs` | rank 并列（排序第二键）无覆盖；未设 `DSH_BUNDLED_SKILL_DIR` 时不产生 bundled 根无负向 |
| J | `test/host/skill-block-shadow.test.mjs` | rank 250 对照用内联替身，未锁住 `SKILL_BLOCK_RANK` 必须小于全部官方档 |
| K | 多处 Low | 校验与文案两处重复；provider 重复求值 / `scopes` 用 Map 只读 `has` / `'none'` 分支不可达 / `get()` 缺显式守卫；`rewatch` 隐式 TDZ；`invalidateCatalog` 把清单缓存与注册表缓存绑定失效；provider `list` 每次重扫并读全文；导入输入框未提示「绝对路径」；`'skillBlocked' in fields` 恒真；测试注释与断言不符；浏览器用例 `skip` 无原因；失败用例未验证恢复路径；fixture 残留降级变量与过期注释；`skills-scan` 与 `skills-catalog` 重复覆盖 |

## 范围与不变量

- 不改宿主源码；不重启运行中的 DSH；不动真实技能根里的 87 个技能实体。
- 状态文件格式（v3）不变；端点集合不变；影子机制（rank 0）不变。
- 写盘仍是「先完整生成再原子切换」；不得新增对用户文件的清理动作。
- 测试从 `D:/AI/workspase/_temp` 发起，隔离临时 `DSH_HOME`，结束后清理。
- 每处修复先能失败，再改实现。

## Wave 1：数据与正确性

<task type="auto">
  <name>T1：目录导入覆盖不再永久删除（A）</name>
  <files>src/host/skills-import.ts、src/runtime/settings-bridge.ts、src/client/**、test/host/skills-import.test.mjs</files>
  <action>覆盖同名技能时把旧目录移入 `<根>/.system/prompt-tool/.trash/<name>-<rand>/`（与 `deleteSkill` 同一回收站，附 `record.json` 记录来源与时间），而不是 rename 到暂存目录后 `rmSync`；导入结果区分 `created` 与 `overwritten` 数量，界面成功提示如实说明覆盖了几个。</action>
  <verify>覆盖导入后旧内容能在回收站恢复；失败回滚把备份放回原处且不丢数据；未覆盖时不产生回收站条目；`createSkill` 仍拒绝同名。</verify>
  <security>只操作用户技能根；回收站同样落在插件拥有的 `.system/prompt-tool` 下；不删除用户未确认的内容。</security>
  <done>覆盖导入可恢复，成功提示与回收站事实一致。</done>
</task>

<task type="auto">
  <name>T2：六类技能根全部纳入清单与候选失效（B + provider 性能）</name>
  <files>src/host/skills-scan.ts、src/index.ts、test/host/skills-scan.test.mjs、test/host/skills-refresh.test.mjs</files>
  <action>给扫描根加指纹（存在性 + mtimeMs，目录与标记文件两级），清单缓存条目保存指纹，命中时先比指纹再复用；provider 的引用目录扫描同样按指纹缓存。watcher 的静态目录补上用户技能根、`~/.agents/skills` 与内置根；项目根随 cwd 变化，用指纹覆盖而不是静态监听。</action>
  <verify>在用户根、项目根、agents 根、内置根里新建或删除技能后，下一次清单读取反映变化；引用目录内容变化后 provider 候选反映变化；无变化时不重扫（指纹相同）。</verify>
  <security>只读扫描，不写任何技能根；指纹只用于内存缓存。</security>
  <done>六类来源的手工增删都能反映到清单与候选。</done>
</task>

<task type="auto">
  <name>T3：状态读失败不回落空状态（C）</name>
  <files>src/host/skills-refresh.ts、src/index.ts、test/host/skills-refresh.test.mjs</files>
  <action>把「读状态 + 比较快照 + 失效缓存」整条装配抽成 `createSkillsReloader`（内部用 `readSkillsState` 的 `ok` 结果）：读取失败时保留上一份内存状态、只记一次节流告警，仍失效清单缓存；只有读取成功且快照变化才 accept 与重挂 watcher。</action>
  <verify>坏状态文件期间屏蔽表与引用目录保持上一份有效值；文件修好后恢复；同一故障窗口只告警一次；内容未变时不 accept。</verify>
  <security>不因读失败重置用户状态，也不覆盖磁盘上的坏文件（保持可人工修复）。</security>
  <done>瞬时坏文件不再清空内存状态。</done>
</task>

<task type="auto">
  <name>T4：屏蔽开关的忙期提示与计数（D）</name>
  <files>src/client/data/use-prompt-tool-store.ts、src/client/features/skills/SkillsPage.tsx、client tests</files>
  <action>忙期守卫改为「提示 + 忽略」而不是静默返回；`skillsBusy` 由单一布尔改为并发计数（进出各 ±1，界面 busy = 计数 > 0），避免一个操作的 finally 提前放开另一个操作仍在飞时的开关；接口注释写明 `false` 的语义。</action>
  <verify>忙期点击给出可读提示且不产生第二个请求；一个操作结束不会让另一个在飞操作期间的开关变成可点；失败后计数归零、开关可重试。</verify>
  <security>客户端仍不拼写盘路径。</security>
  <done>忙期行为对用户可见且不误放行。</done>
</task>

<task type="auto">
  <name>T5：三个页签覆盖完备（E）</name>
  <files>src/client/features/skills/skill-status.ts、src/client/locales.ts、client tests</files>
  <action>「已停用」页签口径改为「两端都不可用」：既包含插件两端屏蔽，也包含技能自身声明两端都不可调用；页签文案与徽章同步（徽章仍区分插件屏蔽与自身声明，不夸大插件作用）。</action>
  <verify>四类技能——两端可用、只一端可用、被插件两端屏蔽、自身声明两端关闭——各自至少落在一个页签里；三个页签计数相加等于全部；徽章文案与原因一致。</verify>
  <security>只改展示口径，不改屏蔽写入语义。</security>
  <done>不再有技能只出现在「全部」。</done>
</task>

<task type="auto">
  <name>T6：冗余载荷与双真相清理（F + G）</name>
  <files>src/shared/skills.ts、src/runtime/settings-bridge.ts、src/client/data/bridge-transport.ts、src/client/data/prompt-tool-view.ts、src/index.ts、test/shared/bridge-contract.test.mjs</files>
  <action>删除 `SKILL_SOURCES[].label`（来源标题唯一真相是 locale 字典）；删除 describe/bootstrap 里无消费者的 `skillsDirExists` 与 `skillBlocked` 下发及其透传与契约断言；`activeSkillsDirs` 保留。</action>
  <verify>typecheck 与 lint 全绿；grep 确认无残留引用；契约测试断言的服务端字段与客户端实际消费一致。</verify>
  <security>不删除仍被消费的字段。</security>
  <done>协议载荷与消费方一一对应。</done>
</task>

## Wave 2：测试证明力

<task type="auto">
  <name>T7：刷新装配的真实回归（H）</name>
  <files>test/host/skills-refresh.test.mjs、src/host/skills-refresh.ts</files>
  <action>用真实临时状态文件 + 真实 `createSkillsWatcher` + 真实 `createSkillsReloader` 组成装配测试：写文件后断言 accept/invalidate 被调用；坏文件断言不 accept 且告警一次；内容不变断言不 accept 但 invalidate 仍执行。断言改为可观察输出（传入的哨兵值、调用序列），不再用替身自写回的闭包变量。</action>
  <verify>把装配退回「快照未变提前 return」时该文件必须失败；把读失败改成 accept 默认状态时也必须失败。</verify>
  <security>测试使用隔离临时目录与临时状态文件，结束后清理。</security>
  <done>真装配有可失败的行为回归。</done>
</task>

<task type="auto">
  <name>T8：扫描与影子测试的缺口（I + J）</name>
  <files>test/host/skills-scan.test.mjs、test/host/skill-block-shadow.test.mjs、test/host/skills-catalog.test.mjs</files>
  <action>补 rank 并列用例（验证排序第二键）；补「未设 / 空串 `DSH_BUNDLED_SKILL_DIR` 时不产生 bundled 根」负向；补「插件候选 rank 等于 `SKILL_BLOCK_RANK` 且小于全部官方档」的断言，使有人把影子 rank 调大时会失败；消除与 `skills-catalog.test.mjs` 的重复覆盖。</action>
  <verify>每条新断言在人为破坏对应实现时失败。</verify>
  <security>不写真实用户目录。</security>
  <done>排序次键、bundled 负向与 rank 取值都有回归。</done>
</task>

<task type="auto">
  <name>T9：其余断言与测试卫生（K 的测试部分）</name>
  <files>test/client/prompt-tool-view.test.mjs、test/client/skill-status.test.mjs、test/client/ui-v2-page-smoke.test.mjs、test/fixtures/ui-v2-drafts.mjs</files>
  <action>`'skillBlocked' in fields` 恒真断言改为断言投影键集合；补文件夹引用失败后的恢复路径；浏览器用例的 `skip` 统一带原因；清理 fixture 降级变量与过期注释；修正与被测分支不符的注释与同义反复断言。</action>
  <verify>删除字段后相关断言仍成立；恢复路径用例在真浏览器下通过；无未使用变量。</verify>
  <security>不修改被测库代码。</security>
  <done>不再有恒真断言与误导性注释。</done>
</task>

## Wave 3：Low 生产项与文档

<task type="auto">
  <name>T10：实现细节收敛（K 的生产部分）</name>
  <files>src/host/skills-import.ts、src/runtime/settings-bridge.ts、src/host/skills-provider.ts、src/index.ts</files>
  <action>导出单一 `assertImportableSource`（绝对路径 + 非空 + 统一文案）供端点复用，去掉两处重复校验与不一致措辞；provider 一次取值 `deps.blocked()`、用 Set 做屏蔽名判定、把已算 scope 传入候选构造并注释 `'none'` 分支的防御性；`get()` 增加 `candidate.path === undefined` 显式守卫；`rewatch` 闭包改为在 watcher 初始化后装配或加注释声明触发时机；把「失效清单缓存」与「失效官方注册表缓存」拆成两个动作，引用目录的文件写入只失效清单。</action>
  <verify>端点与实现层返回同一文案；影子候选 `get()` 显式返回 undefined；引用目录写入不再触发官方 provider 重扫；typecheck / lint 全绿。</verify>
  <security>校验只收紧不放宽；不新增写盘。</security>
  <done>重复逻辑、隐式不变量与过度失效都消除。</done>
</task>

<task type="auto">
  <name>T11：界面文案与文档同步</name>
  <files>src/client/locales.ts、docs/skills-management.md、CHANGELOG.md、README.md、PLAN.md</files>
  <action>导入输入框的 placeholder 与 aria 补「绝对路径」提示（中英同步）；文档补充覆盖导入进回收站、六类技能根指纹失效、读失败保留状态、页签新口径；CHANGELOG 记本轮行为变化。</action>
  <verify>中英字典键成对；文档描述与实现一致，路径与命令有效。</verify>
  <security>文档不夸大行为。</security>
  <done>界面提示与文档同实现一致。</done>
</task>

## Wave 4：门禁与交付

<task type="auto">
  <name>T12：完整门禁与提交</name>
  <files>PLAN.md、CHANGELOG.md</files>
  <action>运行 typecheck / lint / test / build / verify:host / git diff --check；中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志；标注需用户重启 DSH。</action>
  <verify>全部门禁通过；暂存只含本轮文件；文档与现实一致。</verify>
  <security>不停止 DSH；不提交 `.ai-memory`。</security>
  <done>修复交付完成。</done>
</task>

## 回滚

- 代码回滚：`git revert` 本轮提交即可回到 `5bc6af3`。
- 行为回滚：T1 的回收站改动若误伤，只需把覆盖路径改回备份切换；T5 的页签口径改动只影响展示筛选。
- 数据：本轮不迁移、不改状态文件格式；真实技能根 87 个实体与 0 链接的布局不变。

## Task Summary 与状态

- 当前：T1–T12 全部完成并验证。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` 1017/1017 ✓ / `build` ✓ / `verify:host` ✓ / `git diff --check` ✓。

### 执行记录

- **T1（A）**：`importFiles` 覆盖前把旧技能移入 `<根>/.system/prompt-tool/.trash/`（`origin: import-overwrite`），
  失败回滚从回收站放回原处并清理空容器；成功返回 `overwritten` 计数，store 与技能页提示如实说明覆盖数量。
- **T2（B + provider 性能）**：新增 `rootsFingerprint`（各根下技能目录 + `SKILL.md` 的 mtime），清单缓存条目改为
  `{fingerprint, entries}`、命中前先比指纹；引用目录候选同样按指纹缓存。watcher 监听从「状态目录 + 引用文件夹」
  扩到再加用户技能根、用户 agents 根与内置根；项目根随 cwd 变化，由指纹兜住。
- **T3（C）**：装配抽成 `createSkillsReloader`（替换纯策略的 `createSkillsRefresh`）：读盘失败保留上一份内存状态、
  同一故障窗口只告警一次、修好后自动退出降级；成功且快照变化才 accept 与重挂 watcher。
- **T4（D）**：`skillsBusy` 改为并发计数（`beginSkillWrite`/`endSkillWrite`），忙期点击给出「正在保存」提示而不再静默丢弃；
  接口注释写明 `false` 的两种来源。
- **T5（E）**：新增 `skillUnavailable`，页签收「两端都不可用」（插件两端屏蔽 + 技能自身声明两端关闭），
  无效技能仍走自己的原因展示；页签文案改为「两端不可用 / Unavailable」。
- **T6（F + G）**：删除 `SKILL_SOURCES[].label`（来源标题唯一真相是字典）、`skillsDirExists`（响应顶层、
  客户端类型/透传与 settings 字段一并删除）与 describe 的 `skillBlocked` 下发；契约测试改为断言仍被消费的字段。
- **T7（H）**：`skills-refresh.test.mjs` 重写为真实状态文件 + 真实 `createSkillsWatcher` + 真实 reloader 的装配回归：
  状态变化、状态未变（引用目录事件）、坏文件降级与恢复、watcher 端到端四条；断言落在 accept 收到的状态与各依赖调用次数上。
- **T8（I + J）**：补 rank 并列（id 次序、输入顺序无关）、未配置内置根的负向、影子候选 rank 装配（等于
  `SKILL_BLOCK_RANK` 且小于最低官方档）三条回归；`skills-catalog` 与 `skills-scan` 的分工写进注释。
- **T9（K 的测试部分）**：`'skillBlocked' in fields` 恒真断言改为字段集合不随 settings 变化的真断言；
  文件夹引用失败后补恢复路径用例；三条浏览器用例统一 `skip` 原因；fixture 的 `blockedSkills` 内联为局部数组。
- **T10（K 的生产部分）**：导出 `assertImportableSource` 供端点复用（拒绝文案只有一份，空串与相对路径分别有明确理由）；
  provider 一次取值屏蔽记录、用 Set 判重、`get()` 显式拒绝无 path 的候选并注释 `'none'` 分支；watcher 先建、
  回调用可选链访问 reloader，消除隐式 TDZ；失效拆成「清单缓存」与「候选缓存」，普通文件事件不再让官方提供者全量重扫。
- **T11**：导入输入框的 aria 与 placeholder 补「绝对路径」（中英同步）；`docs/skills-management.md` 与 CHANGELOG 同步本轮行为。

[✔] Wave 1 / T1：导入覆盖进回收站
[✔] Wave 1 / T2：六类技能根指纹失效
[✔] Wave 1 / T3：状态读失败保留内存状态
[✔] Wave 1 / T4：忙期提示与计数
[✔] Wave 1 / T5：页签覆盖完备
[✔] Wave 1 / T6：冗余载荷与双真相清理
[✔] Wave 2 / T7：刷新装配真实回归
[✔] Wave 2 / T8：扫描与影子测试缺口
[✔] Wave 2 / T9：断言与测试卫生
[✔] Wave 3 / T10：实现细节收敛
[✔] Wave 3 / T11：文案与文档同步
[✔] Wave 4 / T12：门禁与提交
