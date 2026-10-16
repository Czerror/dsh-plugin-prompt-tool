/** settings 域端点：settings 总闸与全局键写入（引擎参数不进这里）。 */
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import { PARAM_KEYS, readModulesEnabled } from '../../config.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import type { BridgeRuntime } from '../bridge-runtime.ts'

export function registerSettingsDomain(runtime: BridgeRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.mutate, { handle: async (tx) => {
      // optional：空目标 = 只改全局键、descriptor 不投影 moduleId；目标只当身份用，
      // 形状检查关掉——总闸开关不该被某个损坏模块挡住。
      const dir = runtime.gate(tx, 'mutate').inspect()
      if (dir === undefined) return
      const record = tx.record
      if (!Array.isArray(record.ops)) {
        tx.write(400, { ok: false, code: 'settings-rejected', message: 'malformed bridge settings request' })
        return
      }
      // 引擎参数按模块/全局层存储：settings mutate 只接受全局键。
      const paramOp = record.ops.find((op) => {
        const path = (op as { path?: unknown })?.path
        return Array.isArray(path) && path.length > 0 && typeof path[0] === 'string' && PARAM_KEYS.has(path[0])
      })
      if (paramOp !== undefined) {
        tx.write(400, { ok: false, code: 'settings-rejected', message: '引擎参数不进 settings：模块自己的写 module.yml、指令卡的全局层写 config.yml，请用设置页保存（/param-overrides）' })
        return
      }
      const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
      try {
        const ops = record.ops as SettingsPathOp[]
        const toggles = ops.filter(op => op.path.length === 1 && op.path[0] === 'modulesEnabled')
        const values = Object.fromEntries(toggles.filter(op => op.op === 'set').map(op => [op.path[0], (op as { value: unknown }).value]))
        if (toggles.length > 0) readModulesEnabled(values)
        await runtime.scope.settings.mutate(runtime.ns, ops, expectedRevision)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(409, { ok: false, code: 'settings-rejected', message })
        return
      }
      // mutate 后必须重查宿主拿新 view（缓存已失效，跳过旧值）。
      runtime.descriptor.invalidate()
      const descriptor = runtime.descriptor.find()
      if (descriptor === undefined) {
        tx.write(500, { ok: false, code: 'settings-rejected', message: 'prompt-tool settings namespace was disposed after mutate' })
        return
      }
      tx.write(200, { ok: true, value: runtime.descriptor.forTarget(descriptor, dir) })
    } }),
  ]
}
