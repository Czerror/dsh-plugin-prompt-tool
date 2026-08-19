# prompt-tool v4 架构设计：skill-catalog 数据源与提示词配置编辑面

> 状态：架构设计文档（仅设计，不改代码）
> 输入：`plan.md`、`prompt-tool-v3` 交接文档、`src/`、`preset/engine/`、`test/` 全量勘察
> 日期：2026-08-18

## 0. 结论先行

勘察结论：v3 交接文档所述架构**已基本落地**，六层接线、三源合并、placeholder 框架、
Web 面板与 settings bridge 均已在代码中实现。真正未完成的是三件事：

1. **`skill-catalog` filler 仍是空壳**（`preset/engine/prompt-config-engine.mjs` 中
   `FILLERS['skill-catalog'] = () => () => null`），但 schema、枚举、测试入口已预留；
2. **提示词配置编辑面缺失**：`PromptEditor.tsx` 只编辑 preset.md / AGENTS.md / 开关，
   `Fields` 接口没有 `promptConfigs / promptConfigsDir`；settings bridge 已把数据输出到
   `/api/prompt-tool/settings/describe`，UI 消费层是最后一块；
3. **默认模板库只有单文件**：`promptConfigs.template.yml` 已含 8 类示例，但未拆成
   可被 UI / 用户直接复制的模板包，且其中 `env-facts` 注释仍标"预留"（实际已实现）。

**执行项决策（按勘察后重排）：**

| 优先级 | 工作项 | 理由 |
|---|---|---|
| M1 | skill-catalog filler 数据源（已完成） | 引擎唯一未完成的 schema 预留位，功能层先行，零 UI 依赖 |
| M2 | 宿主端提示词配置校验端点 + settings schema 强化（已完成） | 是 M4 编辑器的前置，先让"校验"可复用 |
| M3 | 默认模板库（templates/ 目录 + bridge 输出）（已完成） | 可并行，产出是纯数据 |
| M4 | Web/TUI 提示词配置编辑器（已完成） | 最后做，只消费 M2/M3 已就绪的接口 |
| M5 | 文档同步 | README / plan.md 残留旧模块名，随 M1–M4 一并修正 |

---

## 1. 现状盘点（勘察事实）

### 1.1 已落地

- **唯一执行器**：`preset/engine/prompt-config-engine.mjs`（1153 行）统一接线六个层级：
  `pre-step` / `system-section` / `runtime-context` / `agent-request` / `llm-stream` /
  `tool-pipeline`。
- **三源合并**：`src/prompt-configs.ts` 实现
  `默认四条 < promptConfigsDir 目录 < settings.promptConfigs 数组` 的合并，
  同名 id 后者覆盖并保留位置，新 id 追加。
- **生成目录**：`src/preset-write.ts` 每次 `writePreset` 重建
  `engine/ + anchored/ + prompt-configs/ + agent.cordis.yml + preset.yml`，
  并清理旧平铺脚本残留。
- **placeholder 框架**：`instruction-hint`、`env-facts` 已实现；`skill-catalog`
  占位返回 null；placeholder 仅允许 `pre-step` / `runtime-context`。
- **Web 面板**：`src/client/PromptEditor.tsx`（800 行）通过自建 loopback bridge
  编辑 preset.md / AGENTS.md / 技能开关 / 锚定开关；keyed `settings.plugin.item`
  插槽已挂入官方设置页。
- **测试**：`test/prompt-config-engine.test.mjs`（587 行）覆盖六层与 placeholder 行为，
  其余 3 个测试文件覆盖渲染、合并、preset 生成与 anchored 脚本；合计 92 项级覆盖面。

### 1.2 已发现的不一致与缺口

