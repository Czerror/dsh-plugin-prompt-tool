# 2026-09-19-plan-engine-hook-parity-e0ea87b

## 需求与授权

- 授权原话（2026-09-19，本会话逐轮确认）：
  - 「偏离实例能否 使用ponytail-mode-tracker.js的hook模式纠正」
  - 「能否扩展引擎能力,使用dsh官方桥的所有白名单」
  - 「P2：一次补齐全部白名单」
  - 「先核实本项目 所有引擎能力」
  - 「扩 layer（声明式配置面）」
- 起始基线：`e0ea87b`（工作树干净，`.scratch/plan/` 无并发 PLAN）。
- 已确认范围：`promptConfigs` 新增三个声明式层 `turn-stop` / `subagent-start` / `subagent-end`，并给现有 `tool-pipeline`、`pre-step` 增加条件判定（`subject` + `match`）。
- 已确认取舍：**全部走 layer**（声明式配置面），不做插件行模块；不走 Claude Code hook 桥、不引入外部进程与 JSON hook 协议。

## 审查结论

判定依据：会话 `session-b7fa8b7a`（pt-standard 预设，18 turn / 406 step）的行为审计与仓库提交对账。

| # | 问题 | 位置与证据 | 严重度 | 本轮 |
|---|---|---|---|---|
| 1 | 审查产出物落错位 | 模型另建 `.scratch/reviews/` 报告（提交 `988d54a`，105 行），用户当轮质问后 `da809b7` + `0489179` 删除 575 行并入 PLAN | 中 | **修底座**（本轮条件判定使其可声明式拦截） |
| 2 | 症状补丁／根因迟到 | 技能「未注册」bug 前两轮改在非生效路径（`d65fdd9` +54/−4、`617a4ac` +43/−2，后者提交信息自认「上一版改错了位置」），第三轮 `5761953` 才落到机制层，共 5 轮返工 | 高 | 不修（需跨调用状态 + 启发式判据，误伤率高） |
| 3 | 未使用 `skipped:` 输出格式 | 254 条面向用户文本中 0 次命中；规则已在 system prompt 且实测在场 | 低 | 不修（非注入缺失） |

本轮修 1 的能力底座：引擎现有 `tool-pipeline` 只支持按工具名无条件 `allow`/`deny`/`ask`（`engine/layers.mjs` 的 `wireToolPipelines`），无法按路径或参数判定，因此「禁止写入 `.scratch/reviews/`」这类门无法表达。

核实到的事件面缺口（引擎已接 11 个扩展点，全引擎 `agent.steer()` 出现 0 次）：`agent/turn-stopping`、`subagent/start`、`subagent/end` 完全未接线。

## 影响面、依赖与护栏

- 影响模块：`engine/schema.mjs`（层白名单、字段矩阵、校验）、`engine/layers.mjs`（接线）、`engine/executor.mjs`（新层文本渲染）、`src/client/**`（表单与文案）、`test/**`、`docs/**`。
- 调用链：预设 YAML → `schema.mjs` 校验 → `layers.mjs#wireLayers` 接 DSH 扩展点 → 模型可见结果。
- 可复用底座：`engine/anchor-match.mjs`（`createAnchorMatcher`）、`engine/shared.mjs`（`validateConfig`/`parseToolNames`/`getService`/`keepDisposer`）、`engine/session-vars.mjs`（状态模式参考）。
- 硬约束与禁止项：
  - `turn-stop` **必须**内建不可通过配置关闭的续跑上限（官方桥在 `packages/hooks/hooks-claude-code/src/index.ts:268` 留了 `TODO(stop-loop-guard)`，上游本身没做）——无护栏不允许合入。
  - 新字段全部可选，缺省 = 现有行为；旧预设零回归。
  - `match` 校验 fail loud：未知 `logic`、非法 `/pattern/flags` 在挂载时抛错，不静默不命中。
  - `subagent-start` / `subagent-end` 只交付机制，**不带默认配置**。
  - 不手工编辑 `engine/compositions/**`（版本化分发快照）与 `engine/vendor/**`；`lib/` 是构建产物不手工编辑。
  - 不修改 DeepSeek Harness 源码仓库；不改运行中的 dsh / dsh web。
- 依赖顺序：Wave 1 是 Wave 2/3 的前置（共用 `subject`/`match` 判定）；Wave 4 依赖 Wave 1–3 的字段定稿。

