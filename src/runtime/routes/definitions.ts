/** definitions 域端点：自定义工具、人设与人设来源、引擎能力/recipe。 */
import { basename, dirname } from 'node:path'
import { readPersonaSources, writePersonaSources } from '../../host/persona-selection.ts'
import { userModulesDir } from '../../host/module-dirs.ts'
import { readModulePersona, saveModulePersona, withModuleDefinition } from '../../host/module-definition-edit.ts'
import { loadModuleSpec } from '../../host/module-spec.ts'
import { loadModuleDefinition, ModuleRulesError } from '../../host/module-storage.ts'
import { appendModuleCapabilities, createModuleCapability, removeModuleCapability } from '../../host/module-capabilities.ts'
import { validateCustomTools } from '../../host/custom-tools.ts'
import { MODULE_ACTIVATION_FAILED, BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { readPersonaSpec, type PersonaSources } from '../../shared/persona-section.ts'
import { MODULE_TOOL_CAPABILITIES } from '../../shared/engine-capabilities.ts'
import { writeLayerSettingsError } from '../module-subject-gate.ts'
import { SHA256_HEX_RE, type BridgeRuntime } from '../bridge-runtime.ts'

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

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type DefinitionsRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'gate' | 'capabilityQueue' | 'finishModuleChange' | 'runOverridesChange'>

export function registerDefinitions(runtime: DefinitionsRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.customTools, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦：写自定义工具是给模块添加第一节，放行。
      const dir = runtime.gate(tx, 'customTools').inspect(record.customTools !== undefined)
      if (dir === undefined) return
      // 无载荷 = 读取（module.yml 顶层 customTools 段）。
      if (record.customTools === undefined) {
        try {
          const spec = loadModuleSpec(dir)
          const customTools = Array.isArray(spec.customTools) ? spec.customTools : []
          tx.write(200, { ok: true, value: { customTools } })
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
        if (!await runtime.runOverridesChange(tx.write, basename(dir))) return
        tx.write(200, { ok: true, value: { customTools } })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // 全桥统一规则：host 分类优先（如 shared-alias），端点码只兜底——与 /persona 同形。
        tx.write(error instanceof ModuleRulesError ? error.status : 409, {
          ok: false,
          code: error instanceof ModuleRulesError ? error.code : 'custom-tools-rejected',
          message: `自定义工具保存失败：${message}`,
        })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.persona, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦：保存/刷新人设是给模块添加第一节，放行。
      const dir = runtime.gate(tx, 'persona').inspect(record.persona !== undefined || record.refreshOnly === true)
      if (dir === undefined) return
      if (Object.keys(record).some(key => !['persona', 'expectedModuleId', 'expectedRevision', 'refreshOnly'].includes(key))
        || record.refreshOnly !== undefined && (typeof record.refreshOnly !== 'boolean'
          || record.refreshOnly === true && (record.persona !== undefined || record.expectedRevision !== undefined))) {
        tx.write(400, { ok: false, code: 'module-persona-invalid', message: '人设请求包含非法字段或混合了刷新与写入' })
        return
      }
      try {
        if (record.persona === undefined && record.refreshOnly !== true) {
          if (record.expectedRevision !== undefined) throw new TypeError('读取人设不接受写入版本')
          tx.write(200, { ok: true, value: readModulePersona(dir) })
          return
        }
        if (runtime.gate(tx, 'persona').authorize() === undefined) return
        if (typeof record.expectedModuleId !== 'string') throw new TypeError('保存或刷新人设必须提供 expectedModuleId')
        let saved
        if (record.refreshOnly === true) saved = readModulePersona(dir)
        else {
          const persona = record.persona === null ? null : readPersonaSpec(record.persona)
          if (persona === undefined) throw new TypeError('persona 必须是主/子覆盖对象或 null')
          const root = dirname(dir), id = basename(dir)
          // 未声明 persona 的模块首次写入＝**创建**：没有前状态就没有可冲突的对象，允许 `expectedRevision`
          // 缺席（用当次读取的版本即可，saveModulePersona 仍会在写盘前复核它）；已声明时仍必须是读取时的 64 位 hex。
          const creating = record.expectedRevision === undefined && !Object.hasOwn(loadModuleDefinition(dir).source, 'persona')
          if (!creating && (typeof record.expectedRevision !== 'string' || !SHA256_HEX_RE.test(record.expectedRevision))) {
            throw new TypeError('保存人设必须提供读取时的 expectedRevision')
          }
          saved = saveModulePersona(root, id, persona, creating ? readModulePersona(dir).revision : record.expectedRevision as string)
        }
        try { await runtime.deps.overridesChanged?.(basename(dir)) }
        catch (error) {
          tx.write(200, { ok: true, value: { ...saved, persisted: true, publicationPending: true, publicationError: `人设已保存，但运行发布失败：${String(error)}` } })
          return
        }
        tx.write(200, { ok: true, value: { ...saved, persisted: true, publicationPending: false } })
      } catch (error) {
        if (error instanceof ModuleRulesError && error.persisted) {
          tx.write(200, { ok: true, value: { ...readModulePersona(dir), persisted: true, publicationPending: true, publicationError: error.message } })
          return
        }
        const message = error instanceof Error ? error.message : String(error)
        tx.write(error instanceof ModuleRulesError ? error.status : error instanceof TypeError ? 400 : 409,
          { ok: false, code: error instanceof ModuleRulesError ? error.code : 'module-persona-rejected', message: `人设读取或保存失败：${message}` })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.personaSources, { handle: async (tx) => {
      const record = tx.record
      if (Object.keys(record).some(key => !['sources', 'expectedRevision', 'refreshOnly'].includes(key))
        || record.refreshOnly !== undefined && typeof record.refreshOnly !== 'boolean'
        || record.refreshOnly === true && (record.sources !== undefined || record.expectedRevision !== undefined)) {
        tx.write(400, { ok: false, code: 'persona-sources-invalid', message: '人设来源请求包含非法字段或混合了刷新与写入' })
        return
      }
      try {
        const root = userModulesDir()
        if (record.sources === undefined && record.refreshOnly !== true) {
          if (record.expectedRevision !== undefined) throw new TypeError('读取人设来源不接受写入版本')
          tx.write(200, { ok: true, value: readPersonaSources(root) })
          return
        }
        if (record.refreshOnly !== true && record.expectedRevision !== null
          && (typeof record.expectedRevision !== 'string' || !SHA256_HEX_RE.test(record.expectedRevision))) {
          throw new TypeError('保存人设来源必须提供读取时的 expectedRevision')
        }
        const saved = record.refreshOnly === true ? readPersonaSources(root)
          : writePersonaSources(root, record.sources as PersonaSources, record.expectedRevision as string | null)
        try { await runtime.deps.overridesChanged?.() }
        catch (error) {
          tx.write(200, { ok: true, value: { ...saved, persisted: true, publicationPending: true, publicationError: `人设来源已保存，但运行发布失败：${String(error)}` } })
          return
        }
        tx.write(200, { ok: true, value: { ...saved, persisted: true, publicationPending: false } })
      } catch (error) {
        tx.write(error instanceof ModuleRulesError ? error.status : error instanceof TypeError ? 400 : 409,
          { ok: false, code: error instanceof ModuleRulesError ? error.code : 'persona-sources-rejected', message: error instanceof Error ? error.message : String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.moduleCapability, { handle: async (tx) => {
      // 这个端点的三种动作都改定义（`modules` 段），按写路径走门：不查声明面，可写校验先判。
      const dir = runtime.gate(tx, 'moduleCapability').authorize()
      if (dir === undefined) return
      const body = tx.record
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
          if (result.changed && !await runtime.finishModuleChange(tx.write, () => runtime.deps.capabilityChanged?.(basename(dir)))) return
          tx.write(200, { ok: true, value: result })
        } catch (error) {
          if (error instanceof ModuleRulesError && error.persisted) {
            tx.write(500, { ok: false, code: MODULE_ACTIVATION_FAILED, message: `能力变更已保存，但切片未发布；请重试刷新：${error.message}` })
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
