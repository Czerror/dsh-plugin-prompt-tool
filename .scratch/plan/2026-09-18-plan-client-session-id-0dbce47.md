# 客户端会话 id 来源修复（指令文件卡消失根因）

## 需求与授权

- 2026-09-18 用户提供根因审查报告 `C:\Users\Cz9nl\Desktop\指令文件模块卡无法创建-根因审查-20260918.md`，要求「根据这份审查结果创建为 plan」。本轮只产出 PLAN，不含实施授权。
- 2026-09-18 用户点名 `dev-expert` + `open-code-review-delegate` 复核该报告，结论见 [复核报告](.scratch/reviews/2026-09-18-instruction-card-rootcause-review.md)；用户拍板「三条建议全部并入」，故本轮范围含依赖版本漂移（Critical-1）。
- 基线：`dev@0dbce47`，起始工作树干净。
- 采纳的问题定义（原报告第一、三节 + 复核报告第三节）：客户端 `currentSessionId` 读 alpha.2 已删除的 `SessionListState.current`，恒为 `undefined`；指令文件链路因此静默降级为「只有全局文件」，工作区指令文件卡整体不可见、不可写。
- 待用户拍板：① 修复范围是否含同一死字段连带的模型选择卡与 `switchPreset`；② 是否按原报告建议 A+B 同做，还是先只做宿主侧 B。
- 未决前提：修复方向 A 依赖「alpha.2 下官方是否提供可用的当前会话接口」，由 T2 核实。T2 结论为「无可用来源」时 A 不可行，本轮退化为 B 单方案并回写本节。

## 影响面、依赖与护栏

- 调用链：`src/client/index.ts:54` → `src/client/data/use-prompt-tool-store.ts:421` → `src/runtime/settings-bridge.ts:336-348` `resolveInstructionScope` → `:292` `mergeInstructionCards` → `detectAgentsFiles` → 文件卡与写通道白名单。
- 同一死字段的全部读取点（复核定稿为四处）：`src/client/index.ts:54`、`:84`；`src/client/data/session-model-face.ts:59`、`:82`、`:102`，以及 `:24` 把 `current` 写死的自造结构类型。
- **版本漂移（Critical-1）**：`package.json` devDependencies 钉 `@deepseek-ai/dsh-api-session-controller@0.1.6-alpha.1`（类型含 `current`），运行时 profile 实装 `0.1.6-alpha.2`（已删）；`pnpm typecheck` 当前 exit 0，属假绿。T1 对齐后 typecheck 预期转红，T4 修复后恢复绿——红灯期是预期状态，不是回归。
- 依赖顺序：T1 → T2 → T3 → T4 → T5 → T6 串行；T3 的用例必须保持红灯直到 T4 落地。
- 硬约束：契约变更先改 `src/shared/bridge-contract.ts`，再同步 host、client 与契约测试；bridge 写入端点保留白名单、类型、数值与大小校验。
- 护栏：写通道白名单不放宽；不改 DeepSeek Harness 源码仓库；不停止、重启运行中的 dsh / dsh web；测试从隔离 cwd 与临时 `DSH_HOME` 执行。

## Wave 1：对齐依赖并确认来源

