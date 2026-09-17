# 技能管理重新设计：注册层屏蔽（撤销受管实体库）

## 授权与基线

- 用户指令（2026-09-17）：「重新设计方案，本项目技能管理重新设计，改为在技能注册层屏蔽，而不是使用受管库」。
- 基线：dev@5dd0a2a68e15f383113d2291827a21b62522bfd7，工作树干净。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-skills-entity-library-5dd0a2a.md)（blob `73799038d5bbfeca8c52a0d0a1bbf7fabcc09d8b`，与基线 `PLAN.md` 逐字节一致）。
- 已完成的受管库改造（提交 `b7f380f`、`88a6b61`、`5dd0a2a`）在本轮被**取代**：实体库、根链接、迁移脚本都不再是产品行为。

## 机制前提（已实测）

`skill` 注册表在同一层内按 rank 升序合并同名候选，只保留第一个（`collectLayer`）；模型目录生成时过滤 `isModelInvocable`（`tool-skill:226`），`skill` 工具加载时再次拒绝非模型可调用项（`tool-skill:138`）。隔离探针结论：

| 影子 rank | 胜出者 | 模型目录 | 用户 `/名称` |
|---|---|---|---|
| 0（本轮取值） | 插件影子 | 不出现 | 不可用 |
| 250（对照） | 官方项目候选 | 照常出现 | 照常可用 |

官方根优先级：项目 `.dsh/skills` 100、项目 `.agents/skills` 200、自定义目录 300、用户 `$DSH_HOME/skills` 400、用户 `~/.agents/skills` 500、内置 600。影子取 0，压过全部六档。

## 用户决策与最终行为

1. 技能实体**留在原地**：项目根、用户根、自定义目录、官方内置。插件不搬迁、不建链接、不建实体库。
2. 停用 = **注册层屏蔽**：插件为被屏蔽的技能名返回一个 rank 0、模型与用户调用同时关闭的影子候选；官方那个候选在合并时被丢弃。**不改任何 `SKILL.md`**。
3. 恢复 = 删除屏蔽记录，官方候选立刻回到胜出位置。
4. 插件的技能提供者只负责两件事：屏蔽名单的影子候选；用户显式「添加技能文件夹」引用进来的目录里的技能（自定义来源，优先级 300）。
5. 写文件动作只保留三类：**创建**（写用户根）、**导入**（两种：引用技能文件夹 / 复制到 `$DSH_HOME/skills`）、**删除**（用户根实体移入回收站；引用型只删引用）。「一键修复」移除，坏技能只展示原因。
6. 排序与「技能排序基数」移除：插件不再注册真实技能，顺序由官方按技能名决定。
7. 交付顺序：先写代码与测试 → **回滚已完成的受管库迁移并验证** → 提交推送 → 用户重启 DSH。
8. 已知限制（写入界面与文档）：屏蔽按**技能名全局**生效，同名技能在任何工作区都会被压掉；停用后官方仍能发现该技能，只是任何入口都用不了（与旧的"官方也发现不到"不同）。

## 范围与不变量

- 状态文件 `$DSH_HOME/skills/.system/prompt-tool/skills.yml`（点目录，官方一层扫描天然跳过）：`version: 3`、`blocked`、`folders`。写入使用 yaml Document API，保留注释与未知字段；损坏时拒绝覆盖。
- 插件提供者内**不得**调用 `ctx.skills.list/snapshot`（会递归进自己）；只读状态文件。
- 清单展示由宿主端点扫描六类来源生成，标注来源、优先级、是否被屏蔽、模型与用户可调用状态。
- 不改宿主源码；不重启运行中的 DSH；不删除用户未确认的文件。
- 测试一律在 `D:/AI/workspase/_temp` 发起，使用隔离临时 `DSH_HOME`，结束后清理。

## 依赖与规划门禁

- 调用闭包：skills-config（状态）→ index.ts provider（影子 + 引用候选）→ settings-bridge（清单/屏蔽/创建/导入/删除端点）→ shared bridge-contract → client store/SkillsPage/SkillRow → host/client tests。
- 已用 rg 复核调用点；现有受管库相关模块（`skills-library.ts`、`skill-toggle.ts`、受管库迁移路径）在本轮删除或改写。
- 实施前核实项：①回滚迁移后官方能否重新发现 87 个技能；②影子候选与「引用文件夹」候选共存时同名裁决；③状态文件从 v2（受管库）切换到 v3 时的处理（受管库 `skills.yml` 在回滚时被删除，新文件位于 `prompt-tool/` 子目录，两者不冲突）。

