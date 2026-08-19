# prompt-tool 速查

## 常用命令

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm build`

## 目录

- `engine/`：运行时提示词引擎（schema / strategies / fillers / layers / executor）
- `src/`：宿主侧 TypeScript
- `src/client/`：Web 客户端
- `preset/anchored/preset.yml`：anchored 单一参数预设
- `templates/`：提示词配置模板
- `skills/`：随包技能

## 关键概念

- 六层注入：`pre-step / system-section / runtime-context / agent-request / llm-stream / tool-pipeline`
- 内容策略：`static / placeholder / instruction-hint / anchor-auto / guide-auto / custom-fallback`
- `custom-fallback`：自定义锚定词兜底注入，参数 `customAnchorWord`，兼容 `anchorWord`
- `/api/prompt-tool/settings/meta`：客户端动态枚举来源
