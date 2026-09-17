# 技能管理方案审查（对照 dsh-web 技能中心）

审查日期：2026-09-18。审查对象：[docs/skills-management.md](../../../docs/skills-management.md)（v3「注册层屏蔽」方案）与其实现；
对照基准：`D:\AI\GitHub\dsh-web\packages\dsh-skill-explorer`（技能中心）。

方法与边界：只读源码 + 官方包契约（`dsh-skill` / `dsh-skill-filesystem` 的源码、README 与测试）+ 一次隔离探针
（真实 `SkillRegistry` + 真实 `createSkillsProvider` + 一层预设作用域，脚本跑完即删）。未改产品代码/文档，未提交，
未触碰运行中的 DSH 服务。

## 1. 结论摘要

方案在**单一注册表层内**自洽，且被单元测试锁死；但在本插件的**真实装配**下，影子候选会被预设层官方候选
按官方规则覆盖——停用开关只改变界面与状态文件，不改变模型与用户的实际可用性。

| 级别 | 问题 | 影响 |
|---|---|---|
| **P0** | 注册层屏蔽跨层失效：影子候选（全局层）被预设层官方候选覆盖 | 停用是「假停用」 |
| P1 | v3 不再读旧 `config.yml`，旧停用标记 `SKILL.md.disabled` 无迁移路径 | 历史配置静默失效 |
| P1 | 清单盲区：预设自带、随包、运行时注册、扁平 `.md`、符号链接技能「模型可见、界面不可见」 | 看不到也管不了 |
| P2 | 与 dsh-web 的能力差距（多工作区、项目根创建、远程配对、写身份校验、回收站恢复入口） | 功能缺口 |
| P2 | 两个插件同装时两套「禁用」语义并存，互相打脸 | 用户被误导 |

方案**优于** dsh-web 的部分（应保留）：两端独立停用、无效技能诊断、引用目录与两种导入、整目录回收站、
状态机与损坏保护、缓存指纹失效。

## 2. P0：屏蔽跨层失效（阻断级）

### 2.1 证据链

1. **官方合并规则是「最近层无视优先级直接胜出」**：`dsh-skill` 依次合并 `[全局层, ...scope 链]`，同名后写覆盖前者
   （`deepseek-harness/packages/skill/skill/src/index.ts:551-565`）；官方测试用例名即「最近层无视 rank 胜出」
   （`.../tests/skill.spec.ts:1142-1171`，预设层 rank 900 压掉全局层 rank 10）；官方 README
   （`packages/skill/skill/README.zh.md:84`）同述。
2. **本插件的提供方注册在全局层**：`cordis.patch.yml:1-3` 以 profile 行 `insert` 装配；官方注释说明只有
   「由 agent preset 常驻组合挂载的插件」才落入该 preset 的层（`skill/src/index.ts:346-352`）；注册点是
   `src/index.ts:424-430` 的 `ctx.skills.registerProvider`。
3. **官方文件提供方挂在预设层**：本机真实预设 `standard/agent.cordis.yml:95-96` 有 `skill-filesystem` 行，
   该行正来自本插件模块库 `engine/compositions/library/skill-filesystem-cordis.yml:13-17`。它按默认根提供项目、
   用户、agents、自定义与随包五类技能（`skill-filesystem/README.zh.md:46-56`）。`standard`、`ptc`、`creative`、
   `liangshen`、`anchored` 的预设文件都含该行。
4. **官方读取技能时确实带作用域**：`tool-skill` 渲染目录与加载技能都以 agent 作为 scope
   （`deepseek-harness/packages/skill/tool-skill/src/index.ts:131-134`、`:186`、`:222`），
   而 agent scope 继承其 preset 层（官方测试 `skill/tests/skill.spec.ts:1173-1195`、README `:84`）。
   即真实会话读取必然合并预设层，预设层候选必然参与同名裁决。
5. **隔离探针复现**（模拟上述 1–3）：

```
[无 scope / 全局层视图] prompt-tool | 已由 prompt-tool 在注册层屏蔽（未修改任何技能文件） | model=false user=false
[preset scope / 会话真实视图] dsh-skill-filesystem | 官方候选（用户根） | model=true user=true
[preset scope 加载正文] 官方正文
```

