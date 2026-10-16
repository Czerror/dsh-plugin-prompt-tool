/**
 * 组合文本装配：模块清单 → 组合文本（`modules:` 按序装配 / `composition:` 内联或文件），
 * 以及参数桥产物在组合行上的落位（`applyModuleConfigs` 行级 config 合并）。
 * 从原 `manifest.ts` 按簇拆出；文本层不解析参数、不读运行时。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { Pair, Scalar, YAMLMap, YAMLSeq, parse as parseYaml, parseDocument } from 'yaml'
import { impliedModulesForParams } from '../shared/engine-capabilities.ts'
import { packageEngineDir } from './module-dirs.ts'
import type { ModuleSpec } from './module-spec.ts'

/**
 * 组合模块目录：本项目自有模块的唯一源是 `source/local/`。官方切块已随「与预设彻底解耦」
 * 全部清理——官方工具由会话原有预设提供，模块不需要也不应该重新声明它们。
 */
export function compositionModuleDirs(): string[] {
  return [join(packageEngineDir(), 'compositions', 'source', 'local')]
}

function assertBareModuleName(name: string): void {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..' || name.includes('..')) {
    throw new Error(`composition module name ${JSON.stringify(name)} must be a bare library name`)
  }
}

export function moduleFile(name: string): string {
  assertBareModuleName(name)
  const file = join(compositionModuleDirs()[0]!, `${name}.yml`)
  if (!existsSync(file)) throw new Error(`composition module ${name} not found in source/local`)
  return file
}

function assembleModules(spec: ModuleSpec): string {
  const parts: string[] = []
  const seen = new Set<string>()
  for (const name of spec.modules ?? []) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`module ${spec.id}: modules must be non-empty strings`)
    }
    if (seen.has(name)) {
      throw new Error(`module ${spec.id}: duplicate composition module ${JSON.stringify(name)}`)
    }
    seen.add(name)
    // 模块名 containment：只允许裸库名（禁路径分隔符 / .. / 点目录）。
    try {
      parts.push(readFileSync(moduleFile(name), 'utf8'))
    } catch (error) {
      throw new Error(`module ${spec.id}: ${String((error as Error).message ?? error)}`)
    }
  }
  return parts.length > 0 ? parts.join('\n') : '[]\n'
}
/**
 * 行级 config 合并:仅支持 map 型 config 浅合并;
 * 数组型 config(如 delegation 组)按子行 id 嵌套合并;未声明模块原样保留。
 * 未声明 configs 时返回原文(零开销);parseDocument 往返保留注释。
 * 本函数是参数桥产物落位组合行的唯一机制(含 delegation 组子行嵌套),不是模块覆盖通道。
 */
