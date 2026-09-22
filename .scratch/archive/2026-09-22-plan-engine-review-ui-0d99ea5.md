# 引擎收敛复审、配置编辑区重构与 DSH 0.1.7 适配

## 需求与授权

- 日期：2026-09-22；实施基线：`dev / 0d99ea5`。
- 用户要求：根据 `2026-09-22-plan-engine-convergence-master-84785df.md`，审查 `5e03ac8752d18586826b84bf2afb566cb1dcfd46` 以来全部修改，随后使用 `ui-skills` 重构 UI。
- 用户选择：UI「聚焦配置编辑区」，保持保存与注入行为；本轮「同时适配 v0.1.7-alpha.1」。
- 用户追加选择：「本轮一并修复这些缺陷（推荐）」，已明确授权修复本轮证实的缺陷。
- 使用 dev-expert、open-code-review 的 delegate 工作流、UI Skills baseline-ui、ponytail、codex-editing-tools、codex-subagent-delegation；新版适配遵循 dsh-plugin-dev 与 migration。
- 保留既有未跟踪文件：`.scratch/b7-assembly-smoke.mjs`、`.scratch/plan/b7-t3-batch-d-brief.md`、`.scratch/plan/b7-t3-inventory.md`、`skills/dsh-prompt-card/`。

## 审查结论

审查范围固定为 `5e03ac8..0d99ea5`，13 个提交、159 个差异路径。OCR delegate 识别 117 个可审文件，全部由运行时、客户端和补充 host/shared/layers 审查覆盖；42 个默认排除项中，35 个文档或删除路径经人工补查，7 个架构图产物仅核对来源与历史生成收据，未重新视觉生成。OCR 可审覆盖率100%；全部差异路径的实质复审152/159，7项视觉产物明确保留验证限制。首轮 host 汇总因外部模型额度错误中断，随后独立只读代理补齐覆盖并发现 R13/R14。

| 编号 | 等级 | 位置 | 触发、影响与修复方向 |
|---|---|---|---|
| R1 | P1 | `engine/predicates.mjs:74` | subject 归一未生成 `argsText/resultText/userText/assistantText/subagentText`，真实工具参数 `DELETE` 不命中文本拒绝条件。应复用既有文本提取 helper 并用真实工具管线回归。 |
| R2 | P1 | `engine/actions.mjs:610` | `includeSubagents:false` 的主会话 guard 仍安装向后代传播的 restrict，子代理继承 bash 被过滤成 unknown tool。应保持受众感知执行 guard，避免主会话限制泄漏。 |
| R3 | P1 | `engine/actions.mjs:325` | after-next 动作在 next 前读取 phase；同次 pre-step 内成功压缩后仍按旧晋升状态放行，首次压缩后消息漏过门控。应按动作真实阶段读取当前 epoch。 |
| R4 | P2 | `engine/trigger-spec.mjs:221` | 声明 channel/phase 经校验后未传到注册器，`agent/pre-step + request-params` 实际挂 agent/request。需限制合法组合或兑现调度，不能静默忽略。 |
| R5 | P2 | `engine/trigger-spec.mjs:196` | 缺省 channelOrder 归一前排序，输入 `[5,undefined,1]` 输出 `[5,0,1]`；应归一后稳定排序。主线程无文件探针已独立复现。 |
| R6 | P2 | `engine/actions.mjs:337` | 目标匹配前扣 maxPerTurn，先 read 再 bash 会耗掉 bash 专用 deny 额度。应在实际效果前同步 claim。 |
| R7 | P2 | `engine/actions.mjs:167` | mask 同时接受 allow/deny，未落实总纲的名单模式互斥；需统一边界校验并覆盖 assembly/sdk-strip/guard。 |
| R8 | P2 | `src/shared/engine-params.ts:172` | instructionHint 改归 prompt-defaults 后，按 card 推导模块无法找到 capability；空 modules 加 instructionHint:true 不装配 instruction-hint。需核实并修正模块推导所有者。 |
| R9 | P2 | `src/client/features/prompts/PromptConfigForm.tsx:208` | 无效数字草稿后选择官方位置只更新 config.order，数字框与错误不清除，继续阻止切预设。主线程 SSR 已复现；应共用接受新值的草稿更新路径。 |
| R10 | P2 | `src/client/features/prompts/PromptConfigForm.tsx:125` | 快捷位置写 segment.from，与官方同 order 时按名称排序，不能兑现「之前」。主线程真实 SystemPrompt 已复现身份段仍在前；定位应严格小于区段下界。 |
| R11 | 验收缺口 | B7 归档 | workspaceLine/phase1FirstCallInstruction 未迁移，Flash 预算不等价；隔离宿主装配与第二个预设迁移失败恢复断言未完成。属于已知缺口，不能因文档记载而视作完成。 |
| R12 | 测试迁移 | `test/client/**` | 基线全测 1506 / 1474 pass / 32 fail，均在客户端：旧 stages/七能力夹具与断言仍在。应迁移通用行为断言到现存能力，保留安全与草稿保护。 |
| R13 | P2 | `engine/trigger-spec.mjs` | 编译仅检查动作 kind；非法 `assembly.target: null` 可写盘后才在装配时报错。需把动作参数校验与绑定分开，保存和装配共用同一校验。 |
| R14 | P2 | `src/host/preset-registry.ts` | 新版注册误用 UI 隐藏清单，漏掉已有 prompt-tool 历史快照；省略 name 抛错，order 误从 meta 读取。已补先红后绿测试：注册包含兼容快照、名称允许省略、排序读取顶层；UI 清单继续隐藏快照。 |

