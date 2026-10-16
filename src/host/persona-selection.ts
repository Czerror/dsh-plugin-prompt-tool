/** 部署只保存主/子的人设模块身份，正文始终读取对应 module.yml。 */
import { readdirSync } from 'node:fs'
import { isMap } from 'yaml'
import type { PersonaAudience, PersonaSources, PersonaSourcesSnapshot, PersonaSpec } from '../shared/persona-section.ts'
import { readPersonaSpec } from '../shared/persona-section.ts'
import { assertModuleDirectory, assertModuleId, assertNoModuleLinks, modulePathExists } from './module-install.ts'
import { ensureModuleSlices, loadModuleDefinition } from './module-slices.ts'
import { ModuleWriteError } from './module-write.ts'
import { readStorageConfig, updateStorageConfig } from './config-store.ts'

const AUDIENCES: PersonaAudience[] = ['main', 'subagent']
function sourcesOf(raw: unknown, requireBoth = false): PersonaSources {
  if (raw === undefined && !requireBoth) return { main: null, subagent: null }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(key => !AUDIENCES.includes(key as PersonaAudience))) throw new ModuleWriteError('personaSources 只接受 main/subagent 对象')
  const source = raw as Record<string, unknown>, result: PersonaSources = { main: null, subagent: null }
  for (const audience of AUDIENCES) {
    const id = source[audience]
    if (requireBoth && (!Object.hasOwn(source, audience) || id === undefined)) throw new ModuleWriteError('人设来源写入必须同时声明 main/subagent，null 表示官方')
    if (id === null || id === undefined) continue
    assertModuleId(id)
    result[audience] = id
  }
  return result
}

export function readPersonaSources(root: string): PersonaSourcesSnapshot {
  const config = readStorageConfig(root)
  const sources = sourcesOf(config.source.personaSources)
  const candidates: PersonaSourcesSnapshot['candidates'] = []
  assertNoModuleLinks(root)
  if (modulePathExists(root)) for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    try {
      const definition = loadModuleDefinition(assertModuleDirectory(root, entry.name))
      readPersonaSpec(definition.source.persona)
      candidates.push({ id: entry.name, name: typeof definition.source.name === 'string' && definition.source.name ? definition.source.name : entry.name })
    } catch { /* 非法模块不成为可选择来源；已选失效来源由配装读取明确拒绝。 */ }
  }
  candidates.sort((a, b) => a.id.localeCompare(b.id))
  return { sources, revision: config.revision, candidates }
}

export function selectedPersonaModules(root: string, sources?: PersonaSources): Array<{ moduleId: string; persona: PersonaSpec; variablesEnabled: boolean }> {
  const selection = sourcesOf(sources ?? readStorageConfig(root).source.personaSources, sources !== undefined)
  const selected = new Map<string, { moduleId: string; persona: PersonaSpec; variablesEnabled: boolean }>()
  for (const audience of AUDIENCES) {
    const id = selection[audience]
    if (id === null) continue
    assertNoModuleLinks(root)
    const definition = ensureModuleSlices(assertModuleDirectory(root, id))
    const persona = readPersonaSpec(definition.source.persona)
    const entry = selected.get(id) ?? { moduleId: id, persona: {}, variablesEnabled: definition.variablesEnabled }
    if (persona?.[audience] !== undefined) entry.persona[audience] = persona[audience]
    selected.set(id, entry)
  }
  return [...selected.values()]
}

export function writePersonaSources(root: string, sources: PersonaSources, expectedRevision: string | null): PersonaSourcesSnapshot {
  const selection = sourcesOf(sources, true)
  if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) throw new ModuleWriteError('人设来源写入必须提供有效 expectedRevision')
  updateStorageConfig(root, expectedRevision, (doc, source) => {
    selectedPersonaModules(root, selection)
    const value = Object.fromEntries(AUDIENCES.filter(audience => selection[audience] !== null).map(audience => [audience, selection[audience]]))
    const expected = { ...source }
    if (Object.keys(value).length === 0) { doc.delete('personaSources'); delete expected.personaSources }
    else {
      expected.personaSources = value
      const node = doc.get('personaSources', true)
      if (!isMap(node)) doc.set('personaSources', value)
      else for (const audience of AUDIENCES) {
        if (selection[audience] === null) node.delete(audience)
        else node.set(audience, selection[audience])
      }
    }
    return expected
  })
  return { ...readPersonaSources(root), persisted: true }
}
