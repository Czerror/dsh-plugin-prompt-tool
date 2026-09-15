# DeepSeek Harness 当前上游快照

本目录记录最近一次核验的官方 master，用于离线复验，不把发布版本作为永久目标。
默认 `rebuild:composition` 会先核验官方实时 HEAD；本快照保留本次实际提交和文件指纹，保证测试可复现。

- 来源仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 来源分支：`master`
- 来源提交：`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`
- 来源提交时间：`2026-09-15T03:16:06Z`
- 导出路径：`packages/preset/agent-presets/presets`
- 导出依据：上述提交的 `packages/preset/agent-presets/presets` 文件树；每次同步到新提交后更新下表。
- 上游许可：MIT License（Copyright (c) 2026 DeepSeek），见上游仓库根目录 `LICENSE`

本目录文件与上述 master 提交逐字节一致；下列 SHA-256 用于检测快照被意外修改。来源提交可随官方更新，测试不硬编码提交或版本号。

## 文件指纹

| 相对路径 | 字节 | SHA-256 |
|---|---|---|
| `cordis/agent.cordis.yml` | 14412 | `1510f8901680767a2757069456b72fc505f2c8f23194eb6e242391146e7d4550` |
| `cordis/preset.yml` | 180 | `7c5f009d82dda01b0e3b4e24c143eaa988f275a8322719800a574bd05c72c0da` |
| `cordis/skills/cordis-plugin-development/SKILL.md` | 20923 | `01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa` |
| `cordis/skills/editing-cordis-compositions/SKILL.md` | 14393 | `6f5a82eebfe62c5649cab0cf901756a6380d1cbf090838c1cd514b200046fd25` |
| `minimal/agent.cordis.yml` | 3119 | `e75af996ab8c4cc966f8c5b54cd8dc354d7ac71bfcedbe07c8896f63bb7f073b` |
| `minimal/preset.yml` | 91 | `9369a101ebdae504c109d48dbccffeed236966e9cb818ae82277dd4347ad8eb8` |
| `ptc/agent.cordis.yml` | 14420 | `e7613a9c29feee587c2d479c82b4039da51d8de6b31680dcc24b7fc3d4cc9d20` |
| `ptc/preset.yml` | 207 | `1bfc9606aa8537b34bec80d9f54392f159c0ffc045c9b1bb620f076038d5e5de` |
| `standard/agent.cordis.yml` | 13330 | `942480b0e441277063f358a511f2727dc2ef8ee6a5e5e127cee1faea3dab0149` |
| `standard/preset.yml` | 176 | `3c61b4ce68e5dd5cb2c099693fdcb30b91d5f22bbbef546e233321b0fa68f0e4` |

## 本次同步说明

- 本次 master（`dsh-v0.1.6-alpha.1` 之后）相对 rc.2 有三处语义变化：嵌套行 `workflow-worker-thread`（`@deepseek-ai/dsh-workflow-worker-thread`，该包已被上游删除）改为 `workflow-ptc`（`@deepseek-ai/dsh-workflow-ptc`，PTC 模式下一次行 `disabled: true`）；`tool-ralph` 在 standard、ptc、cordis 一律 `disabled: true`；ptc 的注释 `codeRuntime` 改为 `ptcRuntime`。因此组合快照与宿主版本必须同批升级，旧宿主解析不到 `dsh-workflow-ptc`。
- 发布包按 package.json 明确选择已核实的可用版本；npm 的 latest 标签可能落后于 next，不据标签名称直接降级。