单层视图里影子胜出（这正是现有测试的构造方式），**带作用域的真实会话视图里官方候选胜出，正文可正常加载**。

### 2.2 影响与测试盲区

- 模型端：技能仍在模型可见目录里，`skill` 工具仍可加载；用户端 `/名称` 命令仍可用；界面却显示「已停用」——
  界面与事实背离。
- 现有 `test/host/skill-block-shadow.test.mjs:46-56` 等 10 个用例全部在同一层内构造注册表，没有任何用例带
  `scope`，结构上无法发现该问题。

### 2.3 真机确认：已确认失效（2026-09-18）

机制链先在源码与官方测试层闭合（第 2.1 节第 1–4 条），再用隔离探针复现（第 5 条），最后在运行中的 DSH 服务里
做了一次最小真机验证：

1. 写入临时探针技能 `$DSH_HOME/skills/zz-layer-probe/SKILL.md`，并写入两端屏蔽记录
   `$DSH_HOME/skills/.system/prompt-tool/skills.yml`（`name: zz-layer-probe`，省略 `model`/`user` 即两端屏蔽）。
2. 等待插件 watcher 与官方提供方失效重扫后，**当前会话收到的技能目录替换消息里仍然列出了 `zz-layer-probe`**
   ——即模型侧看到它，管理页却是「两端已停用」。
3. 判定：**注册层屏蔽在当前装配下不生效**，与第 2 节预期一致。
4. 清理已完成：临时技能目录与 `skills.yml` 均已删除，`skills/.system/prompt-tool/` 恢复为只有旧 `config.yml`。

旁证：这次替换也证明「技能目录会在会话进行中热替换」，因此用户不必重开会话即可观察屏蔽是否生效。

补充：不含 `skill-filesystem` 行的预设（本机 `beta-2-42`、`custom`、`minimal`）不经过预设层提供技能，
在这些预设下影子候选是否生效取决于全局层是否还有其他提供方，需单独确认。

### 2.4 修复方向（待授权）

| 方向 | 做法 | 代价 |
|---|---|---|
| A（最贴近现设计） | 让预设常驻组合里多一行由本插件提供的「屏蔽提供方」，在预设层读 `skills.yml` 并产出影子候选 | 需新增可被预设装配的模块入口，并做端到端验证 |
| B（回到文件层） | 与 dsh-web 同机制：改写 frontmatter 的 `disable-model-invocation` / `user-invocable` | 跨层天然有效，但改用户文件，两端独立要写两个字段 |
| C（放弃细粒度） | 屏蔽落到物理动作（把技能目录移入回收站） | 简单可靠，但失去「不改文件即恢复」的特性 |

## 3. P1：迁移缺口（旧配置静默失效）

- v3 只读 `skills/.system/prompt-tool/skills.yml`；全仓检索确认没有任何代码读旧 `config.yml`（`config.yml`、
  `rankBase` 零命中）。
- 本机真实存在旧文件 `$DSH_HOME/skills/.system/prompt-tool/config.yml`：版本 1，含 7 条展示顺序（`order`），
  注释写明旧停用机制是「把 `SKILL.md` 改名为 `SKILL.md.disabled`」。其中 5 个技能目录今天已不存在。
- 后果：展示顺序与 rank 基数静默失效（v3 只按名称排序，`src/client/features/skills/skill-status.ts:63-72`）；
  若历史上用改名停用过技能，v3 会因缺少 `SKILL.md` 整条跳过（`src/host/skills-scan.ts:92-99`），既不展示也无法恢复。
  本机实测无该残留文件，机制缺口成立。
- 建议：补一次性迁移（读 `config.yml` 生成 v3 状态；扫描 `SKILL.md.disabled` 转成屏蔽记录或「历史停用」分组），
  至少在发现旧文件时给一次告警。`scripts/migrate-skills.mjs:46-54` 已会解析旧配置，可复用其读取逻辑。

## 4. P1：清单盲区（模型可见、界面不可见）

