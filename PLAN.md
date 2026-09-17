# 技能实体库与链接管理实施计划

## 授权与基线

- 用户在完成技能管理与 dsh-web 对比审查后明确要求「执行该方案」（2026-09-17）。
- 基线：dev@a5f737f67e471fc62c8563921842fa518a9e2562，工作树干净。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-tests-a5f737f-20260917.md)；归档必须与基线 PLAN 的 Git blob 一致。
- 审查证据：本项目 13 项问题（10 项行为复现、3 项调用链确认）；dsh-web 4 项反例；官方 provider 的隐藏/链接/取消链接 3 态探针通过。临时报告：D:/AI/workspase/_temp/skills-management-review-20260917.md。

## 用户决策与最终行为

1. 技能实体集中于 $DSH_HOME/skills/.system/；该根 skills.yml 是启停、排序、模型/用户调用权限的统一管理来源。
2. 上层 skills 仅以目录链接暴露已启用条目；Windows 使用 junction。完全停用只取消本插件拥有的链接，保留实体与资源，不再持续使用 SKILL.md.disabled。
3. YAML 同步实体 SKILL.md 的 disable-model-invocation/user-invocable；外部修改这两个字段时按 YAML 恢复并提示一次偏差，正文/未知字段/注释保持。
4. 保留嵌套、批量启停、排序与 rank；每个独立嵌套技能有自己的启用链接。管理身份与官方 name 分开。
5. 借鉴模型调用开关、来源筛选、创建与回收站删除；所有受管实体仍集中在 .system。外部目录作为导入来源，不成为绕过启停的第二发现根。
6. 本轮授权代码实现与当前技能目录的可回滚迁移；不改 DSH 源码、不重启服务、不清理未知用户文件，不操作 main 或 PR。
7. 本轮特定 .system 技能实体/YAML 写入是用户明确指定的范围；不扩大到官方预设 system 或其他 .system 所有者。旧的「不迁移」「仅标记改名」文档由本轮行为替换。
8. 用户进一步明确：不再管理技能版本，由用户显式导入覆盖或手动更新；取消包内技能哈希账本和自动更新/恢复，不以包内内容回滚用户修改。迁移的完整性校验与失败恢复只保护原文件，不构成技能版本库。
9. 用户明确废弃 .disabled 方案：普通读取、导入与迁移均不识别、不转换、不创建此标记；仅支持标准 SKILL.md。存在旧标记时要求用户先自行整理，不静默导入成已启用状态。
10. 用户随后授权：交付前单独手动恢复现有 .disabled 标记为 SKILL.md；此操作不进入产品兼容代码。先完整盘点并核对目标冲突，两份并存时不覆盖；恢复后再验证受管状态。

## 范围与不变量

- 文件夹导入、旧根迁移、单项修复统一落到实体库；包内技能仅作为用户可导入资源，不再自动同步。显式导入可覆盖同一受管实体，未确认归属的其他目录仍拒绝覆盖；不增加依赖，不新增通用文件管理器或第二注册表。
- 账本外同名用户内容不被覆盖；导入不写保留命名空间；取消链接前同时核对路径与目标；实体/标记的符号链接不得绕过所有权边界。
- YAML 使用 Document API；语法/类型/别名错误返回明确失败，逐技能错误不影响健康项。
- YAML、frontmatter、链接更新串行并可回滚；失败不把 UI 草稿标为已保存；缺失/损坏配置不被默认值覆盖。
- 迁移先预检与备份，逐项切换并验证；保留回滚记录与用户原内容。artifacts、其他插件配置、未经所有权确认的路径不迁移。
- watcher 覆盖实体、YAML 与链接，变更先刷新缓存再发布；注册按 name 确定稳定优先级，管理按独立 id。
- 所有测试在 D:/AI/workspase/_temp；临时 DSH_HOME；不重启或终止真实服务。

## 依赖与规划门禁

- 调用闭包：skills-config/skill-toggle/profile-skills/skills-import → index.ts provider 与 watcher → settings-bridge/shared bridge → client store/SkillsPage/SkillRow → host/shared/client tests。
- 以 rg 全调用点复核。dev-expert 图谱工具固定输出 .ai-memory/knowledge-graph，违反仓库「流程产物不放 .ai-memory」规则，故不用该生成器，不扩大修改技能工具。
- 已检查目标文件与工作树；无新库或数据库；所有写盘/链接操作安排冲突、回滚和边界反例；真实迁移在代码门禁通过后执行。
- YAML 与已安装宿主契约为权威；不依据模型措辞验收。