| # | 位置 | 问题 | 影响 |
|---|---|---|---|
| G1 | engine `FILLERS` | `skill-catalog` 恒返回 null | 核心待办 |
| G2 | `src/config.ts` | `Config.promptConfigs` 与 `PromptSettingsSchema.promptConfigs` 都是 `z.array(z.any())` | settings 保存时零校验，错误要等到 preset 重建 + 引擎挂载才 fail loud，反馈滞后且难以被 UI 展示 |
| G3 | `PromptEditor.tsx` | `Fields` / `EMPTY` / `snapshotSwitches` / 保存逻辑均无 `promptConfigs`、`promptConfigsDir` | UI 无法编辑核心数据 |
| G4 | `promptConfigs.template.yml:129` | 注释写 `env-facts（预留）`，实际已实现 | 文档漂移，误导用户 |
| G5 | `README.md` | 机制段仍写 `createSlots` / `mergeInjectionSlots` / `src/configs.ts` 旧名 | 文档漂移 |
| G6 | `plan.md` | 架构图写 `src/configs.ts`，实际为 `src/prompt-configs.ts` | 文档漂移 |
| G7 | engine 文本插值 | `pre-step` 有内置变量 `DSH_HOME/WORKSPACE/CWD`；`system-section`/`runtime-context` 只替换 `config.variables`；`llm-stream`/`tool-pipeline` 的 `text` 完全不插值 | 层间行为不统一，用户难预期 |
| G8 | engine 层过滤能力 | `llm-stream` 无 `subagents` 过滤；`system-section`/`runtime-context` 层注册即全局（`modelScope/subagents` 无法按 agent 生效） | 需要在文档中明示"层能力矩阵"，而非用户自行试错 |
| G9 | engine `anchorScanned` Map | 以 session.id 为键且无清理 | 长进程下小量内存增长，可接受但应记录 |
| G10 | templateFile 路径语义 | 相对 `prompt-config-engine.mjs` 文件解析；settings 层用户很难理解该基准 | 需在模板注释与 UI 帮助中明确 |

---

## 2. 设计一（M1）：skill-catalog filler 数据源

### 2.1 目标与约束

- 目标：`strategy: placeholder + fill: skill-catalog` 在注入点动态生成技能目录文本。
- 约束（沿用引擎既有铁律）：
  1. 服务缺失**降级不报错**：拿不到 `ctx.skills` 时返回 null（不注入），`warnOnce`；
  2. 单条失败只跳过该配置，绝不影响会话；
  3. 默认**不注册**为默认四配置之一——避免与 `skill-search` 的"移除全量目录注入"
     设计冲突；只有用户显式配置才启用；
  4. 与 `context-gate` 兼容：推荐 `promotion: main` + `dedupe: session`，首轮门控
     期间不注入，晋升后注入一次。

### 2.2 数据流

```
prompt-configs/xx-skill-catalog.yml
        │  layer: pre-step | runtime-context
        │  strategy: placeholder, fill: skill-catalog
        ▼
prompt-config-engine pre-step 执行器 / systemPrompt.context 函数 provider
        │  resolver({ ctx, agent, session })
        ▼
ctx.get('skills').list({ scope: agent, cwd: session.header.cwd, signal: agent.signal })
        │  （宿主 skills 服务聚合各 provider；本插件 provider 已在 list 中
        │    应用 skillSwitches 过滤，因此天然只列已启用技能）
        ▼
SkillCandidate[] → 按 params 过滤/截断 → 生成
        │  text（默认文本）
        │  variables = { SKILL_COUNT, SKILL_NAMES, SKILLS_TEXT }
        ▼
外层统一 interpolateVariables：config.text 优先（模板自定义），否则 filler 默认文本
```

### 2.3 接口契约（yml 参数，全部可选）

