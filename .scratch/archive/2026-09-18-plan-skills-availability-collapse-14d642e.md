# 技能可用状态收敛为「生效 / 遮蔽」，状态文案只报仍可用的一端

## 需求与授权

- 2026-09-18 用户在技能页逐轮实测后给出原话序列：「技能注册状态全部失败显示 [当前会话未注册]」→「还是显示的 archify / 400 / 当前会话未注册」→「新会话还是旧会话全都显示的未注册…400 为来源优先级」→「现在显示 0 / 会话状态未确认」→「状态显示正常了，但是关闭模型端或用户端时应该显示可用端 而不是被禁用端」→「这两项状态不再需要，直接移除相关代码」→「保留 模型 用户的 可调用状态」。
- 起始基线：`dev@14d642e`，起始工作树干净。
- 本轮范围（用户直接授权，含实施）：
  1. 只关一端时报告**仍可用**的那一端，而不是复述被关掉的那一端；
  2. 彻底删除会话注册状态 `unregistered`（「当前会话未注册」）与 `unknown`（「会话状态未确认」）及其类型、分支、文案与投影降级；
  3. **保留** frontmatter 两端的可调用状态：`可调用：模型/用户`、`可调用：用户`、`可调用：模型`，以及两端皆关的 `已停用`、无效的 `无效`、遮蔽的 `已被遮蔽`。
- 明确不做：不改写技能文件的调用策略语义，不放宽 bridge 写通道白名单，不重启运行中的 DSH。

## 审查结论

本轮问题的共同根因是同一处：**注册表被当成否决权使用**——观测不到就判「未注册」，观测不完整就降级成「未确认」。参照实现 `dsh-web` 的 `dsh-skill-explorer/src/collect.ts`（`collectSkills`）以文件系统扫描为唯一事实源、注册表只补充同名遮蔽结论，本仓库 `74dd3fc` 引入 `availability` 时偏离了该口径。

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| H1 | 只关一端时状态行复述被关掉的那一端，读起来像技能坏了 | `src/client/features/skills/skill-status.ts`（`skillStatusLabel`） | high |
| H2 | 注册表读不到／没观测到 → 整页「当前会话未注册」 | `src/host/skills-scan.ts`（`withSkillWinners`）、`skills-provider.ts`、`settings-bridge.ts` | high |
| H3 | 快照不完整 → 条目降级「未确认」，两个页签计数归零 | `src/host/skills-runtime.ts`、`src/client/data/prompt-tool-view.ts` | high |
| M4 | 故障期间为掩盖症状引入 `includeDefaultRoots: true`，破坏「只报引用目录」的 provider 语义 | `src/host/skills-provider.ts` | medium |

决定性证据：

- `git show 74dd3fc^:src/host/skills-scan.ts` 无 `availability` 字段，`74dd3fc` 才引入 `availability` 与否决语义——「未注册／未确认」是重构引入的回归，不是既有设计。
- 技能清单实测 93 条全部 `source=user-dsh`、`rank=400`、`valid=true`、两端可调用，不存在真正未注册的条目，整页红字纯属判定错误。
- `includeDefaultRoots: true` 会让官方默认根（含 `archify`）混入引用 provider，与「只报引用目录」冲突，由既有回归当场拦下并回退。

## 影响面、依赖与护栏

- 调用链：`SkillRegistry.snapshot({cwd, scope})` → `src/host/skills-runtime.ts`（`withGlobalSkillFallback`）→ `src/host/skills-scan.ts`（`withSkillWinners`）→ `src/runtime/settings-bridge.ts`（`skillsList`／`skillPolicy`）→ `src/client/data/prompt-tool-view.ts` → `skill-status.ts` → `SkillsPage.tsx`。
- 顺序：状态类型先收敛（`src/shared/skills.ts`），再同步 host 投影、client 投影、文案与页面，最后跟进断言。同文件的多处改动合并为一个任务串行。
- 硬约束：`availability` 只保留 `'active' | 'shadowed'`；只有注册表**明确指认**胜出路径才写 `shadowed`，其余一律 `active`；`winnerId` 只随 `shadowed` 出现。
- 护栏：`complete` 只表达观测完整性，不参与条目状态；bridge 端点白名单、类型与大小校验不变；不放宽 provider 的 `includeDefaultRoots: false`；测试从隔离 cwd 与临时 `DSH_HOME` 执行。

