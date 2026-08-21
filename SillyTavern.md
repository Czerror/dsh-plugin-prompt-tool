# SillyTavern 预设转换指南

把 SillyTavern 预设卡片 JSON（含 `prompts[]` 的预设文件）转换为本项目预设（preset.yml + promptConfigs），
转换引擎为 `src/host/sillytavern.ts` 的 `convertStToPreset`（纯函数，无文件 IO）。

**入口**：工作台「预设配置」页导入——导入包无预设定义文件（preset.yml / 任意 *.yml/*.yaml）、
仅含单个 `.json` 时自动识别并转换。转换结果为普通预设（工作台预设切换器可直接使用）。

> 按需转换原则：只按注入层级映射 SillyTavern 实际内容，**不注入本项目默认提示词**。

## 顶层字段映射

| SillyTavern 字段 | 本项目落点 | 规则 |
|---|---|---|
| `prompts[]` | `promptConfigs[]` | 逐条转换，见下节 |
| `temperature` | `params.modelTemperature` | 数字 → 字符串（主对话采样温度，agent-request patch audience=main） |
| `openai_max_tokens` | `params.modelMaxTokens` | 仅 `> 0` 的数字（主对话输出上限） |
| `reasoning_effort` | `params.modelReasoningEffort` | 任意非空字符串透传（档位由模型适配器决定）；非字符串/空值丢弃 |
| `enable_web_search: true` | `modules` + `tool-web` | 组装 `tool-web`，`moduleConfigs.tool-web.fetch: true` |
| `enable_web_search: false` | `modules` + `tool-filter` | 不组装 tool-web，改加 `moduleConfigs.tool-filter.deny: [web_search, web_fetch]`（即使宿主装配了 web 工具也不暴露） |

## prompts[] 逐字段映射

| SillyTavern 字段 | 转换规则 |
|---|---|
| `content` | → `text`；空内容（trim 后为空）整条跳过 |
| `identifier` | → `id`；36 位 UUID 形态（`/^[0-9a-f-]{36}$/i`）退化为 `st-prompt-<序号>` |
| `name` | → `name`；缺失用 `id` |
| `enabled` | → `enabled`；`false` 原样保留（OFF 备用提示词转禁用，UI 卡片可重新启用） |
| `injection_order` | → `order`；缺失默认 100，另加 `序号 × 10` 保证声明顺序稳定 |
| `system_prompt: true` + `role: system` | → `layer: system-section` + `mergeMode: merged`（多条按 order 升序拼接为一条 system prompt） |
| `role: assistant`（非 system） | → `pre-step` + `role: assistant` |
| 其他 role | → `pre-step` + `role: user` |
| `injection_position: 0` | → `pre-step` + `position: before-all` |
| 其他 position | → `pre-step` + `position: after-user` |
| 非 system 全部 | → `strategy: static` + `dedupe: none` |

## modules / moduleConfigs 组装

| 条件 | modules | moduleConfigs |
|---|---|---|
| 始终 | `prompt-config-engine` | — |
| 含 system-section | 前插 `persona` | `persona.complete: false`（standard 语义，允许 system-section 生效；text 不声明，不注入 anchored 内容） |
| `enable_web_search: true` | 追加 `tool-web` | `tool-web.fetch: true` |
| `enable_web_search: false` | 追加 `tool-filter` | `tool-filter.includeSubagents: false` + `deny: [web_search, web_fetch]` |

## 生成预设元数据

| 字段 | 规则 |
|---|---|
| `id` | 文件名（去 `.json`）转小写 slug（非字母数字 → `-`，去首尾 `-`）；结果为空则 `sillytavern` |
| `name` | 卡片 `name` 字段（非空白）优先；缺失/空白时回退文件名（去 `.json`），统一加「（SillyTavern 转换）」后缀 |
| `version` / `engineCompat` | `1.0.0` / `">=0.4.2"` |

## 转换示例

输入 `roleplay-assistant.json`（SillyTavern 预设卡片）：

```json
{
  "name": "Roleplay Assistant",
  "temperature": 0.7,
  "openai_max_tokens": 2048,
  "reasoning_effort": "low",
  "enable_web_search": true,
  "prompts": [
    {
      "identifier": "intro-prompt",
      "name": "开场白",
      "content": "你是一个乐于助人的助手。",
      "role": "system",
      "system_prompt": true,
      "injection_order": 1,
      "injection_position": 0,
      "enabled": true
    },
    {
      "identifier": "guidance",
      "name": "行为准则",
      "content": "回答前先思考。",
      "role": "user",
      "injection_order": 2,
      "injection_position": 1,
      "enabled": false
    },
    {
      "identifier": "3f2a9c1e-7b4d-4f6a-9c2e-1a2b3c4d5e6f",
      "content": "备用提示词（无名称）",
      "role": "assistant",
      "injection_order": 3,
      "injection_position": 1,
      "enabled": true
    }
  ]
}
```

转换生成的 preset.yml：

```yaml
id: roleplay-assistant
name: Roleplay Assistant（SillyTavern 转换）  # 卡片 name 字段优先；空白时回退文件名
version: 1.0.0
engineCompat: ">=0.4.2"
params:
  modelTemperature: "0.7"
  modelMaxTokens: "2048"
  modelReasoningEffort: low
modules:
  - persona          # system-section 注入需要 persona 服务
  - prompt-config-engine
  - tool-web         # enable_web_search: true
moduleConfigs:
  persona:
    complete: false  # standard 语义，允许 system-section 生效
  tool-web:
    fetch: true
promptConfigs:
  - id: intro-prompt            # system_prompt + role=system → system-section
    name: 开场白
    enabled: true
    strategy: static
    order: 1                    # injection_order=1 + 0×10
    text: 你是一个乐于助人的助手。
    layer: system-section
    mergeMode: merged           # 多条 system-section 按 order 拼接
  - id: guidance
    name: 行为准则
    enabled: false              # ST OFF 状态保留，UI 可重新启用
    strategy: static
    order: 12                   # injection_order=2 + 1×10
    text: 回答前先思考。
    layer: pre-step
    mergeMode: merged
    role: user
    position: after-user        # injection_position=1 → after-user
    dedupe: none
  - id: st-prompt-3             # identifier 是 UUID 形态 → 序号兜底 id
    name: st-prompt-3
    enabled: true
    strategy: static
    order: 23                   # injection_order=3 + 2×10
    text: 备用提示词（无名称）
    layer: pre-step
    mergeMode: merged
    role: assistant             # ST role=assistant → pre-step assistant
    position: after-user
    dedupe: none
```

## 边界与注意

- 空 `content` 的提示词整条跳过（不生成 promptConfigs 项）。
- 采样参数只映射三个：`temperature` / `openai_max_tokens` / `reasoning_effort`；其余 ST 参数（如 top_p、presence_penalty）不转换。
- 转换后的 `params.model*` 走主对话统一参数体系，由 writePreset 渲染为 `agent-request` patch（audience=main）。
- 导入端点有路径穿越防护（仅接受扁平相对路径，拒绝 `..` / 盘符 / 绝对路径）。
- JSON 解析失败或转换异常 → 导入返回 400 `preset-package-invalid`，不会静默产生坏预设。

## 角色卡 PNG 提取（人设卡片图）

SillyTavern 人设卡片 PNG 的 JSON 藏在 PNG 的 `tEXt` chunk（键 `chara`）：
V1 = `base64(明文 JSON)`，V2 = `base64(zlib 压缩 JSON)`。项目提供提取脚本
（`scripts/extract-st-character.mjs`，零依赖，Node 内置 zlib）：

```sh
node scripts/extract-st-character.mjs card.png           # 提取角色卡 JSON → card.json
node scripts/extract-st-character.mjs --preset card.png  # 转本插件预设 JSON → card-preset.json
```

`--preset` 模式把角色卡字段映射为预设卡 JSON（`prompts[]` 结构，工作台「预设配置」页
直接导入，走与预设卡相同的转换链路）：

| 角色卡字段 | 预设 JSON prompts[] | 转换后注入层 |
|---|---|---|
| `system_prompt` | `role: system` + `system_prompt: true` | `system-section`（系统静态段） |
| `description` + `personality` + `scenario` | 合并为 `role: user` | `pre-step`（角色设定） |
| `first_mes` | `role: assistant` | `pre-step`（开场白） |
| `post_history_instructions` | `role: user` | `pre-step`（历史后指令） |
| `extensions.sampling.temperature` / `max_tokens` | 顶层 `temperature` / `openai_max_tokens` | `params.model*` |

> 角色卡 ≠ 预设卡：角色卡描述「角色是谁」，预设卡描述「注入什么、注入到哪一层」；
> PNG 提取转换后是后者，可在工作台预设切换器中直接使用。