```yaml
id: skill-catalog
name: 技能目录
enabled: true
layer: runtime-context        # 或 pre-step；两者都允许（与 env-facts 一致）
strategy: placeholder
fill: skill-catalog
order: 10
promotion: main               # 建议：晋升后生效（避开 context-gate 首轮门控）
dedupe: session               # 建议：每会话一次（pre-step 层时有效）
subagents: inherit            # 可选：none / inherit / only
params:
  limit: 20                   # 输出技能数上限；默认 20；0 = 全部（不推荐，避免目录扰动）
  fields: name,description    # 输出字段子集；默认 name,description；可加 whenToUse
  providers: ''               # provider 过滤，逗号分隔；空 = 全部 provider
                              # 只列本插件技能时填 prompt-tool
  emptyBehavior: skip         # skip = 无技能时不注入（默认）；text = 注入 emptyText
  emptyText: 当前没有可用技能。
text: |-                      # 可选：完全自定义输出；支持 {{SKILL_COUNT}} {{SKILL_NAMES}}
                              # 与 {{SKILLS_TEXT}}（预格式化列表，见下）
  可用技能 {{SKILL_COUNT}} 个：
  {{SKILLS_TEXT}}
```

**filler 输出变量（标量，避免扩展插值语法）：**

| 变量 | 值 |
|---|---|
| `SKILL_COUNT` | 过滤后的技能数量 |
| `SKILL_NAMES` | 技能名逗号连接（`a, b, c`） |
| `SKILLS_TEXT` | 预格式化列表，每行 `- {name}: {description}`，whenToUse 可选追加 `（适用：{whenToUse}）` |

默认文本与 `SKILLS_TEXT` 相同，首行 `Available skills ({N}):`。

### 2.4 实现落点

- 在 `prompt-config-engine.mjs` 中实现 `createSkillCatalogResolver(config)`，替换
  `FILLERS['skill-catalog']` 空实现；保持 `KNOWN_FILLS` 不变。
- **不**把 `skills` 加进 `export const inject`：filler 在事件时刻用
  `getService(ctx, 'skills')` 延迟获取，拿不到即降级。避免给引擎行增加挂载期依赖，
  也避免"有 skills 服务才能启动 preset"的硬耦合。
- `runtime-context` 分支复用现有函数 provider 路径；resolver 对 `agent === undefined`
  的 assembly（如某些非 agent 上下文）返回 null。
- 输出文本长度保护：`limit` 与 `fields` 之外，单条 description 截断到首个换行
  （与 `skill-search` 的 `split('\n')[0]` 一致）。

### 2.5 测试矩阵（M1 验收）

| 用例 | 断言 |
|---|---|
| 服务缺失 | `ctx.get('skills')` undefined → resolver 返回 null，不注入、warnOnce |
| 正常列表 | stub `ctx.skills.list` 返回 2 个候选 → 默认文本含两行 `- name: desc` |
| `fields` 过滤 | 只输出声明字段；`whenToUse` 不在默认输出 |
| `limit` | 20 → 只列前 20；`SKILL_COUNT` 仍为过滤后总数 |
| `providers` 过滤 | 只保留 `provider === 'prompt-tool'` |
| `text` 模板 | `{{SKILL_COUNT}}` / `{{SKILLS_TEXT}}` 正确替换；未知占位保持原样 |
| `emptyBehavior` | skip → null；text → 注入 `emptyText` |
| pre-step 层 | 与 `dedupe: session` 组合，第二次调用不重复注入 |
| runtime-context 层 | 函数 provider 每次 assembly 重新解析（开关变化下次生效） |
| 异常降级 | `list` reject → 跳过并 warnOnce，其他配置照常注入 |

---

## 3. 设计二（M2）：宿主端校验端点与 settings schema 强化

### 3.1 目标

解决 G2：让 UI 在保存前能拿到**权威错误列表**，而不是"保存成功 → preset 重建 →
引擎挂载失败"的三段式反馈。

### 3.2 新增 bridge 端点（只读、无副作用）

```
POST /api/prompt-tool/settings/configs-validate
Body: { "promptConfigs": PromptConfigSpec[] }
200: { "ok": true, "valid": true, "configs": PromptConfigSpec[], "files": PromptConfigFile[] }
200: { "ok": true, "valid": false, "errors": [{ "index": 0, "id": "...", "message": "..." }] }
```

宿主实现路径：

