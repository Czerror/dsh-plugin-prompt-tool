/** 已启用配置卡的排序：轻量序号归各自 module.yml，文件是可重建投影。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { enabledModuleIds } from './config-store.ts'
import { assertModuleDirectory } from './module-install.ts'
import { invalidateModuleSpec, loadModuleSpec } from './manifest.ts'
import { assertSafeConfigId } from './prompt-configs.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { atomicWriteTextFile } from './text-file.ts'
import { compareModuleConfigOrder, configIdentityKey } from '../shared/module-config-order.ts'
import type { ModuleConfigIdentity, ModuleConfigOrderEntry, ModuleConfigOrderSnapshot } from '../shared/module-config-order.ts'

interface ModuleOrderInput {
  moduleId: string
  dir: string
  raw: string
  doc: ReturnType<typeof parseDocument>
  saved: Record<string, number>
  entries: ModuleConfigOrderEntry[]
}

export class ModuleConfigOrderError extends Error {
  readonly status: 400 | 409
  readonly code: string
  constructor(message: string, conflict = false) {
    super(message)
    this.status = conflict ? 409 : 400
    this.code = conflict ? 'module-config-order-conflict' : 'module-config-order-invalid'
  }
}

export function readConfigOrder(value: unknown): Record<string, number> {
  if (value === undefined) return Object.create(null) as Record<string, number>
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('configOrder 必须是配置卡序号对象')
  for (const [id, sequence] of Object.entries(value)) {
    assertSafeConfigId(id)
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`配置卡 ${id} 的序号必须是非负安全整数`)
  }
  return Object.assign(Object.create(null), value) as Record<string, number>
}

function readInput(root: string, moduleId: string): ModuleOrderInput {
  const dir = assertModuleDirectory(root, moduleId)
  const raw = readFileSync(join(dir, MODULE_DEFINITION_FILE), 'utf8')
  const doc = parseDocument(raw, { logLevel: 'silent' })
  const saved = readConfigOrder(doc.toJS()?.configOrder)
  const spec = loadModuleSpec(dir)
  const cards = spec.rules ?? []
  const seen = new Set<string>()
  const entries = cards.map((card, index): ModuleConfigOrderEntry => {
    assertSafeConfigId(card.id)
    if (seen.has(card.id)) throw new Error(`模块 ${moduleId} 存在重复配置卡：${card.id}`)
    seen.add(card.id)
    const sequence = saved[card.id] ?? index * 10
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`配置卡 ${card.id} 的文件序号无效`)
    const config = card.do.find(action => action.kind === 'inject-text')?.config as Record<string, unknown> | undefined
    const layer = card.layer ?? (typeof config?.layer === 'string' ? config.layer : 'pre-step')
    const scope = card.when?.scope as { audience?: 'main' | 'subagent' } | undefined
    return { moduleId, configId: card.id, name: card.name ?? card.id, layer, position: typeof config?.position === 'string' ? config.position : 'after-user', sequence, enabled: card.enabled !== false,
      strategy: typeof config?.strategy === 'string' ? config.strategy : 'static', ...(scope?.audience === undefined ? {} : { audience: scope.audience }),
      ...(layer === 'system-section' || layer === 'runtime-context' ? { order: typeof config?.order === 'number' ? config.order : 0 } : {}) }
  })
  return { moduleId, dir, raw, doc, saved, entries }
}

function readInputs(root: string, ids = enabledModuleIds(root)): ModuleOrderInput[] {
  return [...new Set(ids)].sort().map(id => readInput(root, id))
}

function snapshotOf(inputs: ModuleOrderInput[]): ModuleConfigOrderSnapshot {
  return {
    revision: createHash('sha256').update(JSON.stringify(inputs.map(input => [input.moduleId, input.raw, input.entries]))).digest('hex'),
    entries: inputs.flatMap(input => input.entries).sort(compareModuleConfigOrder),
  }
}

export function readModuleConfigOrder(root: string, moduleId?: string): ModuleConfigOrderSnapshot {
  return snapshotOf(readInputs(root, moduleId === undefined ? undefined : [moduleId]))
}

function writeOrders(root: string, inputs: ModuleOrderInput[], orders: Map<string, Record<string, number>>): string[] {
  const changes = inputs.flatMap(input => {
    const next = orders.get(input.moduleId)
    if (next === undefined || Object.entries(next).every(([id, value]) => input.saved[id] === value)) return []
    for (const [id, sequence] of Object.entries(next)) input.doc.setIn(['configOrder', id], sequence)
    return [{ ...input, next: input.doc.toString() }]
  })
  // 全部目标在首次写入前校验；同进程请求串行，外部编辑在每次原子替换前再次校验。
  const verify = (change: ModuleOrderInput) => {
    const dir = assertModuleDirectory(root, change.moduleId)
    if (dir !== change.dir || readFileSync(join(dir, MODULE_DEFINITION_FILE), 'utf8') !== change.raw) throw new ModuleConfigOrderError('模块版本已变化，请重新读取排序', true)
  }
  for (const change of changes) verify(change)
  const written: typeof changes = []
  try {
    for (const change of changes) {
      atomicWriteTextFile(join(change.dir, MODULE_DEFINITION_FILE), change.next, { beforeReplace: () => verify(change) })
      invalidateModuleSpec(change.dir)
      written.push(change)
    }
  } catch (error) {
    // 只恢复仍是本次写入字节的文件，不覆盖失败期间出现的外部新改动。
    for (const change of written.reverse()) {
      const file = join(change.dir, MODULE_DEFINITION_FILE)
      if (readFileSync(file, 'utf8') === change.next) {
        atomicWriteTextFile(file, change.raw, { beforeReplace: () => {
          assertModuleDirectory(root, change.moduleId)
          if (readFileSync(file, 'utf8') !== change.next) throw new Error('排序恢复时模块再次变化')
        } })
        invalidateModuleSpec(change.dir)
      }
    }
    throw error
  }
  return changes.map(change => change.moduleId)
}

/** 新卡或与其他启用模块碰号的卡接在尾部；已保存且无冲突的顺序保持。 */
export function appendModuleConfigOrder(root: string, moduleId: string): string[] {
  const others = readInputs(root, enabledModuleIds(root).filter(id => id !== moduleId))
  const input = readInput(root, moduleId)
  const used = new Set(others.flatMap(item => item.entries.map(entry => entry.sequence)))
  let next = -10
  for (const value of used) next = Math.max(next, value)
  for (const value of Object.values(input.saved)) next = Math.max(next, value)
  next += 10
  const assigned: Record<string, number> = Object.create(null)
  const collision = input.entries.some(entry => input.saved[entry.configId] !== undefined && used.has(input.saved[entry.configId]!))
  for (const entry of [...input.entries].sort(compareModuleConfigOrder)) {
    let sequence = input.saved[entry.configId]
    if (collision || sequence === undefined || used.has(sequence)) {
      if (!Number.isSafeInteger(next)) throw new Error('配置卡排序序号超出安全整数范围')
      sequence = next
      next += 10
    }
    used.add(sequence)
    assigned[entry.configId] = sequence
  }
  return writeOrders(root, [input], new Map([[moduleId, assigned]]))
}

