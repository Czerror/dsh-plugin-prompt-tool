# 技能管理：官方发现、会话快照与文件策略

管理页展示技能来源、文件调用策略和当前会话的注册状态，并提供创建、导入与可恢复删除。
技能启停不搬迁实体、不建链接、不改正文：策略写回原文件。用户技能根和显式引用目录中的普通技能均可删除到各自来源根的回收站。

本文是该行为的权威说明。改动 `src/shared/skills.ts`、`src/host/skills-*.ts`、`src/runtime/settings-bridge.ts`
的技能端点、`src/index.ts` 的技能提供者或 `src/client/features/skills/*` 前先读本文。

## 1. 技能从哪来

官方 `dsh-skill-filesystem` 按六类根发现技能（优先级数值越小越优先，同名裁决只在同一层内按此顺序取首个）：

| 来源（`source`） | 位置 | 优先级 |
|---|---|---|
| `project-dsh` | `<项目根>/.dsh/skills` | 100 |
| `project-agents` | `<项目根>/.agents/skills` | 200 |
| `custom` | 用户在管理页添加的技能文件夹 | 300 |
| `user-dsh` | `$DSH_HOME/skills` | 400 |
| `user-agents` | `$DSH_AGENTS_HOME/skills`（默认 `~/.agents/skills`） | 500 |
| `bundled` | 官方内置技能目录 | 600 |

项目根 = 从会话工作目录向上找到的第一个含 `.git` 的目录。发现目录包 `<根>/<目录名>/SKILL.md` 与直属 `<根>/<名称>.md`，不递归嵌套。

引用目录由已发布的 `@deepseek-ai/dsh-skill-filesystem` 提供候选：独立 `providerName=prompt-tool`、`includeDefaultRoots=false`、`customSkillDirs=folders`。默认根继续由宿主原有 provider 发现。
官方 provider 负责解析、正文加载、目录监听、缺失根恢复和候选失效；插件自己的扫描仅补充管理资产与无效文件诊断。
插件**不内置任何技能**：包内没有 `skills/` 目录，也没有安装副本或内容哈希账本。要新增技能，用管理页创建、
从目录复制导入，或添加文件夹引用。

清单以文件系统扫描为唯一事实源，用当前会话的 `SkillRegistry.snapshot({cwd, scope})` 补充同名遮蔽结论；先按作用域覆盖，再按层内 rank、提供者和根顺序裁决。
注册表读不到、缺少某个技能或快照不完整都不改变条目在页面上的可用性：注册表只补充，不否决。
`complete=false` 表示观测不完整，不能将缺席解释成不存在。注册表中的额外提供方技能也会展示，未命中可管理本地资产时只读。
`/bootstrap` 与 `/skills-list` 使用同一个会话工作目录与作用域。技能清单、根与引用目录不进入 settings descriptor/base，权威空清单正常清空页面。
TUI 的 `skill <技能名>` 使用 frontmatter.name；同名多个文件时要求到管理页选择具体条目。

## 2. 停用 = 改写技能文件的调用策略

停用不改技能状态、不搬迁文件，只改写该技能 `SKILL.md` frontmatter 的两个官方键：

| 操作 | 文件效果 |
|---|---|
| 模型端停用 | `disable-model-invocation: true` |
| 模型端恢复 | `disable-model-invocation: false` |
| 用户端停用 | `user-invocable: false` |
| 用户端恢复 | `user-invocable: true` |
| 两端停用 | 两个键都写停用值 |

**两端各自独立**：只关模型端时用户斜杠命令仍可用，只关用户端时模型仍可加载。两端都关会禁止这两种调用入口，但受信的注册表内部 `get()` 仍可读取定义。
缺省（键不存在）即两端可调用，与官方一致。

页面单端开关提交 `{name, path, side, enabled, sessionId?}`；服务端读取最新文件，只修改指定端。两个旧页面分别关闭不同端时不会互相重新开启另一端。
明确的两端操作和 TUI 可提交 `scope`。可选 `skill-search` 的搜索与加载也检查官方调用策略，并用 `renderSkillContent` 保留资源基址；关键词支持中文。

写入纪律：

- 只用 yaml Document API 改指定策略键，保留注释、未知字段与其余字段，正文逐字保留；
- 写入时统一为官方连字符键；旧 `disableModelInvocation` / `userInvocable` / `modelInvocable` 策略键被替换或删除，相关注释保留；
- 内容无变化时不落盘；同目录暂存后再次核对本次读取的原文，冲突拒绝，成功原子 rename；失败保留原文件并清理暂存。