<task type="auto">
  <name>T1：对齐官方包版本，让漂移可见</name>
  <files>package.json、pnpm-lock.yaml</files>
  <action>把 devDependencies 与 dependencies 中的 @deepseek-ai/* 对齐到真实 DSH profile 实装的版本（至少 dsh-api-session-controller、dsh-session 到 0.1.6-alpha.2），重新安装并核对 node_modules 实际解析版本。</action>
  <verify>`pnpm why` 显示解析版本等于 profile 实装版本；`pnpm typecheck` 预期**转红**并指向 `SessionListState.current` 的读取点——红灯即本轮要修的目标清单，需留档。</verify>
  <security>不涉及，原因：只改依赖声明与锁文件，不触碰写盘、外部输入或权限路径。</security>
  <done>开发依赖版本与运行时一致，且类型检查已能发现 current 缺失。</done>
</task>

<task type="auto">
  <name>T2：核实 alpha.2 下「当前会话」可用来源</name>
  <files>已安装的 @deepseek-ai/dsh-api-session-controller 与 dsh-client-ui-workspace 类型、会话 slot 契约、src/client/index.ts</files>
  <action>在 T1 对齐后的类型基础上逐个核对候选来源——会话 slot 上下文、连接层事件、视图层导航接口、`ISessions` 现有的 open／clear／scopeOf／sessionOf——确认可读性、会话切换时机与订阅方式，选定 A 方案的具体接入点。</action>
  <verify>产出候选清单与选定依据（含类型定义出处）；全部不可用时给出「无可用来源」结论与已核范围，并按「未决前提」回写 `## 需求与授权`。</verify>
  <security>不涉及，原因：只读已安装类型与本地源码，不触碰写盘、外部输入或权限路径。</security>
  <done>接入点已选定，或已给出可复核的否定结论。</done>
</task>

<task type="auto">
  <name>T3：建立会先红的防复发回归</name>
  <files>test/client/ 新增用例；形状参照 test/host/instruction-scope-guard.test.mjs</files>
  <action>用真实 SessionListState 形状（ids／byId／phase／subagentsByParent／jobsBySession，不含 current）构造 client face，断言 currentSessionId() 返回有效会话 id；同一用例中断言插件声明的官方快照形状与宿主实装类型一致，把版本漂移纳入防复发范围。</action>
  <verify>该用例在修复前失败，保留红灯输出作为证据；现有 instruction-scope-guard 用例因使用自造假 harness 不会红，以其对照说明覆盖缺口。</verify>
  <security>不涉及，原因：测试使用隔离临时目录与临时 DSH_HOME，不写真实预设或用户目录。</security>
  <done>红灯可复现并留档。</done>
</task>

## Wave 2：客户端会话 id 源（治本 A）

<task type="auto">
  <name>T4：替换四处失效取值与写死的类型声明</name>
  <files>src/client/index.ts、src/client/data/session-model-face.ts、按 T2 结论新增或复用的会话 id 模块、对应 client 测试</files>
  <action>按 T2 选定的接入点维护 currentSessionId 源，会话切换时同步；替换指令文件、模型投影、select 写入与 switchPreset 四处读取；把 session-model-face.ts:24 的自造结构类型改为只声明实际用到的方法签名，字段形状交回官方类型。已有的 instructionSessionRef 上下文切换与草稿保护保持不动。</action>
  <verify>T3 用例转绿，`pnpm typecheck` 恢复 exit 0；模型卡 selectable 与 switchPreset 返回值的回归通过；会话切换后取到的 id 跟随更新。</verify>
  <security>只读会话 id，不新增写盘权限；白名单判断不落到客户端。</security>
  <done>四处取值不再依赖 SessionListState.current，且类型层不再声明官方已删除的字段。</done>
</task>

## Wave 3：宿主读侧兜底（B）

<task type="auto">
  <name>T5：resolveInstructionScope 读放宽、写不放宽</name>
  <files>src/shared/bridge-contract.ts、src/runtime/settings-bridge.ts、对应 host 与契约测试</files>
  <action>拿不到 sessionId 时按官方 agent-instructions 的口径回退到会话 header cwd（缺失再退部署进程 cwd），并如实标记来源（如 deploy-cwd）；mergeInstructionCards 与写通道白名单维持不变。</action>
  <verify>无 sessionId 的请求返回工作区文件且来源标记正确；写通道仍拒绝白名单外路径；部署 cwd 与会话工作区不一致时 UI 能辨别来源。</verify>
  <security>读放宽、写不放宽：白名单、真实路径校验与请求体上限保持不变，部署 cwd 不转化为写授权。</security>
  <done>id 异常时工作区文件卡不再消失，且来源可辨。</done>
</task>

## Wave 4：实测与交付

<task type="auto">
  <name>T6：UI 实测、门禁与文档同步</name>
  <files>测试套件、docs/ui-architecture.md、CHANGELOG.md、PLAN</files>
  <action>按原报告第七节实测；跑 typecheck、lint、完整 test、build 与 diff --check；行为变化同步权威文档并回填本 PLAN 的 `## 状态` 与 `## 验收记录`。</action>
  <verify>/prompt-configs 请求体带 sessionId；返回 source: session 且 cwd 等于当前工作区；模块列表出现工作区 AGENTS 文件卡并能保存成功。门禁全绿，且 typecheck 在 T1 后转红、T4 后恢复绿的完整轨迹有留档。</verify>
  <security>不重启运行中的 DSH，只刷新页面与只读探测；本地记忆不提交。</security>
  <done>实测与门禁均有输出留档，交付 SHA 与推送分支明确。</done>
</task>

## 回滚与检查点

- 回滚：本轮只改依赖声明、锁文件与插件代码，无数据迁移，`git revert` 对应提交即可；已生成的预设与用户数据不受影响。依赖对齐若引发连锁红灯，回滚该提交即回到当前状态。
- 检查点：Wave 边界把中断摘要写入 `.scratch/`，不把流程产物放 `.ai-memory`。

## 状态

- [ ] Wave 1 / T1：对齐官方包版本，让漂移可见。
- [ ] Wave 1 / T2：核实 alpha.2 下「当前会话」可用来源。
- [ ] Wave 1 / T3：建立会先红的防复发回归。
- [ ] Wave 2 / T4：替换四处失效取值与写死的类型声明。
- [ ] Wave 3 / T5：宿主读侧兜底。
- [ ] Wave 4 / T6：UI 实测、门禁与文档同步。

## 验收记录

- 待执行后回填：实际命令、退出码与实测输出；T3 用例修复前的失败输出；T1 后 typecheck 转红与 T4 后恢复绿的对照。

## 实施取舍与已知边界

- A 与 B 的分工：A 让常规路径正确，B 保证任何 id 异常时工作区卡不再凭空消失。只做 A 则 id 异常场景仍静默降级，只做 B 则客户端仍读死字段，原报告建议两者同做。
- 依赖对齐（T1）是复核查出的机制层缺陷：不修它，类型检查对官方快照形状的漂移永久失效，同类缺陷会以「绿灯 + 运行时静默降级」复发。代价是 T1 到 T4 之间 typecheck 处于预期红灯期。
- 原报告自述未做浏览器抓包，结论由运行中的 lib/client.js、官方类型缺字段、bridge「传对 id 即恢复」三方互证；修复后以 T6 的实测取代该推断。
- 官方包升级后需重新核对 `SessionListState` 字段；T3 的用例即为该核对的前置告警。
- 部署进程 cwd 与当前会话工作区可能不同，B 方案的来源差异必须在 UI 可见。