### 0.1.7-alpha.1 兼容差异

- 官方源码 `c36a83ff6bb95e3f82cf79f9be7c724270a8aa61`；实施前本插件包仍固定 `0.1.6-alpha.2`。
- `agent-presets` 改为 `agent-preset-registry`，保留 agentPresets 服务与 remote list/select、defaultId、composedPreset；不再自动扫描用户预设目录，改用 register 声明。
- 默认选择从旧 settings namespace 改为 registry 的 volatile 配置；不得继续向已不存在的 `agent-presets.default` 写入。
- `standingKeyFor` 改为 `acquireScope` revision lease，工具预览必须释放 lease。
- 官方 SECTION_ORDERS 删除 TOOL_CORDIS；当前固定名字全量校验会使刻度整体缺席。
- guard 的继承过滤及 pre-step 内压缩契约在新版仍成立，不能用升级代替 R1–R3 修复。

## 影响面、依赖与护栏

- 顺序：完成审查复核 → 升级已发布官方依赖与适配宿主 → 配置区表单整理与旧客户端测试迁移 → 完整门禁。
- UI 保留主会话/子代理共用 PromptConfigForm、EngineLayersPanel、原生 details、现有控件和 DSH 语义 token；不新增依赖、第二套保存通道或全局注入顺序。
- 新预设注册复用本仓库已有定义、物化与 rebuild 生命周期；不修改宿主源码，不操作在役 DSH，不写真实用户预设。
- 只通过 apply_patch 编辑源码与文档；生成物通过既有 scripts。shell 固定 PowerShell 7；测试 cwd 与临时 DSH_HOME 在 `_temp` 下。
- 本地 `.ai-memory` 仅追加修改记忆，不入库。最终只暂存本轮文件，中文 Conventional Commit 推送 origin/dev。

## Wave 1：审查与宿主适配

<task type="auto">
  <name>T1：复核审查并锁定新版官方契约</name>
  <files>engine、src、test、总纲及相关归档、官方只读源码</files>
  <action>完成未闭合 host 覆盖；复跑关键反例；把问题与已知验收缺口区分记录。</action>
  <verify>OCR 文件清单逐项归属；真实服务反例与基线 test 结果可核对。</verify>
  <security>guard 子代理继承与文本拒绝的执行行为验证；不调用模型或真实外部工具。</security>
  <done>审查覆盖与所有采用结论的证据闭合。</done>
</task>

<task type="auto">
  <name>T2：适配官方 0.1.7-alpha.1</name>
  <files>package.json、lock、host/runtime 适配、client 入口、official-orders、组合生成脚本与对应契约测试</files>
  <action>更新已发布官方包；接新版预设注册、默认同步、revision lease；同步刻度与官方组合来源。</action>
  <verify>typecheck、宿主契约、预设新建/重建/删除/释放、工具预览租约、刻度测试。</verify>
  <security>隔离 DSH_HOME；不覆盖未知用户文件；失败保留可用代际，卸载释放注册。</security>
  <done>新版类型、装配与预设生命周期行为通过。</done>
</task>

## Wave 2：配置编辑区

<task type="auto">
  <name>T3：统一顺序编辑与表单层级</name>
  <files>PromptConfigForm.tsx、PromptConfigFields.tsx、prompts.module.css、layer-settings.module.css、locales-prompts.ts、相关 UI 测试</files>
  <action>数字和官方位置使用同一接受值路径；具名字段组与一致布局，区分本条规则和共享层设置；保留现有写盘行为。</action>
  <verify>无效数字→快捷选择清除错误；真实装配位置；320/420/860 宽度、明暗主题、键盘、只读及保存次数。</verify>
  <security>指令正文/策略授权与版本冲突行为保持，不合并或删减相关安全测试。</security>
  <done>配置区可访问、无横向溢出，草稿和保存回归通过。</done>
</task>

<task type="auto">
  <name>T4：迁移已撤销能力的客户端验收</name>
  <files>test/client 中 editor-state、param-overrides、prompt-tool-view、engine-module-cards、scope-create-separation、module-policy-smoke、real-css-smoke 及必要 fixture</files>
  <action>删除仅属于已放弃 stages 的专用断言；用仍存在的参数/能力继续断言草稿、镜像、错误、只读、创建与过滤隔离。</action>
  <verify>先确认 32 个旧失败，再定向 test 转绿；不得单纯删断言取得绿灯。</verify>
  <security>不更改指令读写、导入回滚与子代理授权安全用例。</security>
  <done>客户端完整测试通过。</done>
</task>

## Wave 3：门禁与交付

