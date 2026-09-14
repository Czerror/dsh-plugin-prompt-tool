# DeepSeek Harness 当前上游快照

本目录记录最近一次核验的官方 master，用于离线复验，不把发布版本作为永久目标。
默认 `rebuild:composition` 会先核验官方实时 HEAD；本快照保留本次实际提交和文件指纹，保证测试可复现。

- 来源仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 来源分支：`master`
- 来源提交：`c291e7961a515f6d7af9304e7fd1d257929aef26`
- 来源提交时间：`2026-09-10T14:17:09Z`
- 导出路径：`packages/preset/agent-presets/presets`
- 导出依据：上述提交的 `packages/preset/agent-presets/presets` 文件树；每次同步到新提交后更新下表。
- 上游许可：MIT License（Copyright (c) 2026 DeepSeek），见上游仓库根目录 `LICENSE`

本目录文件与上述 master 提交逐字节一致；下列 SHA-256 用于检测快照被意外修改。来源提交可随官方更新，测试不硬编码提交或版本号。

## 文件指纹

| 相对路径 | 字节 | SHA-256 |
|---|---|---|
| `cordis/agent.cordis.yml` | 14010 | `2b8d89c3137ce685f3d97f65aea5bd1c5099e08bba6c16815768245f8fb61d2d` |
| `cordis/preset.yml` | 180 | `7c5f009d82dda01b0e3b4e24c143eaa988f275a8322719800a574bd05c72c0da` |
| `cordis/skills/cordis-plugin-development/SKILL.md` | 20923 | `01811d3ee9c03a466abae12d54d229e7de7bd74ca6b730c54ce9d5e696b294aa` |
| `cordis/skills/editing-cordis-compositions/SKILL.md` | 14413 | `861b3b8b798344ce22890da844b464f492a57c11941eb119d96f2e2dce88dce4` |
| `minimal/agent.cordis.yml` | 3119 | `e75af996ab8c4cc966f8c5b54cd8dc354d7ac71bfcedbe07c8896f63bb7f073b` |
| `minimal/preset.yml` | 91 | `9369a101ebdae504c109d48dbccffeed236966e9cb818ae82277dd4347ad8eb8` |
| `ptc/agent.cordis.yml` | 14003 | `2a62e2dd692e65b86c792519a6d6f617404be59d9878acf0727c6b92dd077134` |
| `ptc/preset.yml` | 207 | `1bfc9606aa8537b34bec80d9f54392f159c0ffc045c9b1bb620f076038d5e5de` |
| `standard/agent.cordis.yml` | 12928 | `08a029c64fdeaabe415a5627ef73ce6f6c6bc61dadaf9989d11f9e15608907f6` |
| `standard/preset.yml` | 176 | `3c61b4ce68e5dd5cb2c099693fdcb30b91d5f22bbbef546e233321b0fa68f0e4` |

## 本次同步说明

- 本次 master 的预设文件与最近发布 `dsh-v0.1.5-rc.2` 相同；模块正文未发生升级，并非仍将 rc.2 设为永久目标。
- 发布包按 package.json 明确选择已核实的可用版本；npm 的 latest 标签可能落后于 next，不据标签名称直接降级。
