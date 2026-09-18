# 技能停用改为文件层调用策略（P0 修复）

## 授权与基线

- 用户指令（2026-09-18）：审查确认 P0——「注册层屏蔽」在真实装配下失效（影子候选在全局层，被预设层官方候选按
  「最近层无视优先级胜出」覆盖），已在运行中的 DSH 用临时探针技能真机坐实。用户选定**方向 B**：改回文件层
  （改写技能 `SKILL.md` 的 frontmatter），与 dsh-web 技能中心同机制；**本轮只修 P0**。
- 经互动提问确认的三项取舍：①**所有来源**的技能都可停用（写各自的 `SKILL.md`；只读目标或符号链接目标失败时
  如实报错）；②恢复写**显式值**（`disable-model-invocation: false` / `user-invocable: true`）；③v3 状态文件里的
  `blocked` 记录**直接弃用**（本机无存量），状态版本升 4。
- 代码基线：dev@`4eca311`（工作树仅新增未跟踪的审查报告目录）；旧 PLAN 原文归档
  [plan-character-modules-4eca311-20260918.md](.scratch/prompt-tool-framework/archive/plan-character-modules-4eca311-20260918.md)
  （SHA-256 与基线 `PLAN.md` 逐字节一致）。审查结论见
  [2026-09-18-skills-management-review.md](.scratch/prompt-tool-framework/reviews/2026-09-18-skills-management-review.md)。
- 本轮范围：`src/shared/skills.ts`、`src/shared/bridge-contract.ts`、`src/host/skills-config.ts`、
  `src/host/skills-policy.ts`（新）、`src/host/skills-provider.ts`、`src/host/skills-scan.ts`、`src/index.ts`、
  `src/runtime/settings-bridge.ts`、`src/client/**`（技能页 / store / 状态纯逻辑）、`test/**`（技能相关）、
  `docs/skills-management.md`、`CHANGELOG.md`、`README.md`。
- **不在本轮范围**：P1 迁移缺口（旧 `config.yml` 的 `order`/`rankBase`、旧 `SKILL.md.disabled`）、P1 清单盲区
  （注册表来源 / 扁平 `.md` / 符号链接技能）、P2 对照能力（多工作区、项目根创建、远程配对放行、回收站恢复入口）、
  与 dsh-web 同装时的调用策略归属。

## 事实依据（读源码得到，作为不变量）

1. 官方 frontmatter 契约：`disable-model-invocation: true` 把技能排除出模型目录与 loader，`user-invocable: false`
   排除用户命令，缺省即可调用（`deepseek-harness/packages/skill/skill-filesystem/README.zh.md:36-40`）。
2. 文件层写入**跨层天然有效**：官方 provider 在每次 `list()` 重新解析 frontmatter（同文 `:42`、`:110`），预设层与
   全局层读的是同一批文件，不存在「层覆盖」问题。
3. 现有 `SkillCatalogEntry.path` 已是标记文件绝对路径（`src/host/skills-scan.ts:194`），可直接作为写入目标与身份校验依据。
4. 仓库硬约束：YAML 修改必须走 Document API 保留注释与未知字段，写盘先暂存再原子 rename（`AGENTS.md`）。
5. 注册层影子机制的全部落点都在本轮改造范围内：`SKILL_BLOCK_RANK`、`blockScopeOf`、`blockRecordFor`、
   `blockedCandidate`、`createSkillsProvider({ blocked })`、`/skill-block` 端点与客户端的 `blocked*` 判定。
6. `folders`（引用目录）与状态文件本身仍然需要：引用目录不在官方六类根里，靠插件 watcher + 指纹失效
   （`src/host/skills-refresh.ts`），与调用策略无关，原样保留。

## 目标语义

| 操作 | 文件效果（唯一真相在技能文件里） |
|---|---|
| 模型端停用 | `disable-model-invocation: true` |
| 模型端恢复 | `disable-model-invocation: false` |
| 用户端停用 | `user-invocable: false` |
| 用户端恢复 | `user-invocable: true` |
| 完全停用 | 两个字段都写停用值 |
| 状态文件 v4 | 只保留 `folders`；`blocked` 弃用（读到 v3 时接受并升级，不迁移数据） |

写入规则：只用 Document API 改这两个键；保留注释、未知字段、其余键与正文；**内容无变化不落盘**；原子写
（同目录暂存文件 + rename）；失败时原文件不变。

拒绝与报错（如实、不静默）：缺 frontmatter、frontmatter 不是映射、含 YAML 别名、目标是符号链接、目标只读或写入失败。

