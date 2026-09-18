# 技能管理框架：官方发现、会话快照与可恢复资产操作

## 需求概述与授权

- 用户授权（2026-09-18）：按审查推荐方案完整实施，并明确要求「引用的技能目录中的技能也要能正常开关删除」。本轮直接执行、验证、中文 Conventional Commit 并推送 `origin/dev`。
- 基线：`dev@f485a28a326715f64db922cd65b367b8524911b0`，工作树干净。旧 PLAN 原文归档到 [.scratch/prompt-tool-framework/archive/plan-before-skills-framework-f485a28-20260918.md](.scratch/prompt-tool-framework/archive/plan-before-skills-framework-f485a28-20260918.md)，归档 Git blob 与原文一致：`c82b796248f58770826f93c1c995380abb3c42af`。
- 保留 v4 布局：技能位于原来源，调用策略写入 SKILL.md 官方 frontmatter；skills.yml 只保存 folders。沿用同名导入确认、失败回滚和回收站；不引入技能内容历史或自动搬迁。
- 引用目录技能的开关作用于原文件；删除操作经服务器核验当前引用白名单、条目身份和普通文件/目录边界后，将所选资产移入同一来源根的 `.system/prompt-tool/.trash`，资源随包保留，可人工恢复。确认框显示名称和准确路径。移除文件夹引用仅取消登记，不删除来源内容。
- 发布版 `@deepseek-ai/dsh-skill-filesystem@0.1.6-alpha.1` 已验证支持 custom-only provider、缺失根恢复、观察完整性及 disposer；本轮将其纳入明确依赖，不依赖宿主源码或偶然上层包解析。
- 运行中的 DSH 不停止、不重启；测试只用隔离 cwd/DSH_HOME/随机端口。禁止修改宿主源码，禁止手工修改 lib 或版本化生成快照。

## 审查项与验收

| 编号 | 任务 | 验收 |
|---|---|---|
| S1 | 模型调用边界 | 搜索不显示模型停用项；直接按名加载也拒绝；加载前后策略变更不能绕过 |
| S2 | 官方解析一致性 | yes/no/on/off/1/0 等官方策略与实际候选一致，非法值不被当成正常技能 |
| S3 | 单端写入 | 两个旧页面分别关闭不同端，最终两端均关闭；不覆盖另一端或外部正文修改 |
| S4 | 官方候选生命周期 | 缺失根创建、删除、恢复均失效；folders 变更释放旧注册与 watcher；失败保留可读项并标 complete=false |
| S5 | 会话快照 | 同 cwd/scope 的清单与官方胜出项一致；未知/不完整不冒充生效；空清单不回退旧 settings |
| S6 | 搜索与资源 | 中文关键词实际筛选；加载保留官方资源基址和渲染格式 |
| S7 | 导入边界 | 超限在读取前拒绝；提交后清理失败报告已提交和清理提示；提交前失败仍恢复原件 |
| S8 | 引用目录操作 | 引用技能可单端开关、恢复、删除；重复名称/目录名只操作确认的准确路径；目录、资源可恢复 |
| S9 | 写入白名单 | 伪造路径、移除后的引用、路径穿越、符号链接与只读目标被拒绝；失败不误删其他用户文件 |
| S10 | 客户端收口 | 资产操作走数据层；局部技能刷新不重载其他草稿；删除确认与提交来自同一条目 |

## 影响面与规划门禁

- 读取：官方 provider → SkillRegistry.snapshot → host 清单投影 → bridge → client；本地扫描只负责管理资产/诊断，不再贡献自己的解析候选。
- 写入：shared 身份及单端意图 → bridge 白名单 → host YAML/资产事务 → 官方失效 → 新会话快照。策略字段不进入 settings。
- engine 消费通过既有 host-package 解析官方包，复用 isModelInvocable/renderSkillContent；保持 skill-search 可选。
- 主线程拥有 shared、index、bridge、依赖、文档和最终集成；子任务独占 host 资产、provider 生命周期或 engine 消费写区。并行期不运行 build。
- 沿用 Node test runner，覆盖缺陷红绿、真实发布 provider/registry、跨窗口操作和 UI 行为，不新增测试框架。
- [✔] 执行授权及引用删除范围；[✔] 文件/宿主边界；[✔] 发布 API 实测；[✔] 原缺陷复现；[✔] 回滚路径；[✔] 写区互斥。调用方由审查及 rg 复核，图谱只作加速、不替代调用证据。