export function applyModuleConfigs(raw: string, configs: Record<string, Record<string, unknown>> | undefined): string {
  if (configs === undefined || Object.keys(configs).length === 0) return raw
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (!(doc.contents instanceof YAMLSeq)) return raw
  const rows = doc.contents
  let changed = false
  /** 把 cfg 的键写入一个 config 节点（无 config 时创建）。 */
  const mergeInto = (item: YAMLMap, cfg: Record<string, unknown>): boolean => {
    const existingConfig = item.get('config', true)
    let configNode: YAMLMap
    if (existingConfig instanceof YAMLMap) {
      configNode = existingConfig
    } else if (existingConfig === null || existingConfig === undefined) {
      configNode = new YAMLMap()
      // Parsed 行节点的 set 约束 key/value 为 ParsedNode；新建节点运行时合法，
      // 类型断言绕过 Parsed 泛型（构造节点无 range 元数据）。
      item.items.push(new Pair(new Scalar('config'), configNode) as never)
    } else {
      return false
    }
    for (const [key, value] of Object.entries(cfg)) {
      if (value === undefined) configNode.delete(key)
      else configNode.set(key, value)
    }
    return true
  }
  /** 从行节点读 id（ParsedNode 值包装兼容）。 */
  const rowId = (item: YAMLMap): string | undefined => {
    const idNode = item.get('id', true)
    return idNode !== null && typeof idNode === 'object' && 'value' in idNode
      ? String((idNode as { value: unknown }).value)
      : undefined
  }
  for (const item of rows.items) {
    if (!(item instanceof YAMLMap)) continue
    const id = rowId(item)
    const existingConfig = item.get('config', true)
    if (existingConfig instanceof YAMLSeq && id !== undefined && !Object.prototype.hasOwnProperty.call(configs, id)) {
      // 数组型 config（delegation 组）：按子行 id 嵌套合并。
      for (const child of existingConfig.items) {
        if (!(child instanceof YAMLMap)) continue
        const childId = rowId(child)
        if (childId === undefined || !Object.prototype.hasOwnProperty.call(configs, childId)) continue
        if (mergeInto(child, configs[childId]!)) changed = true
      }
      continue
    }
    if (id === undefined || !Object.prototype.hasOwnProperty.call(configs, id)) continue
    if (mergeInto(item, configs[id]!)) changed = true
  }
  return changed ? doc.toString() : raw
}
/**
 * 加载模块声明的组合(原始 token 文本,未渲染)。
 *  - `modules:` 清单 → 引擎模块库按序装配;
 *  - `composition: ./xxx.yml` → 模块模板目录内组合文件(官方预设直用);
 *  - `composition:` 内联文本或组合清单名。
 *
 * **纯文本装配，params 由调用方传入**：本函数不解析参数、不读运行时——隐含能力模块的补齐
 * 需要「参数桥那层的声明」时，由调用方算好传进来。这条入参边界是模块拆分的前提：文本簇
 * 因此不依赖参数/事实簇（见 docs/ui-architecture.md 的组合渲染链路）。
 */
export function loadCompositionText(spec: ModuleSpec, params: Record<string, unknown>, templateDir?: string): string {
  let raw: string
  let modules = spec.modules
  if (Array.isArray(modules)) {
    const declared: string[] = modules
    // 参数在 ⇒ 装配在：显式 params/moduleConfigs 隐含的能力模块自动补齐。
    const extra = [
      ...impliedModulesForParams(params, spec.moduleConfigs),
      ...((spec.rules?.length ?? 0) > 0 ? ['rule-engine'] : []),
    ].filter((module) => !declared.includes(module))
    if (extra.length > 0) modules = [...declared, ...extra]
  }
  if (Array.isArray(modules)) raw = assembleModules({ ...spec, modules })
  else {
    const name = typeof spec.composition === 'string' ? spec.composition : ''
    if (name.includes('\n')) raw = name
    else if (name.startsWith('./')) {
      if (templateDir === undefined) {
        throw new Error(`module ${spec.id}: composition relative path needs a templateDir (${JSON.stringify(name)})`)
      }
      // containment：解析后的组合文件必须仍位于模板目录内（防 ../../ 越界读取）。
      const file = join(templateDir, name.slice(2))
      const rootResolved = resolve(templateDir)
      const fileResolved = resolve(file)
      if (fileResolved !== rootResolved && !fileResolved.startsWith(rootResolved + sep)) {
        throw new Error(`module ${spec.id}: composition path escapes template dir (${JSON.stringify(name)})`)
      }
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        throw new Error(`module ${spec.id}: composition file not found (${file}): ${String((error as Error).message ?? error)}`)
      }
    }
    else if (name.length > 0) {
      try {
        raw = readFileSync(moduleFile(name), 'utf8')
      } catch (error) {
        throw new Error(`module ${spec.id}: ${String((error as Error).message ?? error)}`)
      }
    } else {
      throw new Error(`module ${spec.id}: no modules list and no composition declared`)
    }
  }
  return raw
}
/** 组合文本基础校验（模板无关）：无未解析 token，且必须是 YAML 数组。 */
export function assertCompositionArray(raw: string, spec: ModuleSpec): unknown[] {
  const unresolved = raw.match(/__[A-Za-z0-9_]+__/g)
  if (unresolved !== null) throw new Error(`generated agent.cordis.yml has unresolved variables: ${unresolved.join(', ')}`)
  const parsed = parseYaml(raw, { logLevel: 'silent' })
  if (!Array.isArray(parsed)) throw new Error(`generated agent.cordis.yml is not a YAML array (module ${spec.id})`)
  return parsed
}