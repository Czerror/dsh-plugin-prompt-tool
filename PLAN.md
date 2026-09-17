# 全量审查修复：预设同名复制与技能导入确认

## 授权、基线与最新语义

- 用户授权（2026-09-18）：按本次审查结论执行所有修复，包含 4 项 P1、7 项 P2、导入失败残留风险、同名覆盖确认与预设命名简化。
- 用户最新纠正覆盖此前表述：**某个包内 `pt-*` 预设目录不存在时，只补建该预设；其余现存目录不覆盖，不等待全部删除，也不全量重建。** 用户保存参数、模块、人设后正常物化当前预设。
- 包内预设目录与 `preset.yml.id` 统一为 `pt-*`，初始化按同名复制，删除运行时官方占用探测、前缀转换及复制后重命名。现有用户预设目录不自动改名；定义复制后由既有生成器物化缺失产物，不额外引入发布预生成系统。
- 技能不做内容版本管理。导入遇到同名目标时先列出冲突，用户确认后才覆盖；无冲突直接导入。成功覆盖不积累历史版本；失败事务仍恢复原文件。回收站删除保留既有语义。
- 基线：`dev@015ac62267aec75d00072204bdb6ef395a5c4441`，工作树干净。旧 PLAN 已原文归档到 [plan-review-fixes-015ac62-20260918.md](.scratch/prompt-tool-framework/archive/plan-review-fixes-015ac62-20260918.md)，Git blob 与归档前一致：`a6f346f083621497417e3e0c839486cfccbfec9d`。
- 不增加依赖，不修改宿主仓库，不改正在运行的 DSH 数据与服务；用户已授权最终中文 Conventional Commit 并推送 `origin/dev`。

## 问题与验收映射

| 编号 | 修复范围 | 验收行为 |
|---|---|---|
| R1 | 新建技能失败清理 | 链接根拒绝后原有技能和资源完整保留 |
| R2 | 引用目录保存 | 首次与后续增删成功；不把 JSON 快照当 YAML 原文版本 |
| R3 | 预设读取来源 | 现有 pt 预设自己的 modules/persona/variables/tools 参与生成 |
| R4 | 启动默认同步 | 插件与宿主指向同一个实际存在的用户预设 |
| R5 | 预设服务契约 | 删除已无用途的占用探测与不存在的 settings() 调用 |
| R6 | 无效导入包 | 缺少或无效 SKILL.md 的目标在写盘前整批拒绝 |
| R7 | 浏览器包路径 | 选中技能容器后每个技能直接落在用户技能根下一层，资源相对位置不变 |
| R8 | 调用策略兼容 | 旧驼峰键在写入时转成官方连字符键；正文与其他字段保留 |
| R9 | 同名技能裁决 | 清单与实际 registry 胜出路径一致，不用跨层 rank 或字典序猜测 |
| R10 | TUI 身份 | 展示、帮助、处理器使用同一身份，目录名与声明名不同仍可操作 |
| R11 | 角色模块回退 | 两卡正反顺序全部移除均回到原模块集；用户自带模块不删 |
| R12 | 导入事务 | 任一项失败时覆盖项恢复、新增项清理，不留下活动技能 |
| R13 | 覆盖确认 | 未确认零覆盖；取消零覆盖；仅确认的同名目标可覆盖；不留历史版本 |
| R14 | 独立补建 | 单个 pt 目录缺失只补单个；现有预设字节保留；重复启动幂等 |
| R15 | 候选刷新 | 文件事件失效不会被时间戳粒度阻挡，回归不依赖偶然时钟变化 |

## 依赖与规划门禁

- 代码调用链已按审查证据与 rg 复核：host 资产函数 → index 协调器 → shared bridge → settings-bridge → store/SkillsPage；manifest/writePreset → preset 模板与生成脚本；characters apply/remove → preset modules；扫描/provider → registry → 清单/TUI。
- 图谱仅作可选加速器，本轮复用已完成的全量审查定位与真实调用点，不生成违反仓库边界的 `.ai-memory` 流程产物。
- [✔] 范围与执行授权；[✔] 写区互斥；[✔] 回归证据与失败回滚；[✔] 保留共享服务；[✔] 无新增依赖；[✔] 保留用户文件；[✔] 官方 API 按已安装包核对。
- 导入契约先改 shared：请求增加可选 `overwrite: string[]`（用户确认的目标目录名），冲突失败载荷 `code: skills-overwrite-required` 与 `conflicts: string[]`。不使用版本 hash 或确认 token。