## Wave 1：条件判定（tool-pipeline / pre-step）

<task type="auto">
  <name>T1：schema 增加 subject 与 match</name>
  <files>engine/schema.mjs</files>
  <action>新增字段定义与校验：`subject`（枚举 toolArgs | toolResult | userMessage | assistantText | subagentInfo）与 `match`（keys/secondaryKeys/logic/caseSensitive/wholeWords/useRegex）；把两者加入 `tool-pipeline`、`pre-step` 的字段能力矩阵；`getEngineMeta()` 自动带出供客户端渲染。</action>
  <verify>`node -e` 直接 import `engine/schema.mjs`，断言：未知 subject 抛错、未知 logic 抛错、非法 `/pattern/flags` 抛错、缺省 match 不抛错且行为与现状一致。</verify>
  <security>不涉及外部输入；校验在挂载期 fail loud，避免静默不命中导致「配了但没生效」。禁止使用 `eval` 或把配置当代码执行。</security>
  <done>schema 能表达并拒绝非法条件配置，旧配置解析结果逐字不变。</done>
</task>

<task type="auto">
  <name>T2：layers 接线条件判定</name>
  <files>engine/layers.mjs</files>
  <action>`wireToolPipelines` 在既有的工具名匹配之后增加 `subject` + `match` 判定：按 subject 取出待匹配文本，交给 `createAnchorMatcher` 判定，未命中即 `next()`。缺省 match 时保持现有无条件行为。</action>
  <verify>`test/engine/prompt-config-engine.test.mjs` 中断言：`toolNames:[write]` + `match.keys:['.scratch/reviews/']` 写该路径返回 `{kind:'deny'}`、写其他路径 `next()` 放行；post 侧 `subject: toolResult` 同样命中/未命中分离。</verify>
  <security>匹配对象来自工具参数与结果，属外部输入：键按字面或显式正则处理，禁止把键当代码；匹配失败走 `warnOnce` 并放行（fail open，不阻断正常工具链）。</security>
  <done>条件判定在 pre/post 两侧可用，缺省路径零回归。</done>
</task>

<task type="auto">
  <name>T3：条件判定回归测试</name>
  <files>test/engine/prompt-config-engine.test.mjs</files>
  <action>覆盖组合逻辑（any/all/not/notAny）、大小写、整词、正则键、多键副键，以及「无 match 的旧配置行为不变」。</action>
  <verify>`pnpm --dir <repo> test`（隔离 cwd）中该文件全绿；失败时记录断言与现场。</verify>
  <security>不涉及。</security>
  <done>条件判定的边界与回归均有可执行断言。</done>
</task>

## Wave 2：turn-stop 层（含死循环护栏）

<task type="auto">
  <name>T4：turn-stop 层接线</name>
  <files>engine/layers.mjs</files>
  <action>新增 `wireTurnStops`：监听 `agent/turn-stopping`，命中条件时用 `agent.steer(createUserMessage(...))` 强制续跑一步；内置不可配置关闭的上限——每轮最多 1 次、每会话最多 N 次（N 为引擎常量），达上限一律放行。</action>
  <verify>测试断言：命中一次后 `steer` 被调用恰好一次；连续命中达上限后不再调用且不抛错；未命中时 `steer` 零调用。</verify>
  <security>死循环是本节最大风险：上限必须在引擎内硬编码，不得暴露为 `params` 可关闭项；steer 文本只接受 `texts` 字面量，不做变量求值到可执行路径。</security>
  <done>Stop 层可用且有熔断证明。</done>
</task>

<task type="auto">
  <name>T5：turn-stop 上限证明测试</name>
  <files>test/engine/prompt-config-engine.test.mjs</files>
  <action>构造连续命中场景，断言续跑次数严格等于上限、之后永久放行；并断言未配置该层时 `agent/turn-stopping` 上无监听副作用。</action>
  <verify>该测试文件全绿；断言消息化输出续跑计数。</verify>
  <security>不涉及。</security>
  <done>死循环护栏有可执行证明。</done>
</task>

## Wave 3：subagent-start / subagent-end 层