## Wave 1：状态类型与宿主投影

<task type="auto">
  <name>T1：把 availability 收敛成两态并去掉否决路径</name>
  <files>src/shared/skills.ts、src/host/skills-scan.ts、src/host/skills-runtime.ts、src/host/skills-provider.ts</files>
  <action>把 `availability` 收窄为 `'active' | 'shadowed'`；`catalogFromScan` 不再预置状态；`withSkillWinners(entries, resolved)` 去掉 `complete` 参数，未命中胜出路径即 `active`，命中即 `shadowed`；`skills-provider.ts` 恢复 `includeDefaultRoots: false` 并写明「注册表只补充」的语义。</action>
  <verify>`grep -r "unregistered\|'unknown'" src/` 无残留；技能页在注册表返回空视图时仍列出全部技能且页签计数非零。</verify>
  <security>不涉及，原因：只改内存投影与类型，不触碰外部输入、写盘或权限路径。</security>
  <done>投影层不再有把观测缺失判成不可用的分支。</done>
</task>

<task type="auto">
  <name>T2：同步 host 侧两处调用点</name>
  <files>src/runtime/settings-bridge.ts</files>
  <action>把 `skillsList` 与 `skillPolicy` 里的 `withSkillWinners` 调用改为两参形态，`complete` 继续由 `view.complete` 单独承载；注册表读取失败时仍返回可扫描资产并标 `complete=false`。</action>
  <verify>`pnpm typecheck` exit 0；`skills-framework-bridge.test.mjs` 的「注册表读取失败」用例断言条目仍为 `active` 且 `complete=false`。</verify>
  <security>读侧放宽、写侧不变：`skillPolicy` 的路径白名单、`SKILL.md` 文件名校验与请求体上限保持原样，注册表失败不转化为写授权。</security>
  <done>宿主投影与新的两态模型一致，typecheck 干净。</done>
</task>

## Wave 2：客户端投影与文案

<task type="auto">
  <name>T3：客户端投影归一，状态判定与文案只报可用端</name>
  <files>src/client/data/prompt-tool-view.ts、src/client/features/skills/skill-status.ts、src/client/features/skills/SkillsPage.tsx、src/client/locales.ts</file>
  <action>投影层把非 `shadowed` 的 availability 一律归一为 `active`；`skillShadowed` 只认 `'shadowed'`；`skillEnabled = valid && !shadowed && (modelInvocable || userInvocable)`；删除 `unregistered`／`unknown` 的文案分支与对应 dict 键；只关一端时列出仍可用的那一端；空态标题不再依赖 `skills.status.unknown`。</action>
  <verify>`skill-status.test.mjs` 覆盖两端、只关模型端、只关用户端、两端皆关、无效、遮蔽六种文案；`grep "skills.status.unregistered\|skills.status.unknown" src/` 无残留且 `zh()` 取键失败即抛错。</verify>
  <security>不涉及，原因：只改前端投影与文案，不新增写操作，不触碰 bridge 校验。</security>
  <done>页面状态只由文件声明与遮蔽事实决定，文案回答「现在还能怎么用」。</done>
</task>

<task type="auto">
  <name>T4：同步 TUI 同义文案</name>
  <files>src/runtime/tui.ts</files>
  <action>把无效技能的 `未注册:<原因>` 改为 `无效:<原因>`，与 `skills.status.invalid` 的措辞一致，避免与已删除的会话注册状态同名。</action>
  <verify>TUI 启停列表对 `valid=false` 条目显示 `[无效:…]`，对有效条目显示模型端可调用性。</verify>
  <security>不涉及，原因：只改终端渲染字符串，不触碰输入、写盘或权限路径。</security>
  <done>仓库内不再有与已删除状态同名的用户可见文案。</done>
</task>

## Wave 3：断言、文档与交付

