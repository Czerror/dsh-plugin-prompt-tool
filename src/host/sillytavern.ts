/**
 * SillyTavern 预设 → 本项目单文件预设转换引擎（纯函数，无文件 IO）。
 *
 * 按需转换原则：只按注入层级映射 SillyTavern 实际内容，不注入本项目默认内容。
 *   - prompts[] → promptConfigs：system_prompt+role=system → system-section（可拼接）；
 *     其余 → pre-step（role/position/dedupe 按 ST 语义）；
 *   - 采样参数 → agent-request 层 st-sampling（官方 LlmCallConfig patch）；
 *   - modules 按需组装：prompt-config-engine 始终，system-section 注入需要
 *     persona（complete: false 允许 system-section 生效）。
 */
import type { PresetSpec } from './manifest.ts'

const REASONING_EFFORT_WHITELIST = new Set(['off', 'low', 'high', 'max'])

/** SillyTavern JSON 预设卡片 → 本项目 PresetSpec（导入端点直接消费）。 */
export function convertStToPreset(card: unknown, baseName: string): PresetSpec {
  const record = card !== null && typeof card === 'object' ? card as Record<string, unknown> : {}
  const prompts = Array.isArray(record.prompts)
    ? (record.prompts as Array<Record<string, unknown>>).filter((item) => item !== null && typeof item === 'object')
    : []
  const dropped: string[] = []
  const configs: Array<Record<string, unknown>> = []
  let systemSectionCount = 0

  for (const [index, prompt] of prompts.entries()) {
    const content = typeof prompt.content === 'string' ? prompt.content : ''
    if (content.trim().length === 0) {
      dropped.push(`${String(prompt.identifier ?? prompt.name ?? '未命名')}: 空内容`)
      continue
    }
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

  // 采样参数 → agent-request patch（官方 LlmCallConfig 支持 temperature/maxTokens/reasoningEffort）。
  const patch: Record<string, unknown> = {}
  if (typeof record.temperature === 'number') patch.temperature = record.temperature
  if (typeof record.openai_max_tokens === 'number' && record.openai_max_tokens > 0) patch.maxTokens = record.openai_max_tokens
  if (typeof record.reasoning_effort === 'string' && REASONING_EFFORT_WHITELIST.has(record.reasoning_effort)) {
    patch.reasoningEffort = record.reasoning_effort
  } else if (typeof record.reasoning_effort === 'string' && record.reasoning_effort.length > 0) {
    dropped.push(`reasoning_effort: ${record.reasoning_effort}（dsh 仅支持 off/low/high/max）`)
  }
  if (Object.keys(patch).length > 0) {
    configs.push({
      id: 'st-sampling',
      name: '采样参数（SillyTavern 转换）',
      enabled: true,
      strategy: 'static',
      layer: 'agent-request',
      order: -100,
      params: { patch },
    })
  }
  dropped.push(record.enable_web_search === true
    ? 'enable_web_search: true → 需 tool-web 模块（当前未启用）'
    : 'enable_web_search: false（不启用 web 搜索）')

  // modules 按需组装：prompt-config-engine 始终；system-section 注入需要 persona 服务。
  const modules = ['prompt-config-engine']
  const moduleConfigs: Record<string, Record<string, unknown>> = {}
  if (systemSectionCount > 0) {
    modules.unshift('persona')
    // 只覆盖转换必需的键：complete: false 允许 system-section 生效；
    // text/includeRuntimeContext 不声明（用引擎模块库默认，不注入 anchored 内容）。
    moduleConfigs.persona = { complete: false }
  }

  const presetId = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'sillytavern'
  return {
    id: presetId,
    name: `${baseName}（SillyTavern 转换）`,
    description: `由 SillyTavern 预设「${baseName}」按需转换：${configs.length} 条配置（${configs.map((config) => String(config.id)).join('/')}）。modules 按需组装（${modules.join(' + ')}）。已丢弃：${dropped.join('；')}`,
    version: '1.0.0',
    engineCompat: '>=0.4.2',
    modules,
    moduleConfigs,
    promptConfigs: configs,
  }
}