1. 复用 `renderPromptConfigYaml` 渲染每一段（同一套渲染器，避免两套语义）；
2. 运行时 `await import(new URL('../preset/engine/prompt-config-engine.mjs', import.meta.url))`
   调用 `createPromptConfigs(specs)` 做权威校验——包内 `preset/` 随包发布，
   `lib/../preset` 相对路径成立；vendor yaml 相对 engine 文件解析，不受影响；
3. 捕获 `TypeError` 并映射为带 index/id 的错误列表；引擎错误信息已含
   `configs[i]` 前缀，可直接透传；
4. 该端点不写 settings、不写生成目录，校验失败不产生任何副作用。

### 3.3 PromptSettingsSchema 强化（宿主保存期校验）

把 `promptConfigs: z.array(z.any())` 升级为最小结构 schema：

- 必填：`id`（非空字符串）；
- 结构层：数组元素必须是 object；
- 其余字段保持宽松（`z.any()`），枚举级权威校验仍归 engine——避免在
  Schemastery 与 engine 两处复制全部枚举，二者漂移比宽松更危险。
- `promptConfigsDir` 保持 string。

这样 settings 保存能立刻拒绝"非数组 / 无 id"类垃圾，细粒度错误由
`configs-validate` 端点给出。

---


> M2 落地注记：校验实现位于 `src/runtime/configs-validate.ts`（`validatePromptConfigs`，
> 已从主入口导出）；逐条调用 engine `createPromptConfigs` 收集全部错误，valid=true
> 时返回逐条渲染的 yml 预览。schema 元素使用 `z.object({ id: z.string().required() })`，
> schemastery 非 strict object 会保留未知键，因此其余字段全部透传。

## 4. 设计三（M3）：默认模板库

### 4.1 目标

把 `promptConfigs.template.yml` 的 8 类示例拆为可独立复制的模板文件，供 UI
"插入模板"与用户手动复制使用。

### 4.2 结构

```
templates/
  10-pre-step.yml             # 通用消息批注入（完整字段注释）
  20-merged.yml               # merged 拼接组示例（两条）
  30-system-section.yml
  40-runtime-context.yml
  50-agent-request.yml
  60-llm-stream.yml
  70-tool-pipeline.yml
  80-placeholder-env-facts.yml
  90-placeholder-skill-catalog.yml   # M1 完成后补上，引用 §2 契约
```

每文件仍为单对象 `id/...`（与生成目录 yml 同构），文件头注释说明用途与合并方式。

### 4.3 bridge 输出

```
POST /api/prompt-tool/settings/templates
200: { ok: true, templates: [{ file, content, spec }] }
```

读取包内 `templates/`，用 `parseYaml` 解析出 `spec` 给 UI 预览。端点只读。

---


> M3 落地注记：模板库为包内 `templates/`（10 个单对象 yml：六层 + merged 对 +
> env-facts / skill-catalog），`src/runtime/templates.ts` 的 `loadPromptTemplates`
> 负责只读扫描解析（文件损坏 fail loud）；`/templates` 端点返回
> `{ file, content, spec }`；`package.json files` 已包含 `templates`。
> 测试保证"模板即合法配置"：全部模板逐条通过 `validatePromptConfigs`。

## 5. 设计四（M4）：Web/TUI 提示词配置编辑器

### 5.1 数据读取（现有能力即可）

`/describe` 已返回 `descriptor.value`，其中包含 `promptConfigs` 与
`promptConfigsDir`；`PromptEditor` 只需：

1. `Fields` 增加 `promptConfigs: PromptConfigSpec[]`、`promptConfigsDir: string`；
2. 从 `value → base` 逐级读取（与现有 `readString/readBoolean` 模式一致）；
3. 增加 `dirtyConfigs` 比较（按 JSON 序列化，与现有 `settingsChanged` 一致）。

### 5.2 UI 三层模型

| 层 | 内容 |
|---|---|
| 列表 | id / name / enabled / layer / strategy / position / priority / dedupe；开关、上移下移（改 `order` 数字而非数组位移）、删除、复制 |
| 表单 | 按 layer 动态渲染 `params` 子表单；enum 字段用下拉（值来自 engine 的 KNOWN_* 集合，与模板注释同步） |
| 源码 | 单条配置渲染为 YAML 源码编辑（复用 `/templates` 的解析 + `/configs-validate` 校验），面向高级用户 |

