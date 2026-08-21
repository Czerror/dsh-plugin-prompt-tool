/**
 * SillyTavern 预设 → 本项目单文件预设转换引擎（纯函数，无文件 IO）。
 *
 * 按需转换原则：只按注入层级映射 SillyTavern 实际内容，不注入本项目默认内容。
 *   - prompts[] → promptConfigs：system_prompt+role=system → system-section（可拼接）；
 *     其余 → pre-step（role/position/dedupe 按 ST 语义）；
 *   - 采样参数 → 顶层 params.model*（主对话统一参数体系；经 mergePresetDefaults
 *     合并进 Config，由 writePreset 渲染为 agent-request patch，audience=main）；
 *   - modules 按需组装：prompt-config-engine 始终，system-section 注入需要
 *     persona（complete: false 允许 system-section 生效）。
 */
import type { PresetSpec } from './manifest.ts'

/** SillyTavern JSON 预设卡片 → 本项目 PresetSpec（导入端点直接消费）。 */
export function convertStToPreset(card: unknown, baseName: string): PresetSpec {
  const record = card !== null && typeof card === 'object' ? card as Record<string, unknown> : {}
  const prompts = Array.isArray(record.prompts)
    ? (record.prompts as Array<Record<string, unknown>>).filter((item) => item !== null && typeof item === 'object')
    : []
  const configs: Array<Record<string, unknown>> = []
  let systemSectionCount = 0

  for (const [index, prompt] of prompts.entries()) {
    const content = typeof prompt.content === 'string' ? prompt.content : ''
    if (content.trim().length === 0) continue
    const rawId = typeof prompt.identifier === 'string' ? prompt.identifier : ''
    const id = rawId.length > 0 && !/^[0-9a-f-]{36}$/i.test(rawId) ? rawId : `st-prompt-${index + 1}`
    const base = {
      id,
      name: typeof prompt.name === 'string' && prompt.name.length > 0 ? prompt.name : id,
      // 保留 SillyTavern 启用状态：OFF 的备用提示词转 enabled: false（UI 卡片可切换启用）。
      enabled: prompt.enabled !== false,
      strategy: 'static',
      order: (typeof prompt.injection_order === 'number' ? prompt.injection_order : 100) + index * 10,
      text: content,
    }
    if (prompt.system_prompt === true && prompt.role === 'system') {
      // 多个 system-section 可拼接：mergeMode=merged 时引擎按 order 升序拼为一条 system prompt。
      configs.push({ ...base, layer: 'system-section', mergeMode: 'merged' })
      systemSectionCount += 1
    } else {
      configs.push({
        ...base,
        layer: 'pre-step',
        mergeMode: 'merged',
        role: prompt.role === 'assistant' ? 'assistant' : 'user',
        position: prompt.injection_position === 0 ? 'before-all' : 'after-user',
        dedupe: 'none',
      })
    }
  }

  // 采样参数 → 顶层 params.model*（本项目主对话统一参数体系，字符串与 Config schema 对齐；
  // 由 writePreset 的 modelRequestConfigs 渲染为 agent-request patch，audience=main）。
  const params: Record<string, unknown> = {}
  if (typeof record.temperature === 'number') params.modelTemperature = String(record.temperature)
  if (typeof record.openai_max_tokens === 'number' && record.openai_max_tokens > 0) {
    params.modelMaxTokens = String(record.openai_max_tokens)
  }
  // reasoning_effort 透传任意非空字符串：官方 ReasoningEffortId 是不透明标识
  // （适配器拥有，无校验），档位由模型适配器决定；仅丢弃非字符串/空值。
  if (typeof record.reasoning_effort === 'string' && record.reasoning_effort.trim().length > 0) {
    params.modelReasoningEffort = record.reasoning_effort.trim()
  }

  // modules 按需组装：prompt-config-engine 始终；system-section 注入需要 persona 服务。
  const modules = ['prompt-config-engine']
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  if (systemSectionCount > 0) {
    modules.unshift('persona')
    // 只覆盖转换必需的键：complete: false 允许 system-section 生效；
    // text/includeRuntimeContext 不声明（用引擎模块库默认，不注入 anchored 内容）。
    moduleConfigs.persona = { complete: false }
  }
  // enable_web_search → 按原 JSON 开关装配：
  //   true  → 组装 tool-web（fetch: true 启用）；
  //   false → 不组装 tool-web，改加 tool-filter 黑名单（deny web_search/web_fetch），
  //           即使宿主/其他模块装配了 tool-web，本预设会话也不暴露 web 工具。
  if (record.enable_web_search === true) {
    modules.push('tool-web')
    moduleConfigs['tool-web'] = { fetch: true }
  } else if (record.enable_web_search === false) {
    modules.push('tool-filter')
    moduleConfigs['tool-filter'] = { includeSubagents: false, deny: ['web_search', 'web_fetch'] }
  }

  const presetId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sillytavern'
  // 预设名优先取卡片 name 字段；缺失/空白时回退文件名（去 .json 的 baseName）。
  const cardName = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : ''
  return {
    id: presetId,
    name: `${cardName || baseName}（SillyTavern 转换）`,
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    ...(Object.keys(params).length > 0 ? { params } : {}),
    modules,
    moduleConfigs,
    promptConfigs: configs,
  }
}