## Wave 1：独立核心修复

<task type="auto">
  <name>T1：技能写盘、包规范化与覆盖事务</name>
  <files>src/host/skills-actions.ts、skills-config.ts、skills-import.ts、skills-policy.ts；对应 host 测试</files>
  <action>仅清理本次新建目录；撤掉错误的跨调用内容版本参数；新包整批验证并按技能根规范化；冲突未确认返回名单；覆盖旧内容暂存在事务目录、成功清理、失败同时回滚覆盖与新增；旧策略键归一官方键。</action>
  <verify>先复现 R1/R6/R7/R8/R12/R13，再运行现有资产、策略和状态测试；确认失败/取消/恶意路径均零越界写入。</verify>
  <security>路径白名单、链接拒绝、大小限制、原子切换与异常回滚必须保留；不写实际 DSH_HOME。</security>
  <done>所有定向行为回归通过，接口形状交主线程接线。</done>
</task>

<task type="auto">
  <name>T2：包内预设命名与自身定义生成</name>
  <files>preset/、src/host/manifest.ts、paths.ts、write-preset.ts、preset-id-safety.ts、src/shared/preset-ids.ts、scripts/rebuild-composition.mjs；对应 preset/host/engine 测试</files>
  <action>包内目录和 id 统一 pt 前缀；种子与克隆直接同名复制；删除占用探测和反向模板映射；按单个缺失目录补建；已有预设使用自身定义生成。生成器的官方来源映射仅留在构建阶段。</action>
  <verify>包内 id 与目录一致；单个缺失只补单个；已有内容保持；生成变量与模块来自自身；官方组合快照重建后契约一致。</verify>
  <security>不移动、覆盖用户实际预设；不修改宿主、官方 fixture 的原始 id；生成快照只用固定脚本。</security>
  <done>核心预设回归通过，index 接线迁移要点明确。</done>
</task>

<task type="auto">
  <name>T3：角色卡共享模块来源回退</name>
  <files>src/host/characters.ts、test/host/characters.test.mjs</files>
  <action>保留卡引入模块的来源直到最后消费者移除，避免第一张卡移除时丢失回退依据；区分用户自带模块与无记录老卡。</action>
  <verify>两卡按正序/逆序移除均回原模块集；单卡、重应用、预设自带模块与仍有消费者的反例通过。</verify>
  <security>不删用户原模块，不改角色原文件，不重建实际预设。</security>
  <done>角色卡应用/移除对称且与顺序无关。</done>
</task>

## Wave 2：运行时与界面接线

<task type="auto">
  <name>T4：真实候选裁决、刷新与 TUI 身份</name>
  <files>src/host/skills-scan.ts、skills-refresh.ts、skills-provider.ts、src/runtime/tui.ts；对应扫描、候选、TUI 测试</files>
  <action>同名标注消费 registry 的实际结果；同层相同 rank 遵循原顺序；文件事件真实失效缓存；TUI 使用展示一致的声明名并处理同名歧义。</action>
  <verify>两个引用根反字典序、跨 scope 同名、等长即时改写、目录与声明名不同；使用真实 registry 的行为断言。</verify>
  <security>未知作用域不伪造胜出者，不改变官方注册行为；watcher 由 disposer 清理。</security>
  <done>R9/R10/R15 及对应接线通过。</done>
</task>

<task type="auto">
  <name>T5：协调器、bridge 与覆盖确认交互</name>
  <files>src/index.ts、src/shared/bridge-contract.ts、src/runtime/settings-bridge.ts、src/client/data/、src/client/features/skills/、src/client/locales.ts；shared/host/client 契约与 smoke</files>
  <action>同步预设简化接口并修正启动宿主 default；引用文件夹保存不再传错版本；bridge 严格校验确认名单，返回 409 冲突；store 保存本次导入载荷，复用 ConfirmDialog，确认后再提交，取消丢弃在途意图。</action>
  <verify>真实 apply 与宿主形状；真实 handler 首次冲突零写入、确认成功、取消不写、新增冲突再次提示；浏览器两个导入入口、失败恢复、忙期与同名提示。</verify>
  <security>确认仅授权已展示目录；不得自动确认；保留 loopback/Origin/Host/body 上限与其他指令文件版本保护。</security>
  <done>R2/R3/R4/R5/R9/R13/R14 端到端闭合。</done>
