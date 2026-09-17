# 技能管理：注册层屏蔽

本插件的技能管理只做三件事：**看清技能来自哪里**、**在注册层停用/恢复**、**把技能复制进用户技能根**。技能实体始终留在官方各自的技能根里，插件不搬迁、不建链接、不改任何 `SKILL.md`。

本文是该行为的权威说明。改动 `src/shared/skills.ts`、`src/host/skills-*.ts`、`src/runtime/settings-bridge.ts` 的技能端点、`src/index.ts` 的技能提供者或 `src/client/features/skills/*` 前先读本文。

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

项目根 = 从会话工作目录向上找到的第一个含 `.git` 的目录。发现规则与官方一致：**只认 `<根>/<目录名>/SKILL.md`，不递归嵌套**。

插件自己**只提供两类候选**：屏蔽名单的影子候选，以及 `custom` 引用目录里的技能；其余来源全部交给官方发现。

插件**不内置任何技能**：包内没有 `skills/` 目录，也没有安装副本或内容哈希账本。要新增技能，用管理页创建、从目录复制导入，或添加文件夹引用。

## 2. 停用 = 注册层屏蔽

停用不写任何技能文件：插件提供者为该技能名返回一个**影子候选**——同名、优先级 `0`（小于全部官方根）、调用策略按屏蔽范围取值。官方注册表在同一层内按优先级升序合并同名候选、只保留第一个，于是：

- **屏蔽模型端**时：模型的技能目录（`<available_skills>`）不再列出它，`skill` 工具加载被拒绝（`not available for model invocation`）；
- **屏蔽用户端**时：用户 `/名称` 命令不可用。

**两端各自独立**：只屏蔽模型端时用户斜杠命令仍可用，只屏蔽用户端时模型仍可加载，两端都屏蔽才是完全停用。删除屏蔽记录后官方候选立刻回到生效位置。**已知限制**：屏蔽按技能名在全局生效，同名技能在任何工作区都会被一起压掉；停用后官方仍能发现该技能，只是被屏蔽的那一端用不了（这一点与旧的"官方也发现不到"不同）。

## 3. 状态文件

`$DSH_HOME/skills/.system/prompt-tool/skills.yml`（点目录，官方一层扫描天然跳过）：

```yaml
version: 3
blocked:
  - name: some-skill          # 两端都屏蔽（完全停用）
    at: '2026-09-17T15:04:16.000Z'
    note: 可选备注
  - name: model-off-skill     # 只屏蔽模型端：用户斜杠命令仍可用
    at: '2026-09-17T15:10:00.000Z'
    user: false
  - name: user-off-skill      # 只屏蔽用户端：模型仍可加载
    at: '2026-09-17T15:12:00.000Z'
    model: false
folders:                      # 用户添加的技能文件夹（绝对路径，只登记不复制）
  - D:\work\my-skill-pack
```

- 记录存在即表示至少屏蔽了一端：省略 `model` / `user` 视为屏蔽该端；两端都不屏蔽的记录会被拒绝（这种记录应当直接删除）。

- 写入走 yaml Document API：保留注释与未知字段，内容无变化时不落盘；写前核对版本，失败清理暂存文件。
- 读取与写入共用校验：结构类型、技能名规则、绝对路径、重复项；损坏或别名一律拒绝，**不覆盖**损坏文件。
- 技能文件本身的即时性由官方 watcher 负责；插件只监听状态文件与引用目录（300ms 防抖）来刷新自己的清单。

## 4. 管理页能做什么

| 操作 | 端点 | 说明 |
|---|---|---|
| 清单 | `/skills-list` | 按会话工作目录扫描六类来源，标注来源、优先级、是否被屏蔽、是否被同名技能遮蔽、调用状态 |
| 停用 / 恢复 | `/skill-block` | 只写状态文件，幂等；`scope` 取 `model` / `user` / `all` / `none`，两端独立，`none` 即删除记录 |
| 添加 / 移除技能文件夹 | `/skills-folders` | 只登记路径；这些目录里的技能按 `custom` 优先级注册，源目录更新即时生效 |
| 创建技能 | `/skill-create` | 在 `$DSH_HOME/skills/<名称>/SKILL.md` 建标准 frontmatter，官方即刻发现 |
| 复制导入 | `/skills-import`（浏览器文件夹）、`/skills-import-directory`（宿主机目录） | 复制进用户技能根；覆盖前要求目标是技能目录（含 `SKILL.md`） |
| 删除 | `/skill-delete` | 只处理用户技能根里的技能：整个目录移入 `<根>/.system/prompt-tool/.trash/<名称>-随机/`（含 `record.json`），可人工恢复 |

只有用户技能根里的技能提供删除按钮；项目、引用目录与官方内置的技能是只读的（要改就去改那些文件）。

## 5. 与旧的受管实体库模型的关系

