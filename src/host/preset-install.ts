import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'

export function assertPresetId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new Error(`非法预设 id：${String(id)}；必须为小写字母、数字和连字符`)
  }
}

/** 修改目录身份时，只改指向该预设自身的结构化文件引用，正文不替换。 */
export function setPresetDefinitionId(doc: ReturnType<typeof parseDocument>, id: string): void {
  assertPresetId(id)
  const previous = doc.get('id')
  if (previous === id) return
  const configs = doc.get('promptConfigs', true)
  if (typeof previous === 'string' && configs instanceof YAMLSeq) for (const config of configs.items) {
    if (!(config instanceof YAMLMap)) continue
    const path = config.get('templateFile')
    const prefix = `../${previous}/`
    if (typeof path === 'string' && path.startsWith(prefix)) config.set('templateFile', `../${id}/${path.slice(prefix.length)}`)
  }
  doc.set('id', id)
}

/** ENOENT 才表示不存在；权限、占用与读取失败继续传播。 */
export function presetPathExists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function canonicalPresetRoot(root: string, allowMissing = false): string {
  const absoluteRoot = resolve(root)
  if (!presetPathExists(absoluteRoot)) {
    if (allowMissing) return absoluteRoot
    throw new Error(`预设根不存在：${absoluteRoot}`)
  }
  const rootStat = lstatSync(absoluteRoot)
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`预设根不是普通目录：${absoluteRoot}`)
  return realpathSync(absoluteRoot)
}

/** 根与目标先解析真实路径，拒绝链接目录及定义身份不一致。 */
export function assertPresetDirectory(root: string, id: string, allowMissing = false): string {
  assertPresetId(id)
  const canonicalRoot = canonicalPresetRoot(root, allowMissing)
  const target = join(canonicalRoot, id)
  if (!presetPathExists(target)) {
    if (allowMissing) return target
    throw new Error(`预设 ${id} 不存在`)
  }
  const stat = lstatSync(target)
  if (stat.isSymbolicLink() || !stat.isDirectory() || dirname(realpathSync(target)) !== canonicalRoot) {
    throw new Error(`预设路径包含链接或越界：${id}`)
  }
  // Windows 的文件查找不区分大小写，宿主发现规则区分大小写。
  if (!readdirSync(canonicalRoot).includes(id)) throw new Error(`预设目录身份不匹配：${id}`)
  const definition = join(target, 'preset.yml')
  const fileStat = lstatSync(definition)
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) throw new Error(`预设定义不是普通文件：${id}`)
  const doc = parseDocument(readFileSync(definition, 'utf8'), { logLevel: 'silent' })
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error(`预设定义无效：${id}`)
  const declared = doc.get('id')
  if (declared !== undefined && declared !== id) throw new Error(`预设定义身份不匹配：${id}`)
  return target
}

/** 复制和物化只接受自有普通文件；不跟随任意层级链接读取根外数据。 */
export function assertPresetTree(dir: string): void {
  const stat = lstatSync(dir)
  if (stat.isSymbolicLink()) throw new Error(`预设包含链接：${dir}`)
  if (stat.isDirectory()) {
    for (const entry of readdirSync(dir)) assertPresetTree(join(dir, entry))
  } else if (!stat.isFile()) throw new Error(`预设包含特殊文件：${dir}`)
}

/** 仅处理 Cordis 行的已知共享引擎引用和受管配置位置，正文与自有引擎保持不变。 */
export function rewritePresetEngineReferences(raw: string, outputId: string, engineFiles: ReadonlySet<string>, sourceDir?: string): string {
  const doc = parseDocument(raw, { logLevel: 'silent' })
  if (doc.errors.length > 0 || !(doc.contents instanceof YAMLSeq)) throw new Error('组合必须是合法 YAML 数组')
  let changed = false
  const visitRows = (rows: YAMLSeq): void => {
    for (const row of rows.items) {
      if (!(row instanceof YAMLMap)) continue
      const name = row.get('name')
      const match = typeof name === 'string' ? /^(\.\/engine\/|\.\.\/\.engine\/)([^/]+\.mjs)$/.exec(name) : null
      if (match !== null && engineFiles.has(match[2]!)
        && (match[1] === '../.engine/' || sourceDir === undefined || !presetPathExists(join(sourceDir, 'engine', match[2]!)))) {
        if (match[1] === './engine/') { row.set('name', `../.engine/${match[2]}`); changed = true }
        const config = row.get('config', true)
        if (config instanceof YAMLMap) {
          const field = match[2] === 'subagent-tool-policy.mjs' ? 'policyFile' : 'configsDir'
          const directory = match[2] === 'prompt-config-engine.mjs' ? 'prompt-configs'
            : match[2] === 'tool-config-engine.mjs' ? 'custom-tools'
              : match[2] === 'subagent-tool-policy.mjs' ? 'subagent-tools/policy.yml' : undefined
          const value = config.get(field)
          if (directory !== undefined && typeof value === 'string'
            && (value === `../${directory}` || new RegExp(`^\\.\\./[a-z0-9][a-z0-9-]*/${directory.replaceAll('.', '\\.')}\\/?$`).test(value))) {
            const next = `../${outputId}/${directory}`
            if (value !== next) { config.set(field, next); changed = true }
          }
        }
      }
      const children = row.get('config', true)
      if (row.get('name') === 'cordis:group' && children instanceof YAMLSeq) visitRows(children)
    }
  }
  visitRows(doc.contents)
  return changed ? doc.toString() : raw
}