| 技能形态 | 官方行为 | 本插件清单 | 对照 dsh-web |
|---|---|---|---|
| 预设自带（`<预设>/skills`） | 经 `customSkillDirs` 提供 | 不在六类根里（`src/host/skills-scan.ts:64-77` 只认自己配置的引用目录） | 同样扫不到，但有运行时候选兜底 |
| 随包技能（bundled） | rank 600 的根 | 仅当环境变量 `DSH_BUNDLED_SKILL_DIR` 存在才有该分组（**本机未设置**） | 从注册表快照拿 bundled 分组 |
| 运行时注册 / 其他插件的提供方 | 注册表可见 | 完全不读 `ctx.skills.snapshot` | 合并注册表独有项（`runtime` 分组） |
| 扁平 `<name>.md` | 官方支持（`skill-filesystem/README.zh.md:36`、`:148`） | 只扫目录，整类跳过 | 支持 |
| 符号链接技能 | 官方支持并预览（`:40`） | `entry.isDirectory()` 对链接为假，整条跳过 | 支持：列出 + 「软链接」徽章 + 拒删保护（`collect.ts:163-183`） |

`docs/skills-management.md:122` 只声明「不支持扁平 `.md`」，既没写符号链接，也没说明这两类技能
「模型能看到、管理页看不到、只能手改状态文件才能屏蔽」。

## 5. P2：与 dsh-web 的能力差距

1. **工作区维度**：dsh-web 汇总活动会话 cwd 集合、提供工作区下拉与「工作区隔离」徽章；本插件只用单个
   `sessionId` 的 cwd（`src/runtime/settings-bridge.ts:906-917`），且屏蔽按名字全局生效
   （`docs/skills-management.md:33` 自认）。
2. **创建目标**：dsh-web 可选用户根或项目 `.dsh/skills`；本插件只写用户根（`src/host/skills-actions.ts:51-73`）。
3. **远程访问**：dsh-web 允许已配对设备经 cookie 使用（`dsh-web .../pair-access.ts:38-49`）；本插件桥只放行
   本机回环（`src/runtime/settings-bridge.ts:94-121`）。
4. **写入身份校验**：dsh-web 要求提交路径等于最新扫描路径，否则 409（`.../routes.ts:106-128`）；本插件的停用
   按名字、删除按目录名，无「技能是否仍是当初那一个」的校验（有回收站兜底）。
5. **回收站恢复入口**：两边都没有界面恢复；本插件记录更完整（`src/host/skills-actions.ts:29-48` 整个目录 +
   `record.json`），dsh-web 只移 `SKILL.md` 单文件。
6. **同装冲突**：dsh-web 的「禁用」改写文件 frontmatter（`.../routes.ts:172-173`），本插件把它读成
   「技能自身声明」（`src/host/skills-scan.ts:124-125`）。两个界面会显示互相矛盾的状态，且在本插件里
   「恢复模型端」无法真正恢复被写进文件的禁用。需要明确「调用策略由谁拥有」。

## 6. 真机验证步骤（待执行）

目的：确认带预设作用域的真实会话视图里，被屏蔽技能是否仍可见/可加载。

1. 在技能页把某个用户根技能两端停用（写入 `skills.yml`）。
2. **新开一个会话**，检查两处：
   - 模型可见目录里是否仍列出该技能（模型自报，或看会话渲染的技能目录）；
   - 让模型调用 `skill` 加载它，若成功即坐实失效。
3. 对照：把该记录删除后，技能应回到可用状态。
4. 验证完清理临时记录。

预期（依据第 2 节证据）：技能仍可见、仍可加载 ⇒ 方案在当前装配下失效。

## 7. 建议顺序（不含执行授权）

1. 先定 P0 的机制归属（A/B/C 三选一）并做真机验证——它决定后续所有技能管理工作的意义。
2. 再补 P1 迁移与告警，避免历史配置继续静默失效。
3. 再补清单盲区（注册表快照 + 扁平/链接扫描），让「模型可见」与「界面可见」一致。
4. 最后按需补 P2 的对照能力，并明确与 dsh-web 同装时的调用策略归属。
