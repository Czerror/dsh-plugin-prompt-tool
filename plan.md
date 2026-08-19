# dsh-plugin-prompt-tool 开发目标

## 定位

官方说「一切皆是插件」——本项目是「**一切皆可注入**」：一个层级提示词注入器。
把 DSH 官方开放 API 的全部注入层级收敛为可配置提示词配置，由用户自定义注入内容与层级位置。

anchored 首轮锚定、PTC（Code Mode）、任务引导、模型能力增强都不是项目本体，只是
注入工具上的**可替换预设配置**。相关机制原理与性能数据见
[dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 与
[dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)。

## 开发目标

1. **单引擎、全层级**：`preset/engine/prompt-config-engine.mjs` 唯一接线官方六个注入
   层级——`pre-step` / `system-section` / `runtime-context` / `agent-request` /
   `llm-stream` / `tool-pipeline`。
2. **一切皆可自定义**：提示词配置内容（text / 外部模板 / 动态策略）与提示词配置字段（layer /
   position / 时机 / 作用域 / 幂等）全部由用户配置。
3. **配置即状态、UI 最后做**：提示词配置数组进 DSH settings 并输出到
   `/api/prompt-tool/settings/describe`；Web/TUI 提示词配置编辑器最后接入，功能层先行。
4. **内容与执行分离**：引擎只负责注入；内容来源 = 默认四条提示词配置 <
   `promptConfigsDir`（yml/json 目录）< `promptConfigs`（settings 数组）。
5. **本体与预设分离**：`preset/engine/` 是项目本体；`preset/anchored/` 是 anchored
   默认预设配置，可整体替换。

## 当前架构

```
preset/
├── engine/        prompt-config-engine / shared / compaction-epoch      ← 注入工具本体
├── anchored/      context-gate / tool-bootstrap / router-first-turn
│                  custom-bash / skill-search / run-code-env          ← 默认预设配置
├── agent.cordis.yml   装配模板（engine 行 configsDir: ../prompt-configs）
└── preset.yml

src/
├── index.ts               apply 编排（装配入口）
├── config.ts              Config / PromptSettings / settings schema
├── prompt-configs.ts        提示词配置 schema、默认提示词配置、渲染、三源合并、目录加载
├── preset-core.ts         buildCordis / patchToolBootstrap / parseFrontmatter
├── preset-write.ts        生成目录写入（engine/ + anchored/ + prompt-configs/）
└── runtime/               deepseek / settings-bridge / tui / agents-file / skills-provider
```

## 提示词配置 schema

```yaml
id / name / enabled / layer / strategy / position / dedupe / promotion /
subagents / modelScope / configKind / order / role / sourceKind / identity /
text / templateFile / fill / variables / params
```

`subagents` 三态：`none`=仅主会话，`inherit`=主会话与子代理都适用，`only`=仅子代理。
`mergeMode`：`separate`=同位置先后插入独立消息；`merged`=同位置拼接为一条消息（pre-step / system-section / runtime-context 通用）。
`priority`：同位置插入顺序与拼接顺序，数值小者更靠近插入锚点；单配置多段用 `texts`。

六层参数：`system-section`（order、params.complete、params.sectionName）、
`runtime-context`（order、params.contextName）、`agent-request`（params.patch /
params.replace）、`llm-stream`（params.mode=pass|replace）、`tool-pipeline`
（params.toolNames、preDecision、postAction）、`pre-step`（position/dedupe/promotion）。

## 路线图

已完成：
- [x] 统一注入引擎与全层级接线（官方 0.1.0-rc.7 API 面）
- [x] 旧四个注入模块移除，退化为 prompt-configs/*.yml 提示词配置
- [x] 提示词配置三源合并与 settings 接口输出
- [x] preset / src 分层与模块化
- [x] 默认 anchored 预设与提示词配置行为等价（测试逐条对照）

- [x] 文档同步：修正 README / plan 旧模块名（createSlots → createPromptConfigs、
  mergeInjectionSlots → mergePromptConfigs、configs.ts → prompt-configs.ts），
  并写入层能力矩阵与文本插值规则

- [x] `placeholder` 数据源：skill-catalog 真实填充（skill-catalog / env-facts / instruction-hint 全部就绪）

- [x] 提示词配置保存前权威校验：/configs-validate 端点 + PromptSettingsSchema 最小结构强化

- [x] 默认模板库：templates/ 十个独立模板 + /templates 只读端点（六层 + 两个 placeholder）

- [x] Web/TUI 提示词配置编辑器：主设置菜单一级 section（settings.section，不占插件分类），
  列表 / 表单 / 模板插入 / 保存前校验；TUI 增加 /prompt-tool config 子命令

- [x] Web UI 重建（参考 dsh-mnemon）：主设置只保留提示词配置页（含 /import-directory
  目录导入）；侧边栏新增独立工作台，顶部标签页为六个注入层级 + Skills 设置，
  层页内开关按钮 + 上移/下移/复制/删除 + 展开编辑框；pre-step 层承载
  preset.md / AGENTS.md 编辑与全部入口开关

待办：

## 约束

1. 功能先行、UI/开关最后：任何 UI 只消费既有 settings 数据，不引入新后端状态。
2. 行为等价：重构必须有测试对照；验收用确定性单测，不用模型评分。
3. 只用官方 API：不 fork DSH 内部实现；服务缺失降级、配置错误 fail loud。
4. 注入引擎永不破坏会话：单条提示词配置失败跳过并告警；幂等以持久 session events 为准。