上一轮实现过「实体集中到 `skills/.system` + 根链接启停 + `skills.yml` 状态」的受管库模型（提交 `b7f380f`、`88a6b61`、`5dd0a2a`），本轮**整体取代**：

| 维度 | 受管实体库（旧） | 注册层屏蔽（现） |
|---|---|---|
| 实体位置 | 全部搬进 `skills/.system` | 原地不动 |
| 停用手段 | 删除根目录链接 | 影子候选压制 |
| 官方是否仍发现 | 停用后看不到 | 仍发现，但被同名影子压掉 |
| 顺序 / 优先级 | 插件用 `order` + `rankBase` 控制 | 由官方按技能名与来源优先级决定（插件不再控制） |
| 一键修复 | 改目录名 / 补 frontmatter | 已移除（坏技能只展示原因） |
| 状态文件 | `skills/.system/skills.yml`（v2） | `skills/.system/prompt-tool/skills.yml`（v3） |

如果本机还留有旧的受管库布局，用上轮的一次性迁移脚本回滚（它会按记录删链接、校验哈希后把实体搬回 `skills` 根，并删除旧的 v2 状态文件）：

```powershell
node scripts/migrate-skills.mjs --rollback "<备份目录>\migration.json"
```

该脚本只用于回滚历史迁移，不是本轮的运行时代码。

## 6. 失败与边界

- 无效技能（缺 frontmatter、非法技能名、frontmatter 解析失败）：清单里标红并显示原因，不注册给模型；插件不改文件。
- 宿主机目录导入必须是**绝对路径**：空、纯空白与相对路径在端点与实现两层拒绝（400），且不读盘、不写盘。
  空串若落到 `path.resolve('')` 会退化成进程工作目录，等于把整个 cwd 当成技能导入。
- 清单缓存随文件系统事件失效：在引用文件夹里增删技能后再次读取清单即反映变化，不需要重启或手工重扫；
  状态文件未变时只失效缓存、不重挂 watcher。
- 「两端不可用」页签收**两端都不可用**的技能：既包含插件两端屏蔽，也包含技能自身声明两端都不可调用；
  只关一端时技能留在「模型」或「用户」页签，因此每个有效技能至少落在一个页签里。状态徽章按端显示
  「模型端已停用 / 用户端已停用 / 已停用」，并如实区分插件屏蔽与技能自身声明。
- 覆盖导入同名技能时，旧版本移入 `<根>/.system/prompt-tool/.trash/`（与回收站删除同一目录，记录
  `origin: import-overwrite`），结果返回覆盖数量、成功提示如实说明——批量导入没有逐项确认，
  被替换的旧版本必须仍可人工恢复。
- 清单与候选缓存按**六类技能根的指纹**（目录集合 + 标记文件时间）判失效：在用户根、项目根、agents 根、
  内置根或引用文件夹里手工增删技能后，下一次读取即反映变化。项目根随工作区变化，静态 watcher 覆盖不到，
  由指纹兜住；watcher 只负责让变化更快被看到。
- 状态文件读取失败时保留上一次有效状态（只告警一次，文件修好后自动恢复），不会因为一个瞬时坏文件
  把屏蔽表与引用目录清空；状态文件被删除按用户重置处理，但同样会留下一条告警。
- 候选缓存按「状态快照 + 引用来源指纹」判失效：引用文件夹里新增、删除或改写技能不会改变状态快照，
  但同样会让模型侧候选过期，所以两者任一变化都要让官方提供者重扫；只有两者都没变的事件（例如编辑器
  保存了引用目录里的非技能文件）才只清清单缓存。
- 状态文件损坏或含别名：读取失败并报告，屏蔽功能停用但清单照常显示（不静默重置用户状态）。
- 引用目录不存在或不是普通目录：该来源不产生候选，清单里不出现该分组。
- 影子候选永不加载内容：即使有人绕过调用策略直接 `get`，也拿不到正文。
- 不支持：嵌套子技能（与官方一致，只扫一层）、扁平 `<name>.md`、按工作区区分同名屏蔽。

## 7. 回归入口

| 行为 | 测试 |
|---|---|
| 状态文件 schema 与写盘事务 | `test/host/skills-config.test.mjs` |
| 六类来源扫描、同名裁决、清单条目 | `test/host/skills-scan.test.mjs`、`test/host/skills-import.test.mjs` |
| 创建 / 回收站删除 | `test/host/skills-actions.test.mjs` |
| 端点（真实 handler + 写盘） | `test/host/settings-bridge.test.mjs` |
| 注册层压制（影子候选） | `test/host/skill-block-shadow.test.mjs` |
| 状态 / 引用目录变化后的清单刷新 | `test/host/skills-refresh.test.mjs` |
| 页面分组、屏蔽开关与资产入口 | `test/client/ui-v2-page-smoke.test.mjs`（fixture：`test/fixtures/ui-v2-drafts.mjs`） |
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