</task>

## Wave 3：生成、完整验证与交付

<task type="auto">
  <name>T6：文档、生成快照与全量门禁</name>
  <files>README.md、docs/skills-management.md、docs/architecture-params.md、docs/SillyTavern.md、docs/ui-architecture.md、NOTE.md、CHANGELOG.md、AGENTS.md 路径引用、PLAN.md；生成物</files>
  <action>同步稳定行为与新模板路径；按固定输入运行 rebuild:composition、sync:yaml、build；主线程复核全部补丁和原反例，运行 typecheck/lint/test/build/diff --check。</action>
  <verify>完整 test 全绿；原反例均转绿；版本化快照无手工修改；未产生额外部署改动。</verify>
  <security>测试 cwd 与临时 DSH_HOME 在 D:/AI/workspase/_temp，清理本轮临时文件，不停止共享 DSH。</security>
  <done>所有审查项有已验证状态，无遗留失败。</done>
</task>

<task type="auto">
  <name>T7：项目记忆、提交与推送</name>
  <files>PLAN.md、.ai-memory/20260918/daily.md、本轮任务文件</files>
  <action>追加最新逐项补建纠正与修复证据，更新旧错误记忆；只暂存本次文件（排除 .ai-memory），创建中文 Conventional Commit 并推送 origin/dev。</action>
  <verify>暂存 diff、工作树、提交 SHA 与远端分支一致；交付说明需要用户重启 DSH 后生效。</verify>
  <security>不推 main、不创建 PR；推送失败保留本地提交并报告；不写任何凭证。</security>
  <done>提交与推送完成，交付可追溯。</done>
</task>

## 回滚

- 代码通过本次提交的 git revert 回滚，不重写历史。
- 新导入在确认前无磁盘变化；确认后事务失败即恢复原目录，成功后不保存技能历史版本。
- 预设只创建缺失的本插件目录，已有用户定义不被初始化覆盖；运行中 DSH 不做重启或数据迁移。

## Task Summary 与执行状态

- 基线验证：审查轮 typecheck/lint/build/diff --check 通过，test 1058/1058；缺陷探针均已复现。
- R1/R6/R7/R8/R12/R13：技能资产与调用策略回归通过；创建失败保留原件、容器路径归一、无效包整批拒绝、覆盖先确认、新增及覆盖项一起回滚、旧键转官方键。成功覆盖不留历史目录。
- R2/R3/R4/R5/R9/R14：真实 apply、writer、handler 与 registry 回归通过；引用保存、自身变量/模块生成、启动默认同步、会话 cwd/scope、单项补建均已验证。运行时占用探测整层删除。
- R10/R11/R15：TUI 声明名操作、角色卡正反移除顺序、文件事件强制失效候选回归通过。
- 两个导入入口的真实 Edge smoke 已验证确认前无覆盖重发、取消不写、确认携带准确名单并复用上传载荷；真实已安装 alpha.2 filesystem provider 验证旧键转换后可发现且调用策略正确。
- 完整门禁：typecheck、lint、test **1070/1070（0 跳过）**、build、diff --check 通过。`rebuild:composition` 使用仓库固定 DSH fixture；`sync:yaml` 使用已安装 yaml@2.9.0，两份分发快照无额外内容漂移。
- 执行偏差：三个子代理因服务 403（余额不足）中断，已由主线程接管、复核并完成。完整测试期间发现浏览器 DevToolsActivePort 的 EBUSY 竞态，最小修复为等待文件可读且端口完整；前轮旧路径/契约失败已消除。未修改运行中的 DSH 或真实用户预设。
- 当前仅余提交与 origin/dev 推送；需要用户重启 DSH 后加载新插件代码。

[✔] Wave 0：授权、最新语义、旧 PLAN 原文归档与新计划
[✔] Wave 1 / T1：技能资产与策略修复
[✔] Wave 1 / T2：包内预设命名与生成来源
[✔] Wave 1 / T3：角色卡模块回退
[✔] Wave 2 / T4：候选、刷新与 TUI
[✔] Wave 2 / T5：协调器、bridge 与 UI
[✔] Wave 3 / T6：文档与完整门禁
[ ] Wave 3 / T7：记忆、提交与 origin/dev 推送
