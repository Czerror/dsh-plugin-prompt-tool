/** templates 域端点：内置提示词模板与工具模板清单（只读）。 */
import { loadPromptTemplates, loadToolTemplates } from '../../host/templates.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import type { BridgeRuntime } from '../bridge-runtime.ts'

export function registerTemplates(runtime: BridgeRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.templates, { body: 'none', handle: async (tx) => {
      try {
        const templates = loadPromptTemplates()
        const toolTemplates = loadToolTemplates()
        tx.write(200, { ok: true, value: { templates, toolTemplates } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(500, { ok: false, code: 'templates-unavailable', message })
      }
    } }),
  ]
}