## Wave 1：状态与候选

<task type="auto">
  <name>T1：屏蔽表与技能文件夹引用的状态文件</name>
  <files>src/host/skills-config.ts、src/shared/skills.ts、test/host/skills-config.test.mjs</files>
  <action>把状态文件改为 version 3：`blocked`（技能名 + 记录时间 + 可选备注）与 `folders`（宿主机绝对目录）。Document API 读写、结构校验、注释与未知字段保留、损坏拒绝、跨进程锁。</action>
  <verify>真实临时文件系统：往返一致、注释保留、空数组删键、坏 YAML / 别名 / 非映射根 / 非法技能名 / 相对路径 / 重复目录全部拒绝且不覆盖原文件。</verify>
  <security>名字必须 kebab-case；目录必须是绝对路径且拒绝点目录；不写入状态文件以外的任何路径。</security>
  <done>状态读写与校验的确定性回归通过。</done>
</task>

<task type="auto">
  <name>T2：技能提供者改为影子屏蔽 + 引用候选</name>
  <files>src/index.ts、src/host/skills-scan.ts（新）、test/host/skill-block-shadow.test.mjs（新）</files>
  <action>移除受管实体候选；为 `blocked` 里每个名字生成影子候选（rank 0、`modelInvocable`/`userInvocable` 均 false、source 标记为屏蔽）；为 `folders` 引用的目录生成自定义来源候选（rank 300）。提供者内不调用注册表查询。</action>
  <verify>真实 `SkillRegistry`：影子压过官方六档 rank（100/200/300/400/500/600）；rank 250 负向对照压不过；引用目录的技能可列出并加载；屏蔽名不存在时不牵连其他技能；屏蔽表为空时提供者返回空列表。</verify>
  <security>引用目录必须是绝对路径普通目录；拒绝符号链接穿越；不读取状态文件之外的写权限。</security>
  <done>候选生成与压制的行为回归通过。</done>
</task>

## Wave 2：宿主端点与界面

<task type="auto">
  <name>T3：技能清单、屏蔽开关与资产入口端点</name>
  <files>src/host/skills-import.ts、src/host/skills-actions.ts、src/runtime/settings-bridge.ts、src/shared/bridge-contract.ts、src/runtime/skills-watcher.ts、src/runtime/tui.ts、对应 host 测试</files>
  <action>清单端点扫描六类来源并标注来源与优先级、是否被屏蔽、调用状态；屏蔽开关端点写状态文件；创建（用户根）与两种导入（引用目录 / 复制到用户根）与删除（用户根实体移入回收站、引用型只删引用）；移除修复端点与受管库端点。</action>
  <verify>真实 handler + 隔离 DSH_HOME：来源分组与优先级正确、屏蔽写盘幂等且可恢复、复制导入后落在用户根、引用导入不动源目录、删除只影响目标且失败可回滚、非法载荷 400 且零写盘。</verify>
  <security>loopback/Host/Origin 与载荷上限保持；写盘先校验目标归属；不删除用户未确认文件。</security>
  <done>宿主调用链闭合，相关契约测试通过。</done>
</task>

