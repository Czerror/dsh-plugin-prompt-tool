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
- `engine/compositions/source/local/`：本地组合模块唯一源（官方切块已退役，不再有 `library/`）
- `modules/`：随包内置模块（工具面收窄、技能面、ponytail、superpowers、PTC 呈现）
- `templates/`：提示词配置模板
- `skills/dsh-module/`：随包分发的模块编辑技能；技能库本体由官方根或用户引用目录提供
- 预设不随包分发（无 `preset/`）：官方工具与预设由宿主 bundle 提供，插件不重新声明它们。PTC 模式是**宿主侧选择**——`tools` 行的 `config.mode`（部署级）或预设挂 `dsh-agent-tool-presentation`（per-preset）。

## 关键概念

- 六层注入：`pre-step / system-section / runtime-context / agent-request / llm-stream / tool-pipeline`
- 内容策略：`static / placeholder / instruction-hint / first-turn-anchor / guide-auto / custom-fallback`
- `custom-fallback`：自定义锚定词兜底注入，参数 `params.firstTurnWord`（默认 `we`）
- `/api/prompt-tool/settings/meta`：客户端动态枚举来源
