# 技能实体库管理

本插件把技能管理从「配置文件 + 磁盘标记」改为**单一受管实体库**：技能实体集中在 `$DSH_HOME/skills/.system/`，启用项通过该根下的目录链接暴露给官方 `dsh-skill-filesystem` provider 与模型；`skills.yml` 是启停、顺序、rank 基数与调用权限的唯一管理来源。本文是该行为的权威说明，改动 `src/host/skills-*.ts`、`src/host/skill-toggle.ts`、`src/runtime/skills-*`、`src/client/features/skills/*`、`src/shared/skills.ts` 或 `scripts/migrate-skills.mjs` 前先读本文。

## 1. 磁盘布局与所有权

```text
$DSH_HOME/skills/
├─ .system/                        # 官方扫描跳过点目录；只有本插件写入
│  ├─ skills.yml                   # 受管状态（无技能正文）
│  ├─ .skills.lock                 # 跨进程事务锁（存在即表示有活动事务）
│  ├─ .trash/skill-<id>/           # 回收站：SKILL.md + record.json
│  ├─ <skill>/SKILL.md             # 技能实体与全部资源
│  ├─ <pkg>/<sub>/SKILL.md         # 嵌套技能即包内子目录
│  └─ prompt-tool/config.yml       # 旧版配置，迁移后仅作人工核对，不再读取
├─ <skill> → .system/<skill>       # 启用链接（Windows junction）
├─ <pkg>--<sub> → .system/<pkg>/<sub>
└─ artifacts/ …                    # 非技能目录：不迁移、不改动
```

- 实体、链接与 `skills.yml` 都由本插件拥有；**外部目录不再作为第二发现根**，只能作为一次性导入来源。
- `.system` 只供管理层枚举实体，**不得**配置成 provider 的自定义发现根，否则停用技能会绕过链接重新暴露。
- 包内 `skills/` 不再是自动同步源：它只是用户可显式导入的资源。

## 2. skills.yml 契约

```yaml
version: 2
order: [dev-expert, web ui]   # 展示顺序与 rank 序号；默认 250 起
rankBase: 250                 # 可省略（默认值写盘时删除）
skills:
  dev-expert:                 # 键 = 稳定身份 id = 相对 .system 的实体路径
    path: dev-expert          # 实体路径（禁止绝对路径、上跳、点目录）
    link: dev-expert          # skills 根中的单段链接名（唯一）
    enabled: true             # 完全启用/停用（只影响链接）
    modelInvocable: true      # 模型可调用
    userInvocable: true       # 用户可调用
    source: import            # 仅用于管理展示，不作为写入授权
```

- 写入使用 yaml Document API，逐节点更新，保留注释与未知字段；内容无变化时不落盘。
- `validateSkillsConfig` 同时服务读写：类型、身份、路径、布尔值、重复路径都在写盘前校验；`__proto__` / `constructor` / `prototype` 与保留设备名被拒绝。
- 读取失败（语法、别名、非映射根、类型错误）返回统一失败载荷，**不用默认值覆盖**损坏文件。
- 一次事务 = 整批前置校验 → 实体 frontmatter → 链接增删 → YAML，任一步失败按回滚栈复原并报告未完成项；事务期间由 `.system/.skills.lock` 跨进程互斥，无法证明已释放的锁不会自动抢占（提示人工确认后删除）。

## 3. 启停与调用策略

| 操作 | 落点 | 语义 |
|---|---|---|
| 完全停用 | 取消 `skills/<link>` | 官方 provider 与本插件都不再发现；实体、资源、正文、调用策略全部保留 |
| 重新启用 | 重建 `skills/<link>` | 与停用前逐项一致 |
| 模型可调用 | YAML + 实体 `disable-model-invocation` | 关闭后模型不可发现/加载，用户仍可调用 |
| 用户可调用 | YAML + 实体 `user-invocable` | 关闭后用户命令不可加载 |

- YAML 是唯一管理来源：写策略时**两个字段都同步**为 YAML 值，避免两边成为独立来源；正文、未知字段、注释与换行保持原样。
- 外部工具（例如 dsh-web）改动这两个字段后，下一次事务按 YAML 恢复并各提示一次偏差（进程内按 `根:技能` 去重）。
- 完全停用的行在 UI 上调用策略只读，需先启用再改。
- 注册给模型时按 frontmatter `name` 去重（首个受管记录胜出）、`rank = rankBase + 顺序序号`、`resourceBase` 取启用链接路径（官方 candidate 解析到实体，两者不能要求父目录相同）。

