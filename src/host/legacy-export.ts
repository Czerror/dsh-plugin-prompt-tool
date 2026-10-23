/**
 * 旧合并 / 角色来源登记的导出安全核查（只读）。
 *
 * 合并与角色库入口已删除；这里只服务既有模块的分享前证明：
 * 含旧私有记忆标记、或无法证明来源的 `module-<id>-memory*` 规则一律拒绝导出。
 * 不提供写入、合并、迁移或新的存储位置。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument } from 'yaml'
import { assertModuleDirectory, assertModuleId, assertNoModuleLinks as assertNoLinks, modulePathExists } from './module-install.ts'
import { MODULE_DEFINITION_FILE } from './paths.ts'
import { assertCanonicalRuleSource } from './module-slices.ts'
import type { ModuleSpec } from './module-spec.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadSpecFile(file: string): ModuleSpec | undefined {
  assertNoLinks(file)
  if (!modulePathExists(file)) return undefined
  const parsed = parseYaml(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (!isRecord(parsed)) throw new Error(`模块定义不是对象：${file}`)
  assertCanonicalRuleSource(parsed)
  return parsed as unknown as ModuleSpec
}

function loadModuleSource(root: string, id: string): ModuleSpec | undefined {
  assertModuleId(id)
  const dir = join(root, id)
  assertNoLinks(dir)
  if (!modulePathExists(dir)) return undefined
  return loadSpecFile(join(assertModuleDirectory(root, id), MODULE_DEFINITION_FILE))
}

function importPrefixes(id: string): readonly string[] {
  return [`module-${id}-`]
}

/** 历史合并登记只读解析；旧角色来源标记在这里直接拒绝。 */
function readMergedModules(meta: unknown): Record<string, { active: boolean; capabilities: string[] }> {
  if (!isRecord(meta)) return {}
  if (meta.importedCharacters !== undefined || meta.characterModules !== undefined) throw new Error('旧角色来源登记已退役，请显式转换为原生模块')
  if (isRecord(meta.mergedModules)) return Object.fromEntries(Object.entries(meta.mergedModules).filter(([, value]) =>
    isRecord(value) && typeof value.active === 'boolean' && Array.isArray(value.capabilities)).map(([id, value]) => {
    const row = value as Record<string, unknown>
    return [id, { active: row.active === true, capabilities: (row.capabilities as unknown[]).filter((item): item is string => typeof item === 'string') }]
  }))
  return {}
}

/** 私有记忆归独立文件；无法证明安全的旧定义必须显式转换后才能分享。 */
export function projectCharacterMemories(
  source: ReturnType<typeof parseDocument>,
  _choices: Record<string, 'include' | 'exclude'> = {},
  moduleRoot?: string,
): { doc: ReturnType<typeof parseDocument>; excludedMemoryCount: number; memoryConflicts: Array<{ id: string; name: string }> } {
  const doc = source.clone()
  const spec = doc.toJS() as ModuleSpec
  if (isRecord(spec.meta) && ['characterMemories', 'importedCharacters', 'characterModules'].some(key => Object.hasOwn(spec.meta!, key))) {
    throw new Error('模块含旧私有记忆或角色来源标记；请重新导入或显式转换并核对记忆归属后再导出')
  }
  const imported = Object.keys(readMergedModules(spec.meta))
  assertCanonicalRuleSource(spec)
  for (const config of spec.rules ?? []) {
    if (!isRecord(config) || typeof config.id !== 'string') continue
    const id = config.id
    const cardId = imported.find(card => importPrefixes(card).some(base => id === `${base}memory` || id.startsWith(`${base}memory-`)))
    if (cardId === undefined) continue
    if (moduleRoot !== undefined) {
      assertModuleId(cardId)
      const original = loadModuleSource(moduleRoot, cardId)
      if (original?.rules?.some(entry => importPrefixes(cardId).some(base => `${base}${entry.id}` === id))) continue
    }
    throw new Error(`无法证明规则 ${id} 的旧记忆来源；请显式转换并核对私有内容后再导出`)
  }
  return { doc, excludedMemoryCount: 0, memoryConflicts: [] }
}