## Wave 1：共享契约与核心行为

<task type="auto">
  <name>T1：模型消费与官方调用策略</name>
  <files>engine/skill-search.mjs、test/engine/tool-module-mount.test.mjs</files>
  <action>搜索/加载执行模型调用策略，支持中文关键词，复用官方资源渲染和宿主包解析。</action>
  <verify>真实 registry 四种策略、直接加载拒绝、策略变更、中文搜索、相对资源、主子会话 scope 与 disposer。</verify>
  <security>停用内容不进入注入消息；保留 abort、scope/cwd 与模型边界。</security>
  <done>S1/S6 红绿闭合，模块保持 opt-in。</done>
</task>

<task type="auto">
  <name>T2：单端文件写入与引用资产删除</name>
  <files>src/runtime/skills-parse.ts、src/host/skills-policy.ts、skills-actions.ts、skills-import.ts；对应 host 测试</files>
  <action>收敛官方策略校验；支持单端意图并保留另一端；事务内外部修改检查；回收站支持经核验的引用来源；修复读取前限额与提交后清理状态。</action>
  <verify>两旧页面、官方布尔写法、原文保留、链接/越界拒绝、回收站恢复、读取前限额、提交后 EACCES、导入回滚。</verify>
  <security>不碰真实用户目录；同目录暂存与原子切换；删除保留资源与恢复记录。</security>
  <done>S2/S3/S7/S8/S9 核心操作通过。</done>
</task>

<task type="auto">
  <name>T3：官方 provider 与技能运行时归位</name>
  <files>src/host/skills-provider.ts、skills-refresh.ts、skills-scan.ts、skills-runtime.ts、src/runtime/skills-watcher.ts；对应 host 测试</files>
  <action>custom-only 官方 provider 取代自建候选与根监听；状态/缓存/生命周期移出 index；坏状态文件保留有效配置，保留官方 complete。</action>
  <verify>真实 provider 缺失根创建/删除/恢复、配置替换、失败完整性、跨 scope 胜出项、卸载无晚到刷新。</verify>
  <security>只注册引用根，不重复提供默认根；注册和 watcher 随 Cordis disposer 释放。</security>
  <done>S4 与统一 host 清单入口可接线。</done>
</task>

## Wave 2：bridge 与 UI 接线

<task type="auto">
  <name>T4：契约、服务端身份与会话快照</name>
  <files>src/shared/skills.ts、src/shared/bridge-contract.ts、src/index.ts、src/runtime/settings-bridge.ts、src/runtime/tui.ts；shared/host 测试</files>
  <action>先定义单端写入、删除身份与 complete；从 settings 删除技能 facts；同会话 scope/cwd 投影快照；写入目标重新命中当前来源，只允许用户根及显式引用根删除。</action>
  <verify>真实 handler 引用操作、伪造/同名/陈旧引用/只读源拒绝、空/未知/不完整快照、TUI 两端启停。</verify>
  <security>保留 loopback、Origin/Host、body 限额；请求不能凭 path 自授权。</security>
  <done>S5/S8/S9 服务端闭合。</done>
</task>

<task type="auto">
  <name>T5：技能数据层与管理页</name>
  <files>src/client/data/、src/client/features/skills/、src/client/locales.ts；client 测试与 UI fixture</files>
  <action>统一导入入口及局部刷新；单端提交明确值；空快照清空；按能力开放引用删除；确认显示准确路径；区分声明权限与实际会话状态。</action>
  <verify>引用开关/删除、跨源同 folder、取消零写入、空列表、刷新错误/草稿保护、覆盖确认与无障碍。</verify>
  <security>客户端能力仅呈现，服务器重新核验；UI 不复制资产转换或写盘。</security>
  <done>S3/S5/S8/S10 可操作且有行为测试。</done>