身份校验：端点要求 `{ name, path, scope }`；服务端重新扫描清单，必须存在**同名且同路径**的有效条目，否则 409，
防止陈旧界面把操作落到被替换过的同名技能上。

## Wave 1：共享契约与状态文件

<task type="auto">
  <name>T1：共享契约改为调用策略事实</name>
  <files>src/shared/skills.ts</files>
  <action>删除 `BlockedSkill`、`blockScopeOf`、`blockRecordFor`、`SKILL_BLOCK_RANK` 与 `SkillCatalogEntry` 上的
  `blocked`/`blockedModel`/`blockedUser`；`SkillsState` 只保留 `version` + `folders`；`SkillBlockScope` 重命名语义为
  「目标调用策略范围」（`none`/`model`/`user`/`all`，含义不变：分别表示该端不可调用），供端点与 UI 复用。</action>
  <verify>类型收敛后编译期能指出所有旧落点；不再存在任何「影子候选优先级」常量。</verify>
  <security>契约里不再暴露「按名字全局屏蔽」这种跨来源写操作。</security>
  <done>调用策略只有一处真相：技能文件的 frontmatter。</done>
</task>

<task type="auto">
  <name>T2：状态文件升到 v4</name>
  <files>src/host/skills-config.ts</files>
  <action>`SKILLS_STATE_VERSION = 4`；`validateSkillsState` 接受 v3（丢弃 `blocked`，保留 `folders`）与 v4，其余版本拒绝；
  写入时删除 `blocked` 键；`folders` 的校验、注释保留、内容无变化不落盘、版本冲突与暂存文件清理全部沿用。</action>
  <verify>v3 文件读入后 folders 保留、blocked 被忽略；再次写入后文件里没有 blocked 且 version 为 4；损坏文件仍被拒绝且不覆盖。</verify>
  <security>非法状态不获得写入权限；不覆盖损坏文件。</security>
  <done>旧版本可读、新版本可写、无数据迁移风险。</done>
</task>

## Wave 2：文件写入与装配

<task type="auto">
  <name>T3：技能调用策略写入模块</name>
  <files>src/host/skills-policy.ts（新）</files>
  <action>导出 `setSkillInvocation(file, effects)`：读文件 → 提取 frontmatter（容忍 BOM、CRLF）→ `parseDocument` 且必须是映射、
  拒绝别名 → 按需 `doc.set('disable-model-invocation', …)` / `doc.set('user-invocable', …)` → 内容无变化直接返回成功 →
  否则同目录暂存文件（`flag:'wx'`）+ `renameSync` 原子替换 → 失败清理暂存文件并返回结构化失败。
  另外导出 `scopeEffects(scope)`（范围 → 两个字段的写入意图）与 `readSkillInvocation(file)`（供清单/测试复用）。
  拒绝条件：路径非绝对、basename 不是 `SKILL.md`、目标不存在、`lstat` 是符号链接、frontmatter 缺失或非法。</action>
  <verify>注释、未知字段、正文、其余键逐字保留；两端字段互不影响；恢复写显式值；无变化时 mtime 不变。</verify>
  <security>只写调用方给出的、已由清单校验过的技能文件；不做目录遍历、不建目录、不删文件。</security>
  <done>文件层写入具备与状态文件同级的原子性与可诊断性。</done>
</task>

<task type="auto">
  <name>T4：装配与身份校验</name>
  <files>src/index.ts</files>
  <action>技能提供方只保留「引用目录候选」（删除影子候选与 `blocked` 依赖）；新增 `setSkillPolicy(name, path, scope)`：
  重新 `listSkills(cwd)` 校验同名同路径且条目有效 → 调 `setSkillInvocation` → 成功后失效清单缓存与官方 registry 缓存 →
  返回统一结果（含失败原因）。删除 `blockedScopes`/`setSkillBlocked`/状态文件里的 blocked 读写。</action>
  <verify>陈旧 path 被拒绝（409 语义）；写入成功后清单与模型侧候选同时反映新策略。</verify>
  <security>写入目标必须来自服务端自己的扫描结果，客户端不能凭 path 自授权。</security>
  <done>停用不再经过注册层，任何预设装配下都生效。</done>
</task>

<task type="auto">
  <name>T5：端点与契约改造</name>
  <files>src/shared/bridge-contract.ts、src/runtime/settings-bridge.ts</files>
  <action>`skillBlock` 端点改为 `skillPolicy`（`/skill-policy`，请求 `{ name, path, scope }`，响应 `{ skills }`）；
  `/skills-list`、`/skills-folders` 响应删除 `blocked` 字段；端点沿用回环 / Host / Origin 守卫与请求体上限；
  409 用于身份校验失败，400 用于参数与写入拒绝。</action>
  <verify>契约类型断言（请求/响应映射与端点键集合一致）通过；真实 handler 写盘回归通过。</verify>
  <security>成功/失败载荷保持统一包装；不在错误消息里泄露磁盘路径之外的信息。</security>
  <done>桥契约与文件层语义一致。</done>