### 5.3 保存协议

- 仍走现有 `enqueueSave` 队列 + `expectedRevision` 乐观锁：
  `mutate { ops: [{ op: 'set', path: ['promptConfigs'], value: [...] }] }`；
- 保存前调 `configs-validate`，失败时在条目上内联展示错误，阻止保存；
- `promptConfigsDir` 独立保存（与 `skillsDir` 的 UX 一致：输入框 + 应用按钮，
  应用后 reload 列表）。

### 5.4 TUI 扩展（只读 + 开关，不做编辑）

```
/prompt-tool configs                 # 列表：id enabled layer strategy
/prompt-tool config <id>             # 详情：完整字段与 params 摘要
/prompt-tool config <id> on|off      # 通过 settings.mutate 切换 enabled
```

---

## 6. 层能力矩阵（写入 README，消除 G8 歧义）

| 层 | modelScope | subagents | promotion | dedupe | merge | 文本插值 |
|---|---|---|---|---|---|---|
| pre-step | ✓ | ✓ | ✓ | ✓ | ✓（position 内） | 内置+variables+filler |
| system-section | ✗（注册即全局） | ✗ | ✗ | ✗ | ✓（order 内） | variables + 官方 `{{var}}` |
| runtime-context（static） | ✗ | ✗ | ✗ | ✗ | ✓（order 内） | variables |
| runtime-context（placeholder） | ✗ | ✗ | ✗ | ✗ | 单条 | variables+filler |
| agent-request | ✓ | ✓ | ✗ | ✗ | 按 priority 注册 | params.patch 不插值 |
| llm-stream | ✓ | ✗（缺口，见 G8） | ✗ | ✗ | 按 priority 注册 | 无 |
| tool-pipeline | ✓ | ✓ | ✗ | ✗ | 按 priority 注册 | text 不插值 |

> 说明：✗ 不是 bug 而是"该层官方 API 没有逐 agent 概念"的语义边界；M5 文档同步时
> 把本矩阵写入 README，避免用户误配。G7 的插值统一不作为 M1–M4 改动项（会改变
> 现有行为），仅在文档中定版为规则。

---

## 7. 实施顺序与验收

1. **M1 skill-catalog filler**：engine 实现 + §2.5 测试 + 模板条目更新。**（已完成）**
2. **M2 validate 端点 + schema 最小强化**：settings-bridge + 测试。**（已完成）**
   （合法通过 / 非法返回逐条错误 / 端点无副作用）。
3. **M3 模板库**：templates/ 目录 + `/templates` 端点 + 测试。**（已完成）**
4. **M4 编辑器**：PromptEditor 列表/表单 + 模板插入 + 保存前校验 + TUI 子命令；
   客户端注册 `settings.section`（主设置一级页，order=160），不占插件分类。
   params / variables / identity 以 JSON 文本域编辑（未做整数组 YAML 源码模式）。**（已完成）**
5. **M5 文档同步**：修正 G4/G5/G6，写入 §6 矩阵，更新 plan.md 待办勾选。

---

## 8. 待确认决策点

> M1 已按本设计默认值实现：`providers` 默认全部（可过滤）、`limit` 默认 20、
> `emptyBehavior` 默认 skip；决策点 3 落地为「列表 + 单条表单 + JSON 高级域」，
> 未引入整数组 YAML 源码模式。

1. `skill-catalog` 的 `params.providers` 默认：**全部 provider** 还是
   **仅 prompt-tool**？（本设计默认全部，可过滤）
2. `limit` 默认 20 是否合适？（对齐 skill-search 的 MAX_RESULTS）
3. M4 是否允许"整数组 YAML/JSON 源码编辑"作为高级模式？（本设计默认允许，
   但校验统一走 `configs-validate`）