</task>

## Wave 3：验证与交付

<task type="auto">
  <name>T6：完整验证、稳定文档与生成产物</name>
  <files>docs/skills-management.md、docs/ui-architecture.md、README.md、PLAN.md；固定脚本生成物</files>
  <action>复核子任务并同步稳定行为，执行 rebuild:composition/sync:yaml/typecheck/lint/test/build/diff --check；完成真实 UI 及隔离宿主检查。</action>
  <verify>反例全绿，完整测试通过，引用来源权限/删除白名单闭合，生成快照来源固定。</verify>
  <security>cwd 与临时 DSH_HOME 在 D:/AI/workspase/_temp；不停止共享 DSH，不写真实技能目录。</security>
  <done>证据齐全，未验证项显式披露。</done>
</task>

<task type="auto">
  <name>T7：记录、提交与推送</name>
  <files>PLAN.md、.ai-memory/20260918/daily.md、本轮任务文件</files>
  <action>追加项目记录及状态，只暂存任务文件，中文 Conventional Commit 并推送 origin/dev。</action>
  <verify>暂存 diff 与验收一致、提交与远端 SHA 对齐、工作树清晰。</verify>
  <security>.ai-memory 不入库；不推 main、不创建 PR、不重写历史。</security>
  <done>交付修改、验证、SHA、分支及重启说明。</done>
</task>

## 回滚

- 代码以 git revert 回滚本轮提交，不重写历史。
- 技能布局及 v4 状态兼容；引用删除可从对应来源根回收站恢复整个包。
- 导入提交前失败恢复旧资产；提交成功但清理失败明确报告已提交和残留信息。
- 不操作实际技能和运行中服务；新代码需要用户重启 DSH 后加载。

## Task Summary 与执行状态

- 共享调用链：官方发布 provider → 真实 registry → 会话 snapshot → bridge → UI 已接通，移除 index 中的自建候选/指纹缓存与 settings 技能副本。
- 主线程复核：模型入口 16/16、文件与官方解析对照 42/42、runtime + 真实 bridge 8/8；显式引用其他工作区 `.agents/skills` 的删除红灯已转绿。
- 真实 Edge 三组 smoke 通过，覆盖引用条目开关/删除、同 folder 跨来源身份、局部刷新保留草稿、慢响应与会话切换。
- 完整门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`（1077/1077，零失败零跳过）、`pnpm build`、`git diff --check` 全部通过，所有命令从隔离 cwd 启动。
- 生成物：`rebuild:composition` 按仓库 `test/fixtures/dsh/current` 固定输入重建 24 份官方组合，`sync:yaml` 按已安装 yaml@2.9.0 同步；版本化快照无内容变化，lib 不提交。
- 新依赖仅为已发布官方能力 `dsh-skill-filesystem` 与其 `fs/observed` 类型归属 `dsh-fs`，均锁定 0.1.6-alpha.1。
- 运行中 DSH 和真实用户技能未操作；新插件代码需用户重启 DSH 服务后生效。审查轮的临时 provider 依赖目录清理曾被自动审批拦截，未绕过；本轮测试创建的隔离资产由测试清理。

[✔] Wave 0：授权、范围、旧 PLAN 原文归档及新方案
[✔] Wave 1 / T1：模型消费（主线程复跑 16/16，含真实 registry 与四种调用策略）
[✔] Wave 1 / T2：文件策略与资产事务（主线程复跑 42/42，含发布 provider 对照、引用回收站及失败事务）
[✔] Wave 1 / T3：官方 provider 与运行时
[✔] Wave 2 / T4：shared、index 与 bridge
[✔] Wave 2 / T5：客户端
[✔] Wave 3 / T6：完整验证与文档
[ ] Wave 3 / T7：提交与 origin/dev 推送