<task type="auto">
  <name>T5：跟进断言并同步权威文档</name>
  <files>test/client/{skill-status,prompt-tool-view,ui-v2-page-smoke}.test.mjs、test/host/{skills-scan,skills-catalog,skills-runtime,skills-framework-bridge}.test.mjs、docs/skills-management.md</file>
  <action>把断言里的 `unknown`／`unregistered` 期望改为「注册表没有信息即按文件声明为事实（`active`）」，删除「未注册或观测未知的技能不会声称会话可调用」，改为「注册表缺乏观测不否认可扫描到的技能」；投影层新增旧载荷归一断言；`skills-management.md` 写明注册表只补充、不否决。</action>
  <verify>断言改的是**行为口径**而非仅改字面：每条都说明注册表缺席/不完整时条目仍 `active`；`docs/skills-management.md` 的清单与页签两节不再提「未注册／未确认」。</verify>
  <security>不涉及，原因：测试用隔离临时目录与临时 `DSH_HOME`，文档不承载秘密。</security>
  <done>测试与文档口径与本轮语义一致，无残留旧状态名。</done>
</task>

<task type="auto">
  <name>T6：门禁、记忆与推送</name>
  <files>测试套件、.ai-memory/20260918/daily.md、本 PLAN</files>
  <action>跑 typecheck／lint／完整 test／build／diff --check；回填本 PLAN 的 `## 状态` 与 `## 验收记录`；按「写后即记」追加当日 `.ai-memory`；只暂存本轮文件后提交推送 `origin/dev`。</action>
  <verify>四道门禁全绿并留输出；提交只含本轮文件；推送后 `origin/dev` 指向该提交。</verify>
  <security>不重启运行中的 DSH，只刷新页面；本地记忆不入库。</security>
  <done>门禁与推送均有留档，交付 SHA 与分支明确。</done>
</task>

## 回滚与检查点

- 回滚：本轮只改投影、类型、文案、断言与文档，无数据迁移，`git revert` 对应提交即可；技能文件与用户数据不受影响。
- 检查点：Wave 边界把中断摘要写入 `.scratch/`，不把流程产物放 `.ai-memory`。

## 状态

- [✔] Wave 1 / T1：`availability` 收敛为 `active | shadowed`；`withSkillWinners` 改为两参、不再否决；provider 恢复 `includeDefaultRoots: false`。
- [✔] Wave 1 / T2：`settings-bridge.ts:594`、`:597` 两处调用点同步，注册表失败仍返回 `active` 资产并标 `complete=false`。
- [✔] Wave 2 / T3：投影归一、六种状态文案、四个 dict 键删除、空态标题去条件化。
- [✔] Wave 2 / T4：TUI 的 `未注册:` 改为 `无效:`。
- [✔] Wave 3 / T5：8 个用例跟进（1 个改写、7 个改期望），`docs/skills-management.md` 两节同步。
- [✔] Wave 3 / T6：typecheck／lint／1129 项测试／build／diff --check 全绿。
- [ ] **UI 实测**：需用户重启或刷新 DSH 后确认技能页状态行——待用户执行。

## 验收记录

- `pnpm typecheck`：exit 0（修 `withSkillWinners` 两处残留参数前为 2 处报错，正是本轮签名变更漏改的调用点）。
- `pnpm lint`：exit 0。
- `pnpm test`：**1129/1129 通过，0 失败 0 跳过**；与移除前同数（删除 1 例、新增 1 例）。
- `pnpm build`：exit 0。`git diff --check`：exit 0。
- 失败定位记录：中途 2 个用例红——`skills-catalog.test.mjs` 的扫描层字段清单仍期望 `availability`（改为断言扫描层不产生该字段），`skills-runtime.test.mjs` 的 `every(active)` 忽略了同层被遮蔽条目（改断言虚拟条目自身）。
- **未验证项**：真实 DSH 中的技能页实测。运行中的 dsh 未重启，改由用户刷新页面后确认。

## 实施取舍与已知边界

- 只关一端时报「仍可用的那一端」而非被关掉的那一端：状态行要回答「现在还能怎么用」，复述被关掉的一端会让一端仍可用的技能读起来像坏了。
- 删除「未注册／未确认」的理由不只是文案难看：它们把**观测缺失**说成**不可用**，直接违反「文件系统扫描是唯一事实源」。保留它们就要保留一套与参照实现相反的判定。
- `complete` 字段保留：它表达观测完整性，供页面提示「可能不全」，不参与条目可用性判定。
- 本轮为纯前端投影与文案改动，`lib/` 等构建产物由 `pnpm build` 重新生成；宿主侧行为在重启 DSH 后生效。