## 4. 导入、创建与回收站

| 入口 | 端点 | 行为 |
|---|---|---|
| 浏览器文件夹导入 | `/skills-import` | base64 上传，单技能包按 `frontmatter.name` 归类，容器目录按顶层名归类 |
| 宿主机目录导入 | `/skills-import-directory` | 读取源目录（拒绝符号链接/硬链接/超限）后按目录名复制进实体库 |
| 创建技能 | `/skill-create` | 生成标准 frontmatter 的实体并默认启用；名称 kebab-case、描述必填、正文 ≤ 1 MiB |
| 回收站删除 | `/skill-delete` | 只把 `SKILL.md` 移入 `.system/.trash/skill-<随机>/`（含 `record.json`），实体目录与资源保留 |

- 导入拒绝 `.system` / `.skills-migration` 首段、上跳、绝对路径、超限文件与重复路径。
- 覆盖规则：目标已存在且**未被受管记录拥有**时拒绝；已受管实体可被显式导入覆盖。
- 导入的 frontmatter 调用策略（`disable-model-invocation` / `user-invocable`）进入 YAML。
- 回收站是文件系统事实，没有恢复端点；`record.json` 保留原记录与原文供人工恢复。

## 5. 迁移与回滚

`scripts/migrate-skills.mjs` 把旧布局（顶层普通技能目录 + `.system/prompt-tool/config.yml`）迁移到受管实体库：

```powershell
node scripts/migrate-skills.mjs --root "$env:DSH_HOME\skills"          # 只读预览：列出实体、嵌套技能、顺序与 rank
node scripts/migrate-skills.mjs --root "$env:DSH_HOME\skills" --apply  # 执行：复制备份 → 移动实体 → 写 YAML → 建链接
node scripts/migrate-skills.mjs --rollback "<备份目录>\migration.json" # 回滚：按记录删链接并校验哈希后还原
```

- 只迁移「非链接、非点目录、自带 `SKILL.md`」的顶层目录；嵌套技能各建一条记录与一个根链接（`<pkg>--<sub>`）。
- 备份先完整复制到 `.skills-migration/<时间戳>/`，**不删除唯一备份**；迁移失败时回滚已移动的实体与已建链接。
- `skills.yml` 已存在时拒绝覆盖（幂等失败，不产生半状态）。
- 回滚前对每个实体校验 `SKILL.md` 哈希；内容变化即拒绝，不覆盖外部改动。
- 旧账本 `.prompt-tool-manifest.json` 与 `artifacts` 等非技能内容一律不动。

## 6. 失败与边界

- 无效实体（缺 frontmatter、非法 name、frontmatter 解析失败）：保留管理面条目（`valid=false` + `issue`），启动时**隔离其受管链接**并各提示一次，其余技能照常注册。
- 单个技能的 YAML/frontmatter 错误不阻断健康项的批量操作；`/skill-fix` 可修复目录名/BOM/缺 name，修复结果以重新解析为准。
- watcher 递归监听 skills 根与 `.system`（300ms 防抖）：实体、YAML 与链接变化都会先失效缓存再重建目录。
- 非 loopback 请求、非法载荷、路径越权、目录链接冲突都在写盘前拒绝；删除只作用于已确认归属的链接，不递归删除实体。
- 不支持：`SKILL.md.disabled`（旧标记一律不识别、不转换）、扁平 `<name>.md` 技能、群聊专属注入、正文在线编辑。

## 7. 回归入口

| 行为 | 测试 |
|---|---|
| 状态契约与事务（隐藏实体、幂等、策略同步、冲突与回滚） | `test/host/skills-library.test.mjs`、`test/host/skills-config.test.mjs`、`test/host/skill-toggle.test.mjs` |
| 导入 / 创建 / 回收站 | `test/host/skills-actions.test.mjs`、`test/host/skills-import.test.mjs` |
| 迁移与回滚 | `test/host/skills-migration.test.mjs` |
| provider 扫描、去重与缓存签名 | `test/host/skills-provider.test.mjs` |
| bridge 端点（真实 handler 与写盘） | `test/host/settings-bridge.test.mjs` |
| 技能树 / 筛选纯逻辑 | `test/client/skill-status.test.mjs` |
| 页面行为（真实浏览器 + store） | `test/client/ui-v2-page-smoke.test.mjs`（fixture：`test/fixtures/ui-v2-drafts.mjs`） |

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```
