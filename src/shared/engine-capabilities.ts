/** 引擎能力目录：把 UI capability id 与 preset module/row 实际事实解耦。 */

export type ModuleSourceMode = 'explicit' | 'composition' | 'official' | 'unknown'

export interface PresetModuleFacts {
  declaredModules: string[] | null
  effectiveModules: string[] | null
  rowIds: string[]
  sourceMode: ModuleSourceMode
  editable: boolean
  effectiveConfigs?: Record<string, Record<string, unknown>>
}

export interface EngineCapability {
  id: string
  moduleKeys: readonly string[]
  rowIds: readonly string[]
  displayLayer: 'pre-step' | 'system-section' | 'tool-pipeline'
}

/** 首期只登记已有 typed editor 的能力，避免万能 key/value 表单。 */
export const ENGINE_CAPABILITIES: readonly EngineCapability[] = [
  { id: 'tool-bootstrap', moduleKeys: ['tool-bootstrap'], rowIds: ['tool-bootstrap'], displayLayer: 'system-section' },
  { id: 'context-gate', moduleKeys: ['context-gate'], rowIds: ['context-gate'], displayLayer: 'pre-step' },
  { id: 'anchor-turn', moduleKeys: ['anchor-turn'], rowIds: ['anchor-turn'], displayLayer: 'pre-step' },
  { id: 'code-presentation', moduleKeys: ['code-presentation'], rowIds: ['code-presentation'], displayLayer: 'tool-pipeline' },
  { id: 'tool-filter', moduleKeys: ['tool-filter'], rowIds: ['tool-filter'], displayLayer: 'tool-pipeline' },
  { id: 'str-replace-editor', moduleKeys: ['str-replace-editor'], rowIds: ['str-replace-editor'], displayLayer: 'tool-pipeline' },
  { id: 'deliberation-gate', moduleKeys: ['deliberation-gate'], rowIds: ['deliberation-gate'], displayLayer: 'tool-pipeline' },
  { id: 'cot-drip', moduleKeys: ['cot-drip'], rowIds: ['cot-drip'], displayLayer: 'tool-pipeline' },
] as const

export interface EngineRecipe {
  id: string
  capabilities: readonly string[]
  initialParams?: Readonly<Record<string, unknown>>
}

/** 只保留已有真实工作流的一键组合；recipe 本身不写入 preset.yml。 */
export const ENGINE_RECIPES: readonly EngineRecipe[] = [
  { id: 'phase-control', capabilities: ['context-gate', 'tool-bootstrap'] },
  { id: 'phase-control-ptc', capabilities: ['context-gate', 'tool-bootstrap', 'code-presentation'], initialParams: { usePtcMode: true } },
  { id: 'deliberation', capabilities: ['deliberation-gate', 'cot-drip'], initialParams: { deliberationGate: true, cotDrip: true } },
] as const

export function engineCapability(id: string): EngineCapability | undefined {
  return ENGINE_CAPABILITIES.find((capability) => capability.id === id)
}

export function engineRecipe(id: string): EngineRecipe | undefined {
  return ENGINE_RECIPES.find((recipe) => recipe.id === id)
}

/** 只有显式 modules 才代表本插件按需装配的能力；官方组合行只作运行事实。 */
export function isEngineCapabilityPresent(id: string, facts: PresetModuleFacts | undefined): boolean {
  if (facts === undefined || facts.sourceMode !== 'explicit' || facts.effectiveModules === null) return false
  const capability = engineCapability(id)
  if (capability === undefined) return false
  const modules = new Set(facts.effectiveModules ?? [])
  return capability.moduleKeys.some((key) => modules.has(key))
}

export interface CustomToolIdentity {
  index: number
  id: string
  name: string
}

/** custom tool 的运行时名称缺省回落 id；保存前拒绝会导致同层注册失败的重复项。 */
export function validateCustomToolIdentities(tools: readonly unknown[]): string[] {
  const errors: string[] = []
  const ids = new Map<string, number>()
  const names = new Map<string, number>()
  for (const [index, value] of tools.entries()) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`customTools[${index}] 必须是对象`)
      continue
    }
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (id.length === 0) {
      errors.push(`customTools[${index}].id 必须是非空字符串`)
      continue
    }
    const name = typeof record.name === 'string' && record.name.trim().length > 0 ? record.name.trim() : id
    const previousId = ids.get(id)
    if (previousId !== undefined) errors.push(`customTools[${index}].id 与 customTools[${previousId}] 重复：${id}`)
    else ids.set(id, index)
    const previousName = names.get(name)
    if (previousName !== undefined) errors.push(`customTools[${index}].name 与 customTools[${previousName}] 重复：${name}`)
    else names.set(name, index)
  }
  return errors
}
