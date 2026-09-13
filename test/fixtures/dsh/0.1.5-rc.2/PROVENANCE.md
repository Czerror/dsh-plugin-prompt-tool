# DeepSeek Harness 固定上游 fixture（0.1.5-rc.2）

本目录是 `scripts/rebuild-composition.mjs` 与相关契约测试的固定输入，只保存重建需要的官方内置预设文件，不复制完整官方仓库。

- 来源仓库：`https://github.com/deepseek-ai/deepseek-harness`
- 来源 tag：`dsh-v0.1.5-rc.2`
- 来源提交：`fb2c4b9e698e30edb738bca4cf0618587db7d203`
- 导出路径：`packages/preset/agent-presets/presets`
- 导出命令：`git -C <harness> archive dsh-v0.1.5-rc.2 packages/preset/agent-presets/presets | tar -x -C test/fixtures/dsh/0.1.5-rc.2`
- 上游许可：MIT License（Copyright (c) 2026 DeepSeek），见上游仓库根目录 `LICENSE`

本目录内文件逐字节取自上述 tag；下列 SHA-256 用于证明 fixture 未被本地 master 或手工编辑污染。更新 fixture 必须同时更新本表与版本契约测试。

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

## 与本地 master 的已知差异（用于避免误诊）

- 官方 minimal 在 rc.2 已移除 `filesystem` 组行，只剩 `persona` 与 `persistent-shell`。
- 官方 standard / ptc / cordis 在 rc.2 新增顶层 `present` 行（`@deepseek-ai/dsh-tool-present`）。
- 本地 `../deepseek-harness` checkout 是 `master`，不代表本 tag；重建验证一律以本 fixture 为准。
