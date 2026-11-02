/** definitions 域端点：自定义工具与引擎能力/recipe。 */
import { basename } from 'node:path'
import { withModuleDefinition } from '../../host/module-definition-edit.ts'
import { loadModuleSpec } from '../../host/module-spec.ts'
import { ModuleWriteError } from '../../host/module-write.ts'
import { appendModuleCapabilities, createModuleCapability, removeModuleCapability } from '../../host/module-capabilities.ts'
import { validateCustomTools } from '../../host/custom-tools.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { MODULE_TOOL_CAPABILITIES, moduleCapability } from '../../shared/engine-capabilities.ts'
import { published } from '../../shared/publication.ts'
import { writeLayerSettingsError } from '../module-subject-gate.ts'
import type { BridgeRuntime } from '../bridge-runtime.ts'

/** 自定义工具声明需要的模块（模块缺失时保存动作自动补齐）。 */
function customToolModules(tools: unknown[]): string[] {
  const modules = new Set<string>()
  if (tools.length > 0) modules.add('tool-config-engine')
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) continue
    const execute = (tool as Record<string, unknown>).execute
    if (execute === null || typeof execute !== 'object' || Array.isArray(execute)) continue
    const executeRecord = execute as Record<string, unknown>
    if (executeRecord.kind !== 'delegate') continue
    const target = executeRecord.tool
    if (typeof target !== 'string') continue
    const capability = MODULE_TOOL_CAPABILITIES[target]
    if (capability !== undefined) modules.add(capability)
  }
  return [...modules]
}

/** module.yml 顶层的自定义工具段；定义损坏时抛错，不静默当空。 */
function readCustomToolsSection(dir: string): unknown[] {
  const spec = loadModuleSpec(dir)
  return Array.isArray(spec.customTools) ? spec.customTools : []
}

/** 模块当前声明的引擎能力 id（modules 段中已知的能力）；定义损坏时抛错。 */
function declaredCapabilityIds(dir: string): string[] {
  const spec = loadModuleSpec(dir)
  return (Array.isArray(spec.modules) ? spec.modules : [])
    .filter((id): id is string => typeof id === 'string' && moduleCapability(id) !== undefined)
}

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type DefinitionsRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'gate' | 'capabilityQueue' | 'finishModuleChange' | 'runOverridesChange' | 'schedulePublication'>