**为什么不是注册层屏蔽**：本插件曾用「同名影子候选 + 优先级 0」在注册层压掉官方候选。但官方注册表按
`[全局层, ...scope 链]` 依次合并、**最近层无视优先级直接胜出**，而官方 `dsh-skill-filesystem` 由预设的常驻组合挂在
预设层、本插件的提供方在 profile 全局层——影子候选必然被预设层候选覆盖。真机验证：写入屏蔽记录后模型侧仍能看到
该技能。改写文件则任何装配、任何提供方读到的都是同一个事实。

## 3. 状态文件

`$DSH_HOME/skills/.system/prompt-tool/skills.yml`（点目录，官方一层扫描天然跳过）现在只保存引用目录：

```yaml
version: 4
folders:                      # 用户添加的技能文件夹（绝对路径，只登记不复制）
  - D:\work\my-skill-pack
```

- 调用策略不进这个文件：它逐条写在技能文件里，状态文件不再有第二个真相。
- v3 的 `blocked` 屏蔽表已弃用：读取 v3 文件时忽略该键（不校验其内容），下次写入时删除它并把版本抬到 4。
  其他版本号一律拒绝。
- 写入走 yaml Document API：保留注释与未知字段，内容无变化时不落盘，失败清理暂存文件。
  `version` 只标识状态文件结构，不是技能内容版本；不维护技能历史或从客户端传入内容版本凭据。
- 读取与写入共用校验：结构类型、绝对路径、重复项；损坏或别名一律拒绝，**不覆盖**损坏文件。
- 插件只监听状态文件；引用目录候选的监听与失效属于官方 provider。folders 有效变化时串行释放旧注册/watcher，再挂载新实例；快照等待本次重挂完成。

## 4. 管理页能做什么

| 操作 | 端点 | 说明 |
|---|---|---|
| 清单 | `/skills-list` | 返回 `skills/folders/roots/complete`；请求可带 `sessionId`，调用声明与会话注册状态分开 |
| 停用 / 恢复 | `/skill-policy` | 单端提交 `{ name, path, side, enabled }`；明确两端操作使用 `scope`；可带 `sessionId` |
| 添加 / 移除技能文件夹 | `/skills-folders` | 只登记路径；这些目录里的技能按 `custom` 优先级注册，源目录更新即时生效 |
| 创建技能 | `/skill-create` | 在 `$DSH_HOME/skills/<名称>/SKILL.md` 建标准 frontmatter，官方即刻发现 |
| 复制导入 | `/skills-import`（浏览器文件夹）、`/skills-import-directory`（宿主机目录） | 复制进用户技能根；同名先提醒，用户确认后才覆盖；新旧目录均须含技能标记 |
| 删除 | `/skill-delete` | 提交 `{name, path, sessionId?}`；用户根或当前引用根中的目录包/直属文件移入该来源根的 `.system/prompt-tool/.trash/<名称>-随机/`，保留 `record.json`，可人工恢复 |

`/skill-policy` 的身份校验：服务端用**同一个会话工作目录**重新扫描，提交的 `path` 必须命中同名且同路径的有效条目；
命中不了就按陈旧界面拒绝（409），因此界面加载后被替换过的同名技能不会被误改。写入失败（只读目标、符号链接、
无 frontmatter 等）同样如实回报，不静默。

用户根与显式引用根中的普通技能按服务端 `canSetPolicy/canDelete` 开放操作；删除目录包保留整个目录及资源，删除 flat 文件只移走该文件。
确认框显示所选技能名称和完整路径；同名/同目录名的其他来源不受影响。删除前重新读取引用状态，已移除的引用与伪造路径均拒绝。
项目和 agents 根自动发现的技能不默认获得删除权；用户显式添加为引用后，可以管理其中的普通技能。官方内置、系统、链接或只读目标保持只读。
移除引用仅取消目录登记，不删除源文件。删除后可从返回的回收站路径人工恢复到 `record.json` 记录的位置。

## 5. 与旧模型的关系

技能管理经历过三次模型替换（都由后一次整体取代）：

| 维度 | 受管实体库（v2） | 注册层屏蔽（v3） | 文件层调用策略（现，v4） |
|---|---|---|---|
| 实体位置 | 全部搬进 `skills/.system` | 原地不动 | 原地不动 |
| 停用手段 | 删除根目录链接 | 同名影子候选压官方候选 | 改写该技能 frontmatter 的两个官方键 |
| 是否改技能文件 | 不改（改链接） | 不改 | 只改两个键，正文与其余字段逐字保留 |
| 跨层是否成立 | 成立（文件层） | **不成立**：最近层覆盖全局层 | 成立（任何层读同一批文件） |
| 状态文件 | `skills/.system/skills.yml`（v2） | `skills/.system/prompt-tool/skills.yml`（v3） | 同路径（v4，只留 `folders`） |

如果本机还留有 v2 的受管库布局，用一次性迁移脚本回滚（它会按记录删链接、校验哈希后把实体搬回 `skills` 根，
并删除旧的 v2 状态文件）：

