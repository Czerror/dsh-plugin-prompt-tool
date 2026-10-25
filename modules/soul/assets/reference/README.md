# 13 份 soul 正文 + 2 份 ECHO 权威文档（外部来源）

Source: `D:\AI\GitHub\dsh-agent-soul\soul\` 与 `docs\`（MIT；soul 正文 2026-10-24 导入，2026-10-25 同步 ECHO 权威口径，源提交 `b3606be`）
用途：模块文件工具按需读取的完整知识，例如 `module_file_read` 的 `path: assets/reference/05-doctor.md`。

适配边界：

- 本项目不安装 dsh-agent-soul 插件，也不分发它的 kit/CLI。正文里出现的 `ECHO_SOUL`、`kit/echo/*.mjs`、`plugins/*` 等路径与命令只描述原项目的运行时；在本模块里，用户数据根是模块目录的 `data/`，读写走 `module_file_read/append`，装配走 `module_manifest`。
- `04-manifest.json` 与 `07-bundle.json` 是外部安装清单，本项目不使用，只作参考。
- 正文保持原文，未逐份改写；与模块规则冲突时，以 `module.yml` 与 `assets/manifest.yml` 为准。
- 2026-10-25 同步：更新 `00-layers`、`02-echo`、`05-doctor`、`10-echo-anatomy`，新增 `ECHO-权威口径.md`（L0–L5 唯一权威）与 `ECHO六层与mnemon协同说明书.md`；源仓库当天删除的错误版《记忆三层联用说明书》不收录。
- 模块内路径对照：源正文的 `../docs/ECHO-权威口径.md` 对应 `assets/reference/ECHO-权威口径.md`；源账本名 `02-墨.jsonl` 在模块内为 `data/02-soul.jsonl`，以 `module.yml` 与 `assets/manifest.yml` 为准。
