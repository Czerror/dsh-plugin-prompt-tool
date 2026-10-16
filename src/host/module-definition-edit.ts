/**
 * module.yml 的写入事务：共享能力参数（`saveModuleParams`）、人设段
 * （`readModulePersona` / `saveModulePersona`）与通用读-改-写入口（`withModuleDefinition`）。
 * 从原 `manifest.ts` 按簇拆出；三者共用同一条提交与缓存失效纪律。
 */
import { join } from 'node:path'
import { YAMLMap, parseDocument } from 'yaml'
import { readPersonaSpec } from '../shared/persona-section.ts'
import type { PersonaSnapshot, PersonaSpec } from '../shared/persona-section.ts'
import { engineParamPath, readModuleLayerSettings } from './module-layer-settings.ts'
import { ModuleRulesError, assertCanonicalRuleSource, commitModuleDefinition, deleteYamlPath, loadModuleDefinition, serializeWithoutSharedAlias, withModuleDefinition as commitDefinitionEdit } from './module-storage.ts'
import { assertModuleDirectory } from './module-install.ts'
import { invalidateModuleSpec } from './module-spec.ts'

/** 保存共享能力参数；规则与持久变量分别通过各自的版本事务提交。
 * parseDocument 保留注释与未知键（module.yml 模板含大量注释）；空值键删除（'' / []，
 * 回落模板/引擎默认；0 与 false 照常写入——语义与函数内注释、docs §3 一致）。
 */
export function saveModuleParams(
  moduleRoot: string,
  templateName: string,
  params: Record<string, unknown> | undefined,
  promptConfigs: unknown[] | undefined,
): void {
  const snapshot = loadModuleDefinition(assertModuleDirectory(moduleRoot, templateName))
  const doc = snapshot.doc
  readModuleLayerSettings(doc.toJS())
  assertCanonicalRuleSource(doc.toJS())
  if (promptConfigs !== undefined) throw new Error('promptConfigs 写入已退出；请使用 rules 局部事务')
  // 空值 = 删除键（回落模板/引擎默认）：''（字符串清空）、[]（列表清空）。
  // 其余 0/false 照常写入——数值 0 是合法档位，不能当空值吞掉。
  if (params !== undefined) {
    for (const [key, value] of Object.entries(params)) {
      // 仅跳过 undefined/null 与空 key 名；空串/空数组照常写入——
      // 「从有值改回留空」依赖空值清掉旧键（渲染层空值跳过 = 继承模板/宿主默认）。
      if (value === undefined || value === null || key.trim().length === 0) continue
      const isEmpty = value === '' || (Array.isArray(value) && value.length === 0)
      const path = engineParamPath(key)
      if (isEmpty) deleteYamlPath(doc, path)
      else doc.setIn(path, value)
    }
  }
  commitModuleDefinition(snapshot, doc)
  invalidateModuleSpec(join(moduleRoot, templateName))
}

export function readModulePersona(moduleDir: string): PersonaSnapshot {
  const snapshot = loadModuleDefinition(moduleDir)
  return { persona: readPersonaSpec(snapshot.source.persona) ?? null, revision: snapshot.revision }
}
/** 人设与模块共用唯一写盘事务；空串/false 保留，删段恢复继承。 */
export function saveModulePersona(moduleRoot: string, templateName: string, persona: PersonaSpec | null, expectedRevision: string): PersonaSnapshot {
  const snapshot = loadModuleDefinition(assertModuleDirectory(moduleRoot, templateName))
  if (typeof expectedRevision !== 'string' || expectedRevision !== snapshot.revision) {
    throw new ModuleRulesError('模块已更新，请重新读取人设后再保存', 409, 'module-persona-conflict')
  }
  const parsed = persona === null ? null : readPersonaSpec(persona)
  if (parsed === undefined) throw new TypeError('persona 必须是对象或 null')
  const doc = snapshot.doc
  readModuleLayerSettings(doc.toJS())
  const expected = { ...snapshot.source }
  if (parsed === null || Object.keys(parsed).length === 0) {
    doc.delete('persona')
    delete expected.persona
  } else {
    expected.persona = parsed
    const section = doc.get('persona', true)
    if (!(section instanceof YAMLMap)) doc.set('persona', parsed)
    else for (const audience of ['main', 'subagent'] as const) {
      const fields = parsed[audience]
      if (fields === undefined) { section.delete(audience); continue }
      const target = section.get(audience, true)
      if (!(target instanceof YAMLMap)) section.set(audience, fields)
      else {
        for (const key of target.items.map(pair => String(pair.key))) if (!Object.hasOwn(fields, key)) target.delete(key)
        for (const [key, value] of Object.entries(fields)) target.set(key, value)
      }
    }
  }
  const next = serializeWithoutSharedAlias(doc, expected, 'YAML 共享引用会改变其他定义；请先解除相关引用后再编辑人设')
  const committed = commitModuleDefinition(snapshot, next)
  invalidateModuleSpec(join(moduleRoot, templateName))
  return { persona: readPersonaSpec(committed.source.persona) ?? null, revision: committed.revision }
}

/** 模块文件读-改-写（parseDocument 保留注释与未知键；mutate 内 setIn/deleteIn）。
 *  模块并入与模块管理共用此入口，避免
 *  各自实现 parseDocument 往返。写盘走原子替换，失败保留旧文件。
 *  `owns` 必填且含义见 `module-storage.ts#SHARED_ALIAS_CODE`：mutate 只许碰这些顶层键。 */
export function withModuleDefinition(
  moduleDir: string,
  mutate: (doc: ReturnType<typeof parseDocument>, source: Record<string, unknown>) => void,
  options: { owns: readonly string[] },
): ReturnType<typeof commitDefinitionEdit> {
  const committed = commitDefinitionEdit(moduleDir, (doc, source) => {
    readModuleLayerSettings(doc.toJS())
    mutate(doc, source)
    readModuleLayerSettings(doc.toJS())
  }, options)
  invalidateModuleSpec(moduleDir)
  return committed
}