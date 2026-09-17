# prompt-tool 速查

## 常用命令

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

## 目录

- `engine/`：运行时提示词引擎（含通用 `instruction-hint.mjs`、schema / strategies / fillers / layers / executor）
- `src/`：宿主侧 TypeScript
- `src/client/`：Web 客户端
- `preset/`：随包内置预设（`pt-standard` / `pt-ptc` / `pt-minimal` / `pt-cordis` / `pt-custom`；默认 `pt-standard`）
- `engine/compositions/source/local/`：本地组合模块唯一源；`library/`：官方切块/变体生成物
- `templates/`：提示词配置模板
- 技能由官方根或用户引用目录提供，插件不分发顶层 `skills/`。

## 关键概念

- 六层注入：`pre-step / system-section / runtime-context / agent-request / llm-stream / tool-pipeline`
- 内容策略：`static / placeholder / instruction-hint / first-turn-anchor / guide-auto / custom-fallback`
- `custom-fallback`：自定义锚定词兜底注入，参数 `params.firstTurnWord`（默认 `we`）
- `/api/prompt-tool/settings/meta`：客户端动态枚举来源