<task type="auto">
  <name>T5：完整验证与归档提交</name>
  <files>文档、PLAN、构建与分发快照、本轮修改文件</files>
  <action>统一构建后全测，补稳定行为文档与本地记忆；PLAN 完成后原样归档，选择性提交并推送。</action>
  <verify>pnpm typecheck、lint、test、build 与 git diff --check 全绿；状态和暂存范围核对。</verify>
  <security>不重启服务，不暂存既有未跟踪文件或本地记忆。</security>
  <done>验证证据、提交 SHA、origin/dev 推送与生效要求全部记录。</done>
</task>

## 回滚与检查点

- 本 PLAN 是本轮检查点；保留审查基线与未完成任务。代码回滚使用本轮提交的 revert，不覆盖已有工作树。
- 包与锁文件一并回退；尚未触及真实用户数据，无数据迁移回滚动作。
- 子代理审查已返回关键证据；后续两个复用回合因外部模型额度不足退出，主线程接管未完成项。

## 状态

- [✔] T1 审查：runtime/client 与补充 host/shared/layers 复核完成；7 个架构图产物未重跑生成，明确列为范围限制。
- [✔] T2 新版宿主适配：已发布包、ConfigForms、volatile 设置、预设注册与代际释放、默认同步、官方来源快照及刻度全部通过验证。
- [✔] T3 配置编辑区重构：主线程实际 Edge/SSR/装配行为复验通过。
- [✔] T4 客户端旧测试迁移：主线程 client 302/302 通过，保留通用行为断言。
- [✔] T5 实现、完整门禁与归档就绪；本归档随本轮代码提交，提交与 origin/dev 推送结果以 Git 记录和交付说明为准。
- [✔] R1–R8 修复授权：用户确认本轮一并修复；运行时代理与 host 代理按互斥写区实施。
- [✔] R1–R10、R12–R14 已修复或完成测试迁移并由主线程验证；R11 为历史未迁移/验收边界，保留披露，不计为本轮已完成迁移。

## 验收记录

- 基线 `pnpm --dir $Repo test`（临时 cwd，TEMP/TMP 指向 `_temp`）：build 成功；1506 tests，1474 pass，32 fail，0 skipped。
- runtime 定向 10 文件：子代理报告 133/133 通过；新增反例不在旧用例中。
- 主线程无文件 Node 探针：声明排序 `[5,0,1]`、身份段同值排在配置前、order=500 仍保留 `-` 错误草稿，三项均已复现。
- 0.1.7-alpha.1 已发布包已安装，Cordis 4.0.3、Schemastery 3.18.3；`verify-host-contracts` 56项0失败。
- 主线程复跑 `node --test test/client/*.test.mjs`：302/302；`node --test test/engine/*.test.mjs`：506/506；registry 与 bridge13/13、组合来源12/12。
- 第一轮完整门禁1536/1535/1失败：旧官方技能文案断言；改为固定来源快照对拍后，第二轮1536/1536通过。补充审查 R13/R14 收口后，最终完整门禁 **1557/1557，0失败，0跳过**。
- R14 主线程先红（省略 name 抛错）后绿；registry 与 user-presets 合计20/20通过，宿主 tsc通过。
- R13 新增19项先红后绿；主线程额外验证坏声明不改组合、正文及共享引擎，engine+保存边界526/526通过。
- 最终命令（均由主线程在 `D:/AI/workspase/_temp` 发起）：`pnpm --dir $Repo typecheck`、`lint`、`test`、`build`、`git -C $Repo diff --check` 全部退出0；`sync:yaml`、`rebuild:preset-template` 完成，分发快照由脚本生成。
- 真实 Edge 检查320/420/860宽度、明暗主题、键盘、只读、错误草稿与保存次数；两个截图已查看并清理。全部子代理/CLI并行进程均已结束，不以测试替代在役宿主重启验证。

## 实施取舍与已知边界

- UI Skills 的 refactoring-ui 拉取失败，已成功读取 baseline-ui；采用仓库现有 CSS Modules/控件/token，不引入 Tailwind 或新的 primitive 系统。
- 总纲仍保留原始方案历史，不能把其“全部未开工”当作当前代码状态；本轮结论集中在本 PLAN。
- 新版适配涉及装配期内容，最终需要用户重启 DSH 服务后生效；本会话不重启。
- R11 的 `workspaceLine`、`phase1FirstCallInstruction` 尚无迁移声明，Flash 下 bootstrapMaxTokens 的隐式模型过滤仍为已知差异；本轮没有新增这些产品能力或修改真实用户预设。原 B7 的完整隔离宿主 smoke 未补做；本轮使用真实官方 Registry/Loader/ToolRuntime 的隔离进程行为测试。
- 官方 client-store 发布产物直接引用但未声明 zustand/immer 运行依赖；本仓库补开发依赖以运行 SSR/浏览器测试，生产客户端仍由官方平台提供 primitives，不增加打包到插件的状态框架。

## 测试现场与清理限制

- 本轮测试 runner 自行清理临时目录；无新建独立临时文件。
- 用户此前留下的 B7 备份与 smoke 文件保持原样。