</task>

## Wave 3：客户端语义

<task type="auto">
  <name>T6：store 调用改造</name>
  <files>src/client/data/use-prompt-tool-store.ts、src/client/data/host-api.ts（如涉及）</files>
  <action>`setSkillBlocked(name, scope)` 改为 `setSkillPolicy(name, path, scope)`；把服务端失败原因转成用户可见通知；
  成功后重新拉取清单。</action>
  <verify>失败路径有可见提示且不清空列表。</verify>
  <security>不新增客户端状态来源，仍以服务端清单为准。</security>
  <done>客户端只表达意图，不做本地策略推断。</done>
</task>

<task type="auto">
  <name>T7：状态纯逻辑与页面文案</name>
  <files>src/client/features/skills/skill-status.ts、SkillRow.tsx、SkillsPage.tsx、src/client/locales.ts</files>
  <action>可用性判定改为只看 frontmatter 事实（`valid && modelInvocable` / `valid && userInvocable`）；`blockScopeFor` /
  `scopeAfterToggle` 保留但输入改为当前可调用状态；徽章与开关提示改为「改写该技能 SKILL.md 的 frontmatter，不改正文」；
  删除按钮口径不变（仅用户根）；无效技能与符号链接技能禁用开关并显示原因。</action>
  <verify>页签计数、徽章与开关往返（none→all→model→user→none）在纯逻辑单测下自洽。</verify>
  <security>不把「已停用」表达成插件的私有状态，文案如实说明是文件声明。</security>
  <done>界面事实与磁盘事实一致。</done>
</task>

## Wave 4：回归测试

<task type="auto">
  <name>T8：文件写入行为回归</name>
  <files>test/host/skills-policy.test.mjs（新）</files>
  <action>覆盖：①只写目标键，注释 / 未知字段 / 其余键 / 正文逐字保留；②两端独立；③恢复写显式值；④无变化不落盘（mtime 不变）；
  ⑤缺 frontmatter、非映射、含别名、非绝对路径、basename 不符、目标不存在、符号链接目标各自被拒绝且文件不变；
  ⑥写入失败（只读文件 / 目录占位）不留暂存文件、原文件不变；⑦CRLF 与 BOM 文件可写且正文字节保留。</action>
  <verify>去掉「只写目标键」改为整段重写时用例①必红；去掉「无变化不落盘」时用例④必红。</verify>
  <security>测试只用临时目录与临时 DSH_HOME，结束后清理。</security>
  <done>写入边界有可失败的确定性回归。</done>
</task>

<task type="auto">
  <name>T9：端到端与既有用例改造</name>
  <files>test/host/settings-bridge.test.mjs、skills-config.test.mjs、skills-catalog.test.mjs、skills-scan.test.mjs、
  skills-refresh.test.mjs、skills-import.test.mjs、skills-actions.test.mjs、skills-migration.test.mjs、
  skill-block-shadow.test.mjs（删）→ skill-policy-registry.test.mjs（新）</files>
  <action>删除影子候选相关用例；新增端到端：真实 `SkillRegistry` + 官方文件提供方替身，写入 frontmatter 后重新
  `list()`，断言被停用的一端不可调用、另一端仍可调用，并断言提供方未因同名影子而改变来源；端点用例改为
  `{name, path, scope}` 与 409 身份校验；状态文件用例改为 v4 语义。</action>
  <verify>把写入换成「只改状态文件」时端到端用例必红；把身份校验去掉时 409 用例必红。</verify>
  <security>不依赖共享状态或执行顺序，临时目录隔离。</security>
  <done>「停用在任何装配下都生效」有行为证明。</done>
</task>

<task type="auto">
  <name>T10：客户端用例</name>
  <files>test/client/skill-status.test.mjs、test/client/ui-v2-page-smoke.test.mjs、test/fixtures/ui-v2-drafts.mjs</files>
  <action>状态纯逻辑改为 frontmatter 事实并补往返断言；页面冒烟改为新的开关语义与文案；fixture 去掉 blocked 字段。</action>
  <verify>把可用性判定换回旧的 blocked 字段时对应用例必红。</verify>
  <security>不引入新的浏览器依赖。</security>
  <done>界面行为有回归。</done>
</task>

## Wave 5：文档与交付

