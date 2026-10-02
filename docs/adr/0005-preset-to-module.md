# 预设形态移植为模块形态

状态：已实施（`beta2`，2026-10-02，提交 `558bee7`（配装通道）… `3094c53`（文档同步）、`c897064`（准备期拒写回归）；同日续 `36307ab`（模块页合并）、`b3c048d`（卡体与删除守卫收口）、`3227501`（英文文案收口）、`bb79111`（互斥行为断言）、`081033e`（README/SillyTavern 口径同步）——12 项任务（T1–T12）全部完成）。

插件原先以「预设」为唯一身份：定义文件是 `preset.yml`，存储根是 `$DSH_HOME/.agent-presets/`，物化目录是 `prompt-configs/`，装配依赖官方 roster 扫描与 `agent.cordis.yml` 组合文件；角色卡是与它并列的**第二套身份**（库在 `.characters/`，并入时给条目加 `chara-<id>-` 前缀）。这条路线在审查中显形两处代价：身份分裂让「载入一个预设」与「并入一张卡」成为两套机制；而宿主扫描成了装配的必要条件，尽管插件真正要的只是「在自己的作用域里按定义装配」。

移植后的形态：**模块**统一两种身份。定义文件是 `module.yml`，存储根是 `$DSH_HOME/.prompt-tool/`，一个模块一个目录（`modules/<id>/`），物化目录是 `configs/`。装配不再依赖宿主扫描——`agent/created` 触发时，插件在**该 Agent 自己的 scope** 里注册配装（`agent.ctx.plugin`），切片来源是模块目录里的字面量（物化目录优先，缺失回退内嵌）。并入成为**模块间**能力：源模块优先（`modules/<id>/module.yml`），角色卡库作回退，条目 id 统一加 `module-<id>-` 前缀，移除按同一前缀集合做差集。管理端点收敛为 `/module-*`；工作台两页的合并留待后续（见代价⑤）。

代价与边界都保持显式。①**老数据不迁移**：用户已并入的条目 id 仍是 `chara-…`，读取端两种前缀都认、移除端两种前缀都撤——改写用户的 `module.yml` 不在本决策授权内。②`preset.yml` 只在**导入外部包**时兼容（包是用户手里的产物，判它损坏等于作废用户已有的包），模块目录里不再读取该名。③失败载荷的**错误码保留**旧名（`preset-*-rejected`、`preset-in-use` 等）：它们属失败契约而非端点命名，收敛它们会破坏按码判断的调用方。④角色卡库继续存在——卡片素材与记忆跟着卡走，模块根与它**并存**而非取代；`loadImportSource` 的模块优先正是这一并存关系的唯一入口。⑤工作台两页（预设页 `presets` 与角色卡页 `characters`）在写下本 ADR 时**尚未**合并，页面 id 仍是旧值，收敛只发生在管理端点上。**后续演进（同日）**：该合并已落地——`36307ab` 把两页并为一页并改用 `modules` 作为页面 id，`b3c048d` 进一步把两页唯一的语义差异（卡体）收敛为「卡体只承载内容、动作全在卡脚」，两页的删除守卫也就此对称。本⑤的「未合并」只描述写下本 ADR 时的状态。

## 系统提示「独占」（`complete`）在新形态下的边界

该参数**不因本决策而改变**，一并记录以免后续误判：

- **能力无损平移**。`complete` 是 `params` 下的普通布尔值（`engine/schema.mjs:190` 声明为 `system-section` 层的合法参数），两条装配路径都只做数据搬运、不做特判：自建通道照 `ConfigsDir` 读切片（`src/runtime/agent-assembly.ts:108-110`），物化路径照写产物；唯一的裁决点是宿主 `@deepseek-ai/dsh-system-prompt` 的装配（`packages/core/system-prompt/src/index.ts:597-600`：多于一个生效的 complete 段即抛错），两条路径共用同一个 `ctx.systemPrompt` registry。
- **语义**：`complete: true` 让该段成为**唯一的** system prompt 段——其余 system 段（身份注入、后缀、工具指南等）全部被抑制，工具链、运行时上下文与变量仍保留。因此它是能一键把 system 层清到只剩一段的开关。**「唯一」是真正裁到只剩它**：官方测试 `tests/system-prompt.spec.ts:380-396` 断言的结果是 `sections` 只含那一段的**原始文本**——装配 waterfall 里对它的改写与新增都是白做（它是在 waterfall 之前捕获的快照，之后强制还原为唯一段）。
- **边界一**：顶层 `persona.complete` 由官方 `@deepseek-ai/dsh-persona` 行承载，该行仍由**会话原有预设**提供（`src/runtime/agent-assembly.ts:10`、`:123-124`）；插件写 `module.yml` 只是驱动它。此约束与基线一致，新架构既未加强也未削弱。
- **边界二（已知缺口，本次标注不修）**：写盘前的互斥门控只覆盖两个 bridge 端点（`src/runtime/settings-bridge.ts:1592-1604` 的 `/param-overrides`、`:1778-1793` 的 `/persona`）。手改 `module.yml`、还原 ZIP/备份、导入包均可绕过，实测导入与校验链路（`configs-validate.ts`、`preset-package.ts`）对 `complete` 零校验。绕过门控造成两个生效的 complete 段时，后果是 system 提示被清到只剩一段、或组装直接失败。
- **未覆盖的回归**：上述两条拒绝路径（`preset-persona-complete-conflict` 与 `overrides-invalid-value`）当前**零测试**，本次只标注不补。
- **核验方式（2026-10-02）**：结论不是读文档得出的，而是分三层取的一手证据——①**运行中 profile 实际安装的包**：`D:\AI\DeepSeek Harness\.dsh\profiles\node_modules\@deepseek-ai\dsh-system-prompt`（`0.2.0-rc.2`，包内直接带 `src/*.ts` 与官方 `tests/*.spec.ts`）与 `…\dsh-persona`（同版本）；②**真跑**：用 `createRequire` 加载该 profile 的包，实际装配验证「单个 complete 只留一段」「waterfall 篡改与追加被丢弃」「两个 complete 抛错并点名」「两个来源共用同一 registry 互相撞见」共 5 项，全部通过（判别力由官方自己的测试反向确认）；③**版本对齐**：插件侧装的是 `0.2.0-rc.1`（peer `>=0.2.0-rc.1`），其 `lib/index.js` 同样含唯一性校验与同一段 sections 替换逻辑，**rc.1 与 rc.2 在 `complete` 上行为一致**，故「插件按 rc.1 类型编译、运行时按 rc.2 执行」不构成风险。
- **核验时撞到的一条官方约束（顺带记录）**：官方 `SystemPrompt` 自带占位 `deployment:persona-prefix`，同一 scope 再注册该名会被拒（`prompt section "deployment:persona-prefix" is already registered`）。这正是 `dsh-persona` 必须在 **agent scope** 挂载、不能全局挂载的原因（其 `src/index.ts:56-60` 注释与 `README.md` 均已写明）。

需要「迁移用户既有条目 id」「收敛失败错误码」「删除或合并角色卡库」「合并工作台两页」「为 `complete` 互斥补组装期兜底校验」中任何一项时，须以新的 ADR 重定兼容策略、拒绝行为与回滚路径；本 ADR 不覆盖这些方向。