export function registerDefinitions(runtime: DefinitionsRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.customTools, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦：写自定义工具是给模块添加第一节，放行。
      const dir = runtime.gate(tx, 'customTools').inspect(record.customTools !== undefined)
      if (dir === undefined) return
      // refreshOnly：只重试运行发布，不重写定义；快照读回失败按未执行处理。
      if (record.refreshOnly === true) {
        if (record.customTools !== undefined) {
          tx.write(400, { ok: false, code: 'custom-tools-invalid', message: 'refreshOnly 不能与 customTools 写入混用' })
          return
        }
        if (runtime.gate(tx, 'customTools').authorize() === undefined) return
        let customTools: unknown[] = []
        try {
          customTools = readCustomToolsSection(dir)
        } catch (error) {
          if (writeLayerSettingsError(tx.write, error)) return
          tx.write(409, { ok: false, code: 'custom-tools-unavailable', message: '自定义工具读取失败，未触发运行发布' })
          return
        }
        const publication = await runtime.runOverridesChange(basename(dir))
        tx.write(200, { ok: true, value: { customTools, ...publication } })
        return
      }
      // 无载荷 = 读取（module.yml 顶层 customTools 段）。
      if (record.customTools === undefined) {
        try {
          tx.write(200, { ok: true, value: { customTools: readCustomToolsSection(dir) } })
        } catch (error) {
          if (writeLayerSettingsError(tx.write, error)) return
          tx.write(409, { ok: false, code: 'custom-tools-unavailable', message: '自定义工具读取失败，原文件保持不变' })
        }
        return
      }
      try {
        const customTools = record.customTools
        if (!Array.isArray(customTools)) {
          tx.write(400, { ok: false, code: 'custom-tools-invalid', message: 'customTools 必须是数组' })
          return
        }
        const errors = validateCustomTools(customTools)
        if (errors.length > 0) {
          tx.write(400, { ok: false, code: 'custom-tools-invalid', message: errors.join('; ') })
          return
        }
        if (runtime.gate(tx, 'customTools').authorize() === undefined) return
        withModuleDefinition(dir, (doc) => {
          if (customTools.length === 0) doc.deleteIn(['customTools'])
          else {
            doc.setIn(['customTools'], customTools)
            appendModuleCapabilities(doc, customToolModules(customTools))
          }
        }, { owns: ['customTools', 'modules'] })
        const publication = await runtime.schedulePublication(basename(dir))
        tx.write(200, { ok: true, value: { customTools, ...publication } })
      } catch (error) {
        if (error instanceof ModuleWriteError && error.persisted) {
          tx.write(200, { ok: true, value: { customTools: record.customTools as unknown[], ...published(error.message) } })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        // 全桥统一规则：host 分类优先（如 shared-alias），端点码只兜底。
        tx.write(error instanceof ModuleWriteError ? error.status : 409, {
          ok: false,
          code: error instanceof ModuleWriteError ? error.code : 'custom-tools-rejected',
          message: `自定义工具保存失败：${message}`,
        })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleCapability, { handle: async (tx) => {
      // 这个端点的三种动作都改定义（`modules` 段），按写路径走门：不查声明面，可写校验先判。
      const dir = runtime.gate(tx, 'moduleCapability').authorize()
      if (dir === undefined) return
      const body = tx.record
      // refreshOnly：只重试运行发布，不执行 create/remove。
      if (body.refreshOnly === true) {
        if (body.action !== undefined || body.capabilityId !== undefined || body.recipeId !== undefined) {
          tx.write(400, { ok: false, code: 'engine-capability-invalid', message: 'refreshOnly 不能与能力写入混用' })
          return
        }
        const run = runtime.capabilityQueue.run(async () => {
          if (runtime.gate(tx, 'moduleCapability').authorize() === undefined) return
          let capabilityIds: string[] = []
          try {
            capabilityIds = declaredCapabilityIds(dir)
          } catch (error) {
            if (writeLayerSettingsError(tx.write, error)) return
            tx.write(409, { ok: false, code: 'engine-capability-invalid', message: '能力读取失败，未触发运行发布' })
            return
          }
          const publication = await runtime.finishModuleChange(() => runtime.deps.capabilityChanged?.(basename(dir)))
          tx.write(200, { ok: true, value: { changed: false, capabilityIds, ...publication } })
        })
        await run
        return
      }
      const action = body.action
      const id = action === 'create' || action === 'remove' ? body.capabilityId : action === 'create-recipe' ? body.recipeId : undefined
      if ((action !== 'create' && action !== 'remove' && action !== 'create-recipe') || typeof id !== 'string' || id.trim().length === 0 || id.length > 128) {
        tx.write(400, { ok: false, code: 'engine-capability-invalid', message: '能力或 recipe 请求格式无效' })
        return
      }
      const run = runtime.capabilityQueue.run(async () => {
        // 队列等待之后的写前复检：可写 + 身份一次判完（默认核形状）。
        if (runtime.gate(tx, 'moduleCapability').authorize() === undefined) return
        try {
          const result = action === 'remove'
            ? removeModuleCapability(dir, id.trim())
            : createModuleCapability(dir, action === 'create'
              ? { action: 'create', capabilityId: id.trim() }
              : { action: 'create-recipe', recipeId: id.trim() })
          const publication = result.changed
            ? await runtime.schedulePublication(basename(dir), 'capability')
            : published()
          tx.write(200, { ok: true, value: { ...result, ...publication } })
        } catch (error) {
          if (error instanceof ModuleWriteError && error.persisted) {
            let capabilityIds: string[] = [id]
            try { capabilityIds = declaredCapabilityIds(dir) } catch { /* 读回失败时保留本次触碰的 id，不隐藏已写盘事实 */ }
            tx.write(200, { ok: true, value: { changed: true, capabilityIds, ...published(error.message) } })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          tx.write(409, { ok: false, code: 'engine-capability-rejected', message: `引擎能力变更失败：${message}` })
        }
      })
      await run
    } }),
  ]
}