<task type="auto">
  <name>T11：文档同步</name>
  <files>docs/skills-management.md、CHANGELOG.md、README.md</files>
  <action>重写技能管理文档的第 2 节（停用＝改写 frontmatter）、第 3 节（状态文件 v4 只留引用目录）、第 5 节（与旧模型的关系，
  含「为什么放弃注册层屏蔽」的一句事实说明），新增调用策略与边界一节；CHANGELOG 记录行为变化与「屏蔽曾失效」的事实；
  README 技能管理条目改为文件层表述。</action>
  <verify>文档描述与实现逐条对得上；路径、命令、字段名可核验。</verify>
  <security>不夸大：写入边界、只读目标失败、与 dsh-web 的字段共用关系如实写明。</security>
  <done>文档不再描述已废弃的机制。</done>
</task>

<task type="auto">
  <name>T12：门禁、变异与提交</name>
  <files>PLAN.md、.ai-memory/</files>
  <action>typecheck / lint / test / build / git diff --check；对「只写目标键」与「身份校验」各做一组反向变异证明用例守得住；
  中文 Conventional Commit 推送 origin/dev；追加 `.ai-memory` 日志。</action>
  <verify>门禁全绿；变异各自精确红掉对应用例；暂存只含本轮文件。</verify>
  <security>不停止运行中的 DSH；`.ai-memory` 与 `.scratch` 不入库。</security>
  <done>本轮交付完成。</done>
</task>

## 回滚

- 代码：`git revert` 本轮提交即回到 `4eca311`（注册层屏蔽模型）。
- 数据：状态文件 v4 只少一个已弃用的 `blocked` 键（无数据损失）；技能文件上被写入的 `disable-model-invocation` /
  `user-invocable` 两个键可手工删除或改回，插件不再依赖它们之外的任何状态。
- 兼容：本轮写入的就是 dsh-web 技能中心使用的同一组字段，两者可互操作。

## Task Summary 与状态

- 当前：Wave 1–3 与 T11 已完成；Wave 4（测试改造）与 T12（门禁/变异/提交）进行中。

### 执行记录

- **T1（共享契约）**：`src/shared/skills.ts` 删除 `BlockedSkill` / `blockScopeOf` / `blockRecordFor` / `SKILL_BLOCK_RANK`
  与条目上的 `blocked` / `blockedModel` / `blockedUser`；`SkillsState` 只留 `version` + `folders`；新增
  `SkillPolicyScope`、`invocationForScope`、`scopeOfInvocation`；条目的 `modelInvocable` / `userInvocable` 成为唯一调用策略事实。
- **T2（状态文件 v4）**：`src/host/skills-config.ts` 升到 v4；`validateSkillsState` 接受缺失版本、v3（忽略 `blocked`
  且不校验其内容）与 v4；写入时 `doc.set('version', 4)` + `doc.delete('blocked')`，注释保留、内容无变化不落盘、
  版本冲突与暂存文件清理全部沿用。
- **T3（写入模块）**：新增 `src/host/skills-policy.ts`：`readSkillInvocation` / `setSkillInvocation`——只改目标键
  （已有驼峰键就地改写，两种写法都没有才新增官方连字符键），保留注释、未知字段、其余键与正文，内容无变化不落盘，
  同目录暂存 + rename 原子写，失败清理暂存文件；七类拒绝条件（非绝对路径、basename 不是 `SKILL.md`、不存在、
  符号链接、非普通文件、缺 frontmatter、非映射或含别名）。
- **T4（装配与身份校验）**：`src/index.ts` 的技能提供方只剩引用目录候选；新增
  `setSkillPolicy(name, path, scope, cwd?)`——按同一工作目录重扫清单并要求同名、同路径且有效，写入成功后失效清单
  与官方 registry 缓存；TUI 技能启停改为先按名查 `path` 再写入。
- **T5（端点与契约）**：`/skill-block` → `/skill-policy`（请求 `{ name, path, scope, sessionId? }`，响应 `{ skills }`），
  `skillsList` 响应去掉 `blocked`；参数缺失 400，身份校验失败或写入失败 409；`SkillsBridgeState` 与
  `BridgeRequestMap` / `BridgeValueMap` 同步（编译期覆盖断言通过）。
- **T6 / T7（客户端）**：store 的 `setSkillBlocked` → `setSkillPolicy`（带 `sessionId`，失败给出可见原因，忙期守卫保留）；
  `skill-status.ts` 改为只看 frontmatter 事实、`scopeAfterToggle` 按「该端当前是否可调用」取反；SkillRow 的开关
  `checked` 直接取可调用状态、无 `path` 或无效技能禁用写入；中英文案、README 与 `docs/ui-architecture.md` 描述同步。