<task type="auto">
  <name>T6：subagent 两事件接线</name>
  <files>engine/layers.mjs</files>
  <action>新增 `wireSubagentEvents`：`subagent/start` 命中时经 `ctx.get('agents')` 取子代理并 `child.inject(texts)`（异步，挂 disposer）；`subagent/end` 命中时只记账/告警，不做注入。</action>
  <verify>测试断言：命中时子代理收到注入且内容与 `texts` 一致；未命中零注入；`subagent/end` 不产生注入；子代理已释放时不抛错。</verify>
  <security>子代理上下文注入属跨 scope 写：必须校验子代理存在性与 scope，失败静默放行；不得向父会话注入子代理内容。</security>
  <done>两层可用，机制与观察语义分离。</done>
</task>

<task type="auto">
  <name>T7：subagent 层测试</name>
  <files>test/engine/prompt-config-engine.test.mjs</files>
  <action>覆盖命中/未命中/子代理缺失三类场景，以及 audience 门控不受影响。</action>
  <verify>该文件全绿。</verify>
  <security>不涉及。</security>
  <done>两层的接线与边界均有断言。</done>
</task>

## Wave 4：客户端表单与文案

<task type="auto">
  <name>T8：subject 与 match 的表单能力</name>
  <files>src/client/**、src/client/locales*.ts</files>
  <action>按 `/meta` 的字段能力矩阵为新字段渲染控件：`subject` 下拉、`match` 键集合编辑器（keys/secondaryKeys/logic/大小写/整词/正则）；三个新层的标签与说明由 schema 的 `LAYER_LABELS` 带出；补中文文案。</action>
  <verify>`test/client/**` 中断言新层可选、字段按策略显隐、非法 logic 被表单拒绝；`pnpm --dir <repo> build` 通过。</verify>
  <security>表单只做本地校验，权威校验仍在引擎挂载期；不得把配置值拼进 DOM 危险位置。</security>
  <done>新能力在工作台可视化配置，非仅 YAML 可用。</done>
</task>

<task type="auto">
  <name>T9：表单契约测试</name>
  <files>test/client/**</files>
  <action>补新字段与三新层的渲染/显隐断言，含 layer 切换时的字段重置。</action>
  <verify>客户端测试全绿。</verify>
  <security>不涉及。</security>
  <done>表单契约有回归保护。</done>
</task>

## Wave 5：文档与交付

<task type="auto">
  <name>T10：权威文档同步</name>
  <files>docs/engine-reuse.md、docs/ui-architecture.md</files>
  <action>`engine-reuse.md` 更新层清单（6 → 9 层）与条件判定说明；`ui-architecture.md` 记录表单新字段契约。</action>
  <verify>`git diff --check` 干净；文档内路径与命令可核对。</verify>
  <security>不涉及。</security>
  <done>行为变化与权威文档一致。</done>
</task>

<task type="auto">
  <name>T11：全量验证与交付</name>
  <files>仓库根</files>
  <action>隔离 cwd 跑全量门禁，检查 diff 与工作树，创建中文 Conventional Commit 并推送 origin/dev。</action>
  <verify>`pnpm --dir <repo> typecheck && lint && test && build` 全绿；`git -C <repo> diff --check` 干净；交付说明含 SHA 与推送分支，并标注「需重启 DSH 后引擎生成目录刷新才生效」。</verify>
  <security>提交前只暂存本轮文件；不提交 `.scratch`、本地记忆与生成目录之外的内容。</security>
  <done>门禁全绿、提交推送完成、生效条件已标注。</done>
</task>

## 回滚与检查点

- 代码回滚：`git revert <本轮提交>`；本轮不触碰生成快照与 vendor，回滚无数据侧动作。
- 配置回滚：新字段缺省即旧行为；删除使用新层的 promptConfig 卡片即完全退出该能力。
- 中断检查点：每个 Wave 结束跑对应测试文件；Wave 4 前必须先有 Wave 1–3 的字段定稿。

## 状态

- [✔] Wave 1：条件判定（T1–T3）
- [✔] Wave 2：turn-stop 层与护栏（T4–T5）
- [✔] Wave 3：subagent 两事件层（T6–T7）
- [✔] Wave 4：客户端表单与文案（T8–T9）
- [✔] Wave 5：文档与交付（T10–T11）
- [✔] 追加：缺口 1（策略 × 层校验）、缺口 2（pre-step 条件判定）——用户在本轮追加授权

## 验收记录

命令一律在 `D:\AI\workspase\_temp` 下执行：

| 命令 | 结果 |
|---|---|
| `pnpm --dir <repo> typecheck` | 通过（tsc 双配置无输出） |
| `pnpm --dir <repo> lint` | 0 warnings / 0 errors（265 文件） |
| `pnpm --dir <repo> test` | **1147 tests / 1147 pass / 0 fail** |
| `pnpm --dir <repo> build` | client 与 server bundle 均 Build complete |
| `git -C <repo> diff --check` | 干净（exit 0） |

行为断言（证据类型：注入条数与内容、`steer`/`inject` 调用次数与上限、挂载期抛错，非措辞断言）：

- `test/engine/prompt-config-engine.test.mjs`（74 pass）：tool-pipeline 条件命中 → `{kind:'deny'}`、未命中 → `next()`；数组 `toolNames` 归一化不扩大成全工具门；post 侧按 `toolResult` 裁决；`all` 组合逻辑；turn-stop 命中续跑恰好一次、会话级上限（`TURN_STOP_MAX_PER_SESSION`）后永久放行、未命中零调用；subagent-start 命中向子代理注入、未命中零注入；subagent-end 只观察不注入；非条件层声明 `subject`/`match` 挂载期抛错；pre-step 命中才注入且未命中不占用 session 去重；策略 × 层不支持组合挂载期抛错。
- `test/host/preset-prompt-configs.test.mjs`（33 pass）：模板库 13 条（含 `65-turn-stop.yml`、`66-subagent-start.yml`）逐条通过引擎权威校验；`renderPromptConfigYaml` 的 subject/match 全字段往返；空 match 不落盘半成品。
- `test/client/prompt-config-form-layout.test.mjs` / `engine-module-cards.test.mjs`（34 pass）：九层顺序与模板菜单；条件字段只在放行的层渲染；切层清空；match 草稿归一与 JSON 往返；useRegex 三态（强制字面不被改回自动）。
- 一次性端到端探针（临时脚本，已删）：客户端草稿 → `renderPromptConfigYaml` → 引擎 `createPromptConfigs` 逐字段一致；pre-step 命中注入 / 未命中不注入 / 去重生效 / 无条件配置零回归（与引入条件判定前一致）。

## 实施取舍与已知边界

- 偏离 2 的**取证门**（症状补丁）不在本轮：需要跨调用状态与启发式判据，误伤率高，另案评估。
- 偏离 3（输出格式）不做：规则已在 system prompt 且实测在场，加强注入无边际收益。
- `subagent-start` / `subagent-end` 只交付机制、不带默认配置——当前无真实用例，属为对齐官方事件白的扩张，接受该成本。
- 不做 `session-start` 层：`system-prompt/assemble` 已被 5 个模块占用，是引擎既定的系统提示装配接法，等价语义已覆盖。
- 不拆 `tool-pipeline` 为 pre/post 两层：现有 `preDecision`/`postAction` 已是该形状。
- 计划外但必要的工作（实现中发现的连带缺陷，均已修复并留断言）：
  1. `params.toolNames` 数组写法会被 `parseToolNames` 静默解析成「匹配所有工具」，与条件判定叠加会把定向门扩大成全工具门 → schema 挂载期归一化为逗号串。
  2. 宿主 `renderPromptConfigYaml` 逐字段手写且不含 subject/match，UI 保存会丢字段 → 补齐渲染与往返断言。
  3. `characters.ts#LAYER_ORDER` 只有 6 层，角色卡应用时新层排序落位不准 → 补为 9 层。
  4. 条件判定抽出 `engine/condition.mjs`（pre-step 与其他层共用），匹配器改为 schema 挂载期预编译（`config.matchScan`），校验与执行同源。
  5. 模板库补两个新层示例（`65-turn-stop.yml`、`66-subagent-start.yml`）；`subagent-end` 无注入通道，不提供模板以免误导。
  6. `useRegex` 在表单里做成三态（自动/强制正则/强制字面）而非开关，避免手写 `useRegex: false` 被静默改成自动识别。
- 已知边界：层说明文案取引擎 `LAYER_LABELS.detail`（仅中文），英文界面下显示中文；补英译属引擎侧单语字典，未在本轮展开。
- 生效条件：引擎变更需重启 DSH，由插件刷新 `.agent-presets/.engine` 后才在运行中的会话生效；客户端改动需刷新页面。

## 测试现场与清理限制

- 测试与脚本统一在 `D:\AI\workspase\_temp` 下执行与清理，不把仓库目录作为 cwd。
- 本轮产生的临时脚本（zstd 会话解码、引擎能力盘点、条件判定探针、schema 自检）已全部删除；未写入 `.scratch/` 之外的位置。
