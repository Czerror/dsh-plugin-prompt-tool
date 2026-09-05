# 计划问题修复记录

## 状态

本轮审查中发现的 P1/P2 问题已修复。`PLAN.md` 只记录修复结果与仍然有效的边界，不再把旧审查报告当作当前状态。

## 修复项

| 问题 | 修复 | 回归覆盖 |
|---|---|---|
| 能力创建可能生成重复 Loader row | `str-replace-editor` 能力以 `bootstrap-filesystem` 为唯一装配模块；候选组合递归记录 row 路径，重复 id 在写盘前直接失败 | `test/host/engine-capability.test.mjs` |
| 组合重建脚本缺少目标完整性校验，可能假绿 | 从上游目录动态发现预设；按官方行序校验目标 `modules` 集合、顺序、类型和重复；校验 persona 契约、必要技能资产、补丁命中次数和新增上游预设 | `test/host/rebuild-composition.test.mjs` |
| worldBook 运行时迁移二次重建丢条目 | 合并后的 `promptConfigs` 与 `worldBook` 删除通过 YAML Document 一起原子写回用户预设；失效缓存并避免重复 id；包内模板保持只读 | `test/host/write-preset.test.mjs`（两次重建） |
| 共享 `.engine` 刷新先删后拷贝 | 先在同目录 staging 完整复制并写入指纹，再 rename 交换；复制或交换失败保留旧引擎 | `test/host/write-preset.test.mjs` |
| 离线迁移可能截断 `preset.yml` | `scripts/migrate-presets.mjs` 改为同目录临时文件 + rename，失败清理临时文件并保留原文件；同时迁移旧 `str-replace-editor` 模块名 | `test/host/migrate-presets.test.mjs` |

## Minimal 与组合来源决策

`engine/compositions/library/bootstrap-filesystem.yml` 是官方 `filesystem` group 的完整切块，包含：

- `fs-local`；
- `str-replace-editor`；
- 同一个 `isolate: fs` 服务域。

因此 Minimal 直接装配 `bootstrap-filesystem`，不再维护
`engine/compositions/source/local/str-replace-editor.yml`。把 `fs-local` 和编辑器拆成两个独立模块会破坏同域服务解析，增加重复注册风险。

`library/` 中的 `official-*` 与同名文件是不同官方预设的语义变体（例如平台禁用、PTC delegation、Cordis 技能路径），不是同一预设内的重复 row；脚本和候选校验仍禁止同一组合出现重复 Loader id。

官方行覆盖仍按上游四个基型核对：

| 预设 | 本地目标 | 说明 |
|---|---|---|
| standard | `preset/standard` | 官方行按序拆分，persona 由 `prompt-config-engine` + `persona-main` 承载 |
| minimal | `preset/minimal` | `persistent-shell` + 官方 `bootstrap-filesystem`（含 `fs-local` 和编辑器） |
| ptc | `preset/ptc` | 使用 PTC presentation 与 delegation 变体 |
| cordis | `preset/creative` | 保留 Cordis 工具与随包技能资产 |

## 现行边界

- `source/local/` 只放本项目自有模块；`library/` 只由 `pnpm rebuild:composition` 生成官方切块和确有语义差异的变体。
- 官方 persona 行由 `prompt-config-engine` + `persona-main` 配置卡等价承载，不重复注册官方 `persona` row。
- `modules: []` 保持显式空组合；能力卡只由显式模块事实决定，官方组合 row 不伪装成可编辑能力。
- Minimal 与 Anchored 都使用带隔离文件系统的 `bootstrap-filesystem`；参数桥仍可通过 `strReplaceEditorMaxOutputChars` 配置嵌套编辑器。

## 验证

所有命令从隔离 cwd `D:\AI\workspase\_temp` 执行：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo rebuild:composition
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
git -C $Repo diff --check
```

本轮验证结果：`rebuild:composition`、`typecheck`、`lint`、`test`（556 pass / 0 fail）和 `git diff --check` 均通过。交付前以命令实际输出为准，不在计划中固定易变的测试数量。变更不修改 DeepSeek Harness 源码，不停止运行中的 DSH 服务；若 `cordis.patch.yml`、bundle 或 profile manifest 后续变化需要重启，由用户决定。