- **T11（文档）**：`docs/skills-management.md` 重写（文件层调用策略、状态文件 v4、v2/v3/v4 对照表、写入边界、回归入口）；
  `CHANGELOG.md` 新增「技能停用改为文件层调用策略」；`README.md` 两处技能管理描述同步。

[✔] Wave 1 / T1：共享契约改为调用策略事实
[✔] Wave 1 / T2：状态文件升到 v4
[✔] Wave 2 / T3：技能调用策略写入模块
[✔] Wave 2 / T4：装配与身份校验
[✔] Wave 2 / T5：端点与契约改造
[✔] Wave 3 / T6：store 调用改造
[✔] Wave 3 / T7：状态纯逻辑与页面文案
[✔] Wave 4 / T8：文件写入行为回归
[✔] Wave 4 / T9：端到端与既有用例改造
[✔] Wave 4 / T10：客户端用例
[✔] Wave 5 / T11：文档同步
[✔] Wave 5 / T12：门禁、变异与提交

### Wave 4 / T12 执行记录

- **T8（写入回归）**：新增 `test/host/skills-policy.test.mjs`（11 条：只写目标键与逐字保留、两端独立真值表、
  显式值恢复、零写入（mtime + 内容双断言）、CRLF/BOM、九类拒绝条件、非绝对路径与 basename、目录与不存在、
  符号链接、底层写入失败与暂存文件清理、身份校验纯函数）。
- **T9（端到端与既有用例）**：新增 `test/host/skill-policy-e2e.test.mjs`（真实 `SkillRegistry` + 从磁盘读
  frontmatter 的官方提供方替身：写盘后重新 `list()` 断言两端可用性，并证明不存在影子候选）；删除
  `skill-block-shadow.test.mjs`；`skills-config` / `skills-catalog` / `skills-scan` / `settings-bridge` /
  `skills-refresh` / `shared/bridge-contract` / `host-publish-contract` 与各处 stub 形状全部改到 v4 语义。
- **T10（客户端用例）**：`skill-status`（纯逻辑 + 往返不变量）、`prompt-tool-view`（旧 blocked 字段不进投影）、
  `ui-v2-page-smoke`（`skill-policy` 载荷精确形状、开关与字段同步、两端停用才置灰、失败不乐观更新）、
  fixture 的 `skill-policy` stub（按 `invocationForScope` 改写条目并按 name+path 校验）。
- **T12（门禁与变异）**：见下。

### 反向变异验证（证明新用例守得住）

| 变异 | 期望失败 | 实测结果 |
|---|---|---|
| 写入时丢弃注释、按解析结果重写整段 frontmatter | 逐字保留用例 | **恰好 1 条红**（9/10 通过），还原后全绿 |
| 去掉模型端键的取反（把「可调用」当 `disable-model-invocation` 的值写） | 落盘真值与零写入用例 | **恰好 4 条红**（40/44 通过），还原后全绿 |
| 去掉身份校验的「陈旧分支」 | 身份校验用例 | **恰好 1 条红**（10/11 通过），还原后全绿 |

第三组变异第一次**没有变红**（当时身份校验写在 `index.ts` 闭包里，而端点测试用的是替身），于是把校验下移为
可直测的纯函数 `policyTarget`（`src/host/skills-policy.ts`）并补真实用例，再变异才精确变红——这是本轮唯一
因变异结果而改动产品代码的地方。

### 门禁结果

- `typecheck` ✓ / `lint` 0 警告 0 错误 ✓ / `build` ✓ / `verify:host`（官方包 47 个，失败 0）✓ /
  `git diff --check` ✓。
- `test`：**1044/1044 通过、0 失败**（上一轮记录的既有失败「等长改写 + 还原 mtime 的根指纹判据」在本轮
  测试改造中修掉：原断言用 `statSync().size`（字节）对比 `String.length`（UTF-16 码元），正文含中文时必然不等）。
- 提交：`4c51176`（39 个文件，+1930 / −990），已推送 `origin/dev`。

### 未做（明确不在本轮范围）

- P1：旧 `config.yml` 的 `order` / `rankBase` 迁移，旧 `SKILL.md.disabled` 的识别与告警。
- P1：清单盲区（注册表来源 / 扁平 `.md` / 符号链接技能「模型可见、界面不可见」）。
- P2：多工作区视图、项目根创建、远程配对放行、回收站恢复入口。
- 与 dsh-web 同装时的调用策略归属（两边现在写同一组字段、语义一致，但「谁拥有」尚未定义）。