## Wave 1：存储与契约

<task type="auto">
  <name>T1：共享技能状态与实体库事务</name>
  <files>src/shared/skills.ts、src/host/skills-config.ts、src/host/skills-library.ts、src/host/skill-toggle.ts、test/host/skills-library.test.mjs、test/host/skills-config.test.mjs、test/host/skill-toggle.test.mjs</files>
  <action>定义稳定技能身份、相对实体路径、链接名和调用策略；在 .system/skills.yml 读写；实现受管链接启停与官方字段同步、互斥/冲突/失败回滚、偏差修复，拒绝未知目标。</action>
  <verify>真实临时文件系统：隐藏实体、启停幂等、策略同步且保留正文/注释、未知链接/目录保护、坏 YAML 和失败回滚、同名冲突。</verify>
  <security>验证路径白名单、realpath/lstat、保留目录、参数类型/上限；删除仅作用于已确认的链接，不能递归删除实体。</security>
  <done>核心 API 与最小确定性回归通过。</done>
</task>

<task type="auto">
  <name>T2：导入、迁移及回收站，移除包自动同步</name>
  <files>src/host/skills-import.ts、src/profile-skills.ts、src/host/skills-migration.ts、src/host/skills-actions.ts、scripts/migrate-skills.mjs、test/host/skills-import.test.mjs、test/host/skills-migration.test.mjs</files>
  <action>复用 T1 API；单技能与容器导入保留正确布局；复制来源进隐藏实体库，拒绝覆盖未拥有目录；创建与回收站统一事务；旧根迁移支持 preview/apply/rollback，内容校验、备份清单和幂等重试。</action>
  <verify>导入→扫描→启停→资源加载；同名用户文件不变；预览零写入、迁移后资源哈希不变、取消链接保留实体、回滚复原、嵌套技能与旧停用态。</verify>
  <security>拒绝 .system/账本/上跳/绝对上传路径；迁移先验证绝对目标与所有权，保留备份，不清理未知文件。</security>
  <done>所有资产入口只产生受管实体与状态；可执行迁移/回滚探针通过。</done>
</task>

## Wave 2：宿主与界面（依赖 Wave 1 的共享契约）

<task type="auto">
  <name>T3：注册、watcher、bridge 与异常隔离</name>
  <files>src/index.ts、src/runtime/settings-bridge.ts、src/runtime/skills-provider.ts、src/runtime/skills-parse.ts、src/runtime/skills-watcher.ts、src/runtime/skill-fix.ts、src/shared/bridge-contract.ts、src/config.ts、对应 host/shared tests</files>
  <action>入口仅编排实体库；管理目录包含停用/无效项，模型 provider 仅按已启用链接/有效状态注册；按官方 name 去重，移除客户端任意 dir 授权；接通状态、策略、导入目录、创建、删除端点；逐文件隔离 YAML 错误与修复结果验证。</action>
  <verify>真实 provider/bridge 的状态与路径行为；watcher 冷热重挂、配置与实体变更、disposer；审查 F3/F5/F6/F10/F12/F13 的反例转绿。</verify>
  <security>loopback/Host/Origin/载荷上限与统一错误保持；写入只命中受管 id，不能把 .system 当模型自定义扫描根。</security>
  <done>宿主所有调用链闭合且相关契约测试通过。</done>
</task>