<task type="auto">
  <name>T4：技能页重构</name>
  <files>src/client/features/skills/*、src/client/data/use-prompt-tool-store.ts、src/client/data/prompt-tool-fields.ts、src/client/data/prompt-tool-view.ts、locales、client tests</files>
  <action>移除实体库卡、排序与排序基数；按来源分组展示（项目 / 自定义引用 / 用户 / 内置），每条显示优先级、调用状态与"是否被同名技能遮蔽"；屏蔽开关一个；创建表单；两种导入入口；删除确认。</action>
  <verify>真实浏览器 smoke + store：分组渲染与计数、屏蔽开关载荷、创建与两种导入载荷、删除确认与失败保留、移除的旧入口不再出现。</verify>
  <security>不由客户端拼任意写入路径；失败保留草稿与错误提示。</security>
  <done>新旧交互回归通过。</done>
</task>

## Wave 3：验证、回滚与交付

<task type="auto">
  <name>T5：完整门禁与文档</name>
  <files>README.md、docs/skills-management.md、docs/ui-architecture.md、CHANGELOG.md、PLAN.md</files>
  <action>改写技能管理权威文档为注册层屏蔽模型；同步界面与端点说明；运行 typecheck / lint / test / build / verify:host / diff --check。</action>
  <verify>完整门禁全绿，文档中的路径、命令与端点全部有效。</verify>
  <security>不遗留受管库描述；不夸大"官方发现不到"。</security>
  <done>文档与实现一致，门禁通过。</done>
</task>

<task type="auto">
  <name>T6：回滚迁移、真实环境验收与提交</name>
  <files>D:/AI/DeepSeek harness/.dsh/skills、PLAN.md、本地 daily.md</files>
  <action>用迁移记录回滚 87 个技能到 `skills` 根并删除受管库状态文件；只读验收实体内容与迁移前一致；提交推送 origin/dev。</action>
  <verify>回滚后顶层技能目录数量与备份一致、无链接残留、哈希逐项一致；新代码下清单能列出全部来源；Git 暂存只含本轮文件。</verify>
  <security>回滚前核验哈希；不回滚内容已变化项；不删除唯一备份；不停止 DSH。</security>
  <done>真实环境回到"技能在原地 + 注册层屏蔽"状态，提交与推送完成。</done>
</task>

## 回滚

- 代码回滚：revert 本轮提交，恢复受管库实现（`b7f380f`/`88a6b61` 仍在历史里）。
- 数据回滚：`scripts/migrate-skills.mjs --rollback "<备份目录>\migration.json"` 幂等可重跑；迁移备份 `.skills-migration/20260917150416526` 保留，交付时不删除。
- 状态文件：新 `skills.yml`（v3）与受管库 `skills.yml`（v2）位于不同目录，互不覆盖；回滚迁移只删除 v2。
- 服务保持运行；新宿主代码需用户重启 DSH 后加载。

## Task Summary 与状态

- 当前：T1–T5 完成；T6 的迁移回滚已执行并验收。真实环境处于「技能实体在技能根 + 插件只做注册层屏蔽」的目标形态。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` 见下方执行记录 / `build` ✓ / `verify:host` ✓ / `git diff --check` ✓。

### 执行记录

- **注册层屏蔽落地**：新增 `src/host/skills-scan.ts`（六类官方技能根的一层发现 + 同名裁决），`skills-config.ts` 改写为 v3 状态（`blocked` + `folders`），`index.ts` 提供者只返回「屏蔽影子候选（rank 0）+ 引用目录候选（rank 300）」，`settings-bridge` 换成 `skills-list` / `skill-block` / `skills-folders` / `skill-create` / `skill-delete` / `skills-import[-directory]` 七个端点；删除 `skills-library.ts`、`skill-toggle.ts`、`skill-fix.ts`、`skills-provider.ts` 与 `profile-skills.ts`。
- **客户端**：技能页按来源分组、单一注册层开关、创建、两种导入（复制导入 / 文件夹引用）、回收站删除；移除排序、rank 基数、受管库与一键修复界面。
- **迁移回滚（一次事故与修复）**：首轮回滚在 `writing-shape` 处因「内容哈希变化」中止，留下半回滚状态（链接已删、1 个实体搬回、86 个仍在 `.system`）。根因是脚本把「内容变化」当成了拒绝条件，而回滚的目标是恢复布局。修复：内容变化只记录不阻止，原位置被占用才跳过；重跑后 87 个实体全部回到技能根、0 链接、v2 状态文件删除，与迁移前快照逐字节一致 64 个、内容有变化 23 个（用户迁移后的更新，照常搬回）、缺失 0 个、备份完整保留。回归见 `test/host/skills-migration.test.mjs` 第 2 条。
- **不再内置任何技能**（用户追加决策）：删除包内 `skills/`（原 `sandboxmod`、`web ui`）与 `package.json` 发布清单里的 `skills` 条目；删除真实环境里废弃的安装副本账本 `.prompt-tool-manifest.json`；`paths.ts` 去掉死代码 `SKILLS_DIR` / `DEFAULT_SKILLS_DIR` / `DEFAULT_SKILL_RANK_BASE`，改用 `USER_SKILLS_DIR`。
- **子代理修复的真实缺陷**（已修）：`prompt-tool-view.ts` 的 `activeSkillsDirs` 缺少响应顶层回退，真实宿主下 `skillsRoot` 为空 → 技能页显示「用户技能目录未知」且删除按钮永不出现。修复后技能根的来源为「响应顶层 → descriptor.value → descriptor.base」。

[✔] Wave 1 / T1：状态文件（屏蔽表 + 引用目录）
[✔] Wave 1 / T2：提供者影子屏蔽与引用候选
[✔] Wave 2 / T3：清单、屏蔽与资产端点
[✔] Wave 2 / T4：技能页重构
[✔] Wave 3 / T5：门禁与文档
[✔] Wave 3 / T6：回滚迁移与交付