```powershell
node scripts/migrate-skills.mjs --rollback "<备份目录>\migration.json"
```

该脚本只用于回滚历史迁移，不是运行时代码。v3 的 `blocked` 记录无需迁移：它已经不生效，写入时会被删除。

## 6. 失败与边界

- 无效技能（缺 frontmatter、非法技能名、frontmatter 解析失败）：清单里标红并显示原因，不注册给模型；
  这类技能**不能写调用策略**（没有可解析的 frontmatter），管理页上的开关是禁用的。
- 写入边界：目标必须是当前来源清单内的绝对路径，文件名为 `SKILL.md` 或合法 `<name>.md`，且是普通文件；目标与祖先中的符号链接均拒绝；
  frontmatter 必须存在、是 YAML 映射且不含别名。只读目标（例如官方随包目录）写入失败会如实报错。
- 宿主机目录导入必须是**绝对路径**：空、纯空白与相对路径在端点与实现两层拒绝（400），且不读盘、不写盘。
  空串若落到 `path.resolve('')` 会退化成进程工作目录，等于把整个 cwd 当成技能导入。
- 管理资产每次读取重新扫描；候选缓存由官方 provider 失效，根初始缺失、删除、重建均能恢复监听。
- 「模型」和「用户」页签只收当前生效且允许该端调用的技能；被遮蔽的条目保留在「全部」中。
  「两端不可用」按文件声明筛选两端关闭的技能；两个开关表示文件声明，徽章单独表示会话遮蔽。
- 导入先整批校验技能名、frontmatter 与资源路径。浏览器所选容器的外层目录被剥离，单技能与资源保持相对位置。
- 同名导入未确认时返回 HTTP 409、`code: skills-overwrite-required` 和 `conflicts` 目录名单，磁盘不变。
  用户确认后以 `overwrite: string[]` 重发同一载荷；新出现的冲突仍需再次确认，取消不提交。
- 宿主目录导入在读取资源前检查文件数和累计容量，读取后再次核对实际大小。上限为 10,000 文件、64 MiB；浏览器 JSON 载荷仍受 bridge 的 32 MiB 上限约束。
- 技能不做版本管理：覆盖备份只存在于当前事务暂存目录，成功即删除；中途失败恢复旧目录并清理新建项。
  回滚自身失败时保留尚未恢复的临时备份并报告位置，避免丢失唯一原件。普通回收站删除是独立操作。
- 提交成功后暂存清理失败仍返回成功，并携带 `warning` 和残留位置；界面提示清理问题，不将已生效导入报告成未写入。
- 状态文件读取失败时保留上一次有效状态（只告警一次，文件修好后自动恢复），不会因为一个瞬时坏文件
  把引用目录清空；状态文件被删除按用户重置处理，但同样会留下一条告警。
- 首次加载状态损坏时报告错误且不注册引用候选；运行中读取失败保留最后有效配置，不覆盖损坏文件。
- 引用目录不存在或不是普通目录：该来源不产生候选，清单里不出现该分组。
- 官方允许的布尔、1/0、yes/no/on/off 按同一语义解析；非法值和官方不支持的旧策略键显示为无效，导入整批拒绝。
- 嵌套子技能不递归发现；链接、虚拟或其他 provider 的技能可由官方快照补充显示，但未命中普通本地资产时只读。

## 7. 回归入口

| 行为 | 测试 |
|---|---|
| 文件写入（保留注释/正文、两端独立、无变化不落盘、各类拒绝） | `test/host/skill-policy.test.mjs` |
| 写入后官方候选的调用策略随之变化（真实注册表） | `test/host/skill-policy-e2e.test.mjs` |
| 状态文件 schema 与写盘事务 | `test/host/skills-config.test.mjs` |
| 六类来源扫描、同名裁决、清单条目 | `test/host/skills-scan.test.mjs`、`test/host/skills-catalog.test.mjs` |
| 创建 / 回收站删除 | `test/host/skills-actions.test.mjs` |
| 引用技能端点、同名身份、移除引用后拒绝 | `test/host/skills-framework-bridge.test.mjs` |
| 端点（真实 handler + 写盘 + 身份校验） | `test/host/settings-bridge.test.mjs` |
| 状态 / 引用目录变化后的清单刷新 | `test/host/skills-refresh.test.mjs` |
| 官方引用 provider 缺失根恢复与释放 | `test/host/skills-candidates-refresh.test.mjs` |
| 页面分组、调用策略开关与资产入口 | `test/client/ui-v2-page-smoke.test.mjs`（fixture：`test/fixtures/ui-v2-drafts.mjs`） |
| 状态筛选与徽章纯逻辑 | `test/client/skill-status.test.mjs` |

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```