<task type="auto">
  <name>T4：技能管理页面与保存语义</name>
  <files>src/client/features/skills/*、src/client/data/use-prompt-tool-store.ts、src/client/data/prompt-tool-fields.ts、src/client/data/prompt-tool-view.ts、相关 locales、client tests</files>
  <action>使用稳定 id；完整展示缺祖先的嵌套项；完全停用/模型调用/用户调用分别操作；提供来源筛选、创建、回收站与目录导入；等待技能保存成功才更新保存基线。</action>
  <verify>真实 SSR/store 回调断言正确目标、调用策略、嵌套渲染、创建/删除载荷、延迟/失败保存；保持既有技能管理与键盘交互。</verify>
  <security>不由客户端拼任意写入路径；复用 bridge 与现有 UI 组件，正文不经 settings，失败保留草稿。</security>
  <done>新交互可用，审查 F4/F8/F9 的行为回归通过。</done>
</task>

## Wave 3：验证、迁移与交付

<task type="auto">
  <name>T5：集成门禁与文档</name>
  <files>README.md、docs/ui-architecture.md、docs/skills-management.md、PLAN.md、对应集成测试</files>
  <action>同步权威行为与迁移命令；复核并行产出；运行 typecheck/lint/test/build/diff --check；以实际官方 provider 验证链接、策略与资源。</action>
  <verify>完整门禁全通过，定向缺陷反例转绿；无未声明生成物/依赖/源码越界；报告所有未验证限制。</verify>
  <security>安装副本所有权、保留路径、失败回滚与缓存隔离经过测试；未知用户文件不变。</security>
  <done>集成可交付，所有必要行为与文档命令可验证。</done>
</task>

<task type="auto">
  <name>T6：真实技能迁移、回滚证据与提交</name>
  <files>D:/AI/DeepSeek harness/.dsh/skills 中预检确认的技能目录及本插件状态；PLAN.md；本地 daily.md</files>
  <action>只读预览当前顶层与嵌套技能，核对预期哈希/冲突；使用已通过测试的迁移入口执行并保留备份/回滚记录；只读验证实际目录、官方发现与资源；中文 Conventional Commit 推送 origin/dev。</action>
  <verify>迁移前后技能实体/资源内容与旧调用策略一致；启用链接与 YAML 一致，非技能/未知配置不变；Git 暂存只含本轮文件，远程 dev 推送成功。</verify>
  <security>不停止/重启 DSH；不清理唯一备份；真实迁移前核验最终绝对路径；提交不含 .ai-memory 或真实 DSH 数据。</security>
  <done>真实迁移结果与可回滚路径明确，提交 SHA/推送/重载要求完成交付。</done>
</task>

## 回滚

- 开发回滚保留用户历史；必要时 revert 本轮提交，不用 reset/clean/checkout 覆盖。
- 数据回滚使用迁移记录与保留的原目录，先核对现有链接及实体内容；发生外部变更则报告冲突，不覆盖。
- 包内更新与单项状态写失败恢复旧配置/标记/链接；清理仅限本次拥有的临时目录。
- 服务保持运行；新宿主代码需用户重启 DSH 后加载，迁移不能依赖自动重启。

## Task Summary 与状态

- 当前：T1–T5 完成并通过完整门禁。T6 的真实迁移先只读预览（87 个技能、0 个嵌套、旧 order 过滤后剩 2 项、无 rankBase），再由用户授权执行；实测真实技能根 0 个 `.disabled` 标记，无需恢复。
- 验证：`typecheck` ✓ / `lint` 0 warning 0 error ✓ / `test` **1013/1013**（较基线 +5）✓ / `build` ✓ / `verify:host` 47 包 0 失败 ✓ / `git diff --check` ✓。
- 偏差与说明：①迁移落在一次性运维脚本 `scripts/migrate-skills.mjs`（未新增运行时 `src/host/skills-migration.ts`）；②外部目录降级为导入来源后，客户端「目录引用」入口一并下线（`skillsDirs` 只读、新增来源筛选 / 创建 / 回收站 / 模型与用户调用开关）；③技能顺序与 rank 的写入结果纳入整体保存基线（审查 F9）；④`dirs` 清空下沉到受管库层，`patchSkillsConfig` 不再重复置空；⑤技能树按「最近存在的技能祖先」挂载，缺祖先的嵌套项作为根行（审查 F8）。
- 回归入口：`docs/skills-management.md` §7 列出技能契约的全部测试与命令。

[✔] Wave 1 / T1：状态与链接事务
[✔] Wave 1 / T2：资产入口与可回滚迁移
[✔] Wave 2 / T3：宿主、provider、bridge
[✔] Wave 2 / T4：界面与保存语义
[✔] Wave 3 / T5：完整验证与文档
[ ] Wave 3 / T6：真实迁移与提交推送