/** 默认重排启用集合；指定模块只交换其现有槽位，不接受客户端序号、正文或路径。 */
export function saveModuleConfigOrder(root: string, expectedRevision: string, entries: ModuleConfigIdentity[], moduleId?: string): string[] {
  const inputs = readInputs(root, moduleId === undefined ? undefined : [moduleId])
  const current = snapshotOf(inputs)
  if (expectedRevision !== current.revision) throw new ModuleConfigOrderError('模块版本已变化，请重新读取排序', true)
  if (!Array.isArray(entries) || entries.length !== current.entries.length) throw new ModuleConfigOrderError('排序配置卡集合已变化', true)
  const known = new Set(current.entries.map(configIdentityKey))
  const orders = new Map<string, Record<string, number>>()
  for (const [index, entry] of entries.entries()) {
    if (entry === null || typeof entry !== 'object' || typeof entry.moduleId !== 'string' || typeof entry.configId !== 'string'
      || Object.keys(entry).some(key => key !== 'moduleId' && key !== 'configId') || !known.delete(configIdentityKey(entry))) throw new ModuleConfigOrderError('排序包含未知或重复配置卡')
    let values = orders.get(entry.moduleId)
    if (values === undefined) { values = Object.create(null) as Record<string, number>; orders.set(entry.moduleId, values) }
    values[entry.configId] = moduleId === undefined ? index * 10 : current.entries[index]!.sequence
  }
  return writeOrders(root, inputs, orders)
}
