# DeepSeek Harness 当前上游快照

本目录记录最近一次核验的官方 master，用于离线复验，不把发布版本作为永久目标。
默认 `rebuild:composition` 会先核验官方实时 HEAD；本快照保留本次实际提交和文件指纹，保证测试可复现。

- 来源仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 来源分支：`master`
- 来源提交：`ddefc45fbc7f8e46dd73185e68295696d1297887`
- 来源提交时间：`2026-09-17T13:19:19Z`
- 导出路径：`packages/preset/agent-presets/presets`
- 导出依据：上述提交的 `packages/preset/agent-presets/presets` 文件树；每次同步到新提交后更新下表。
- 上游许可：MIT License（Copyright (c) 2026 DeepSeek），见上游仓库根目录 `LICENSE`

本目录文件与上述 master 提交逐字节一致；下列 SHA-256 用于检测快照被意外修改。来源提交可随官方更新，测试不硬编码提交或版本号。

## 文件指纹

| 相对路径 | 字节 | SHA-256 |
|---|---|---|
| `cordis/agent.cordis.yml` | 16231 | `d4882736a02aad417d8e93b73ea3b6b48eb39b5280c1a77e224ce73d38512984` |
| `cordis/preset.yml` | 189 | `c8199388e494731f8d08c738a4220c059a089677d1bbb42d36f760ce9d882b02` |
| `cordis/skills/cordis-plugin-development/SKILL.md` | 8289 | `84daca3e10f6e557e9b8462da035b8b7e5af8ca0b057427fc9a802d4a99c967e` |
| `cordis/skills/editing-cordis-compositions/SKILL.md` | 8962 | `dbf68650fc61260b423844b4f96a35943bb8b6bafcc6ba90324abbbb4b8c46c9` |
| `minimal/agent.cordis.yml` | 3119 | `e75af996ab8c4cc966f8c5b54cd8dc354d7ac71bfcedbe07c8896f63bb7f073b` |
| `minimal/preset.yml` | 91 | `9369a101ebdae504c109d48dbccffeed236966e9cb818ae82277dd4347ad8eb8` |
| `ptc/agent.cordis.yml` | 14512 | `830928ce6e1281bc000afbfc937664d1acf79811d870099fcf0d0951a8203680` |
| `ptc/preset.yml` | 207 | `1bfc9606aa8537b34bec80d9f54392f159c0ffc045c9b1bb620f076038d5e5de` |
| `standard/agent.cordis.yml` | 13422 | `0934f22b2fdbc158fd2edad33ec5dd2671b5b1f727800dcaab74cee3bd7294af` |
| `standard/preset.yml` | 176 | `3c61b4ce68e5dd5cb2c099693fdcb30b91d5f22bbbef546e233321b0fa68f0e4` |

## 本次同步说明

- 本次 master（`dsh-0.1.6-alpha.2` 合并提交）相对上次快照（`0d1f5000`）的变化：`cordis`（创造模式）persona 新增四段
  （plugin_manager 用法、Creator 模式下的 UI 插件目标、`cordis_inspect_*` 只读探查、MCP server 接入与 installed bundles 约定）；
  `standard` / `ptc` / `cordis` 末尾新增 `tool-plugin-manager` 行（前两者 `disabled: true`，cordis 为启用态）；
  `cordis` 的两个技能正文精简（`cordis-plugin-development` 20923→8289 字节、`editing-cordis-compositions` 14393→8962 字节）。
- 同批把本地模板 `preset/creative` 对齐官方改名为 `preset/cordis`（`id: cordis`）：`rebuild:composition` 的目标覆盖表随之清空，
  官方 `cordis` 行改为逐行拆解（`tool-cordis` 仍按全局 provider 重复注册的理由跳过），新增
  `tool-plugin-manager`（cordis 启用态）与 `tool-plugin-manager-disabled`（standard/ptc）两个库模块。
- 发布包按 package.json 明确选择已核实的可用版本；npm 的 latest 标签可能落后于 next，不据标签名称直接降级。
