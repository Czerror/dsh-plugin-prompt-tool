/** 自定义工具物化定义的纯校验：host 保存/物化与运行时共用，不加载宿主服务。 */

const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/
const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'])
const JSON_SCHEMA_ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])

/** JSON Schema 结构校验；DSL 转换与官方 registry 仍负责 enforced subset 校验。 */
export function validateJsonSchemaNode(node, path, seen = new Set()) {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) {
    throw new TypeError(`${path} must be an object`)
  }
  if (seen.has(node)) throw new TypeError(`${path} is circular`)
  seen.add(node)
  try {
    if (node.type !== undefined) {
      if (!JSON_SCHEMA_TYPES.has(node.type)) {
        throw new TypeError(`${path}.type must be one of ${[...JSON_SCHEMA_TYPES].join('/')} (dsh-tools DSL 形态 'json'/'oneOf' 未在物化时转换)`)
      }
      if (node.type === 'object') {
        if (node.properties !== undefined) {
          if (node.properties === null || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
            throw new TypeError(`${path}.properties must be an object of schemas`)
          }
          for (const [key, child] of Object.entries(node.properties)) {
            validateJsonSchemaNode(child, `${path}.properties.${key}`, seen)
          }
        }
        if (node.required !== undefined) {
          if (!Array.isArray(node.required) || node.required.some((item) => typeof item !== 'string')) {
            throw new TypeError(`${path}.required must be an array of property names`)
          }
        }
        if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') {
          throw new TypeError(`${path}.additionalProperties must be a boolean`)
        }
      }
      if (node.type === 'array' && node.items !== undefined) {
        validateJsonSchemaNode(node.items, `${path}.items`, seen)
      }
    } else if (Array.isArray(node.oneOf)) {
      if (node.oneOf.length < 2) throw new TypeError(`${path}.oneOf needs at least two branches`)
      for (const [index, branch] of node.oneOf.entries()) {
        validateJsonSchemaNode(branch, `${path}.oneOf[${index}]`, seen)
      }
    } else if (!Object.keys(node).every((key) => JSON_SCHEMA_ANNOTATIONS.has(key))) {
      // 官方 DSL type: json 物化为 {} 或仅含 annotation 的节点；不能误判为未转换的 DSL。
      throw new TypeError(`${path} must declare type or oneOf (or contain annotations only)`)
    }
  } finally {
    seen.delete(node)
  }
}

/** 完整定义校验；保存方拒绝写盘，writer / runtime 按单条告警跳过。 */
export function validateDefinition(def) {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) throw new TypeError('tool definition must be an object')
  if (typeof def.id !== 'string' || def.id.trim().length === 0) throw new TypeError('tool definition needs a non-empty string id')
  if (typeof def.name !== 'string' || !TOOL_NAME_RE.test(def.name)) {
    throw new TypeError(`tool name ${JSON.stringify(def.name)} must match ${TOOL_NAME_RE}`)
  }
  if (typeof def.description !== 'string' || def.description.trim().length === 0) {
    throw new TypeError(`tool ${def.id}: description is required`)
  }
  if (def.scope !== undefined) {
    throw new TypeError(`tool ${def.id}: customTools.scope is not supported (subagent tool policy is configured via subagentToolPolicy, not per-tool scope)`)
  }
  if (def.parameters !== undefined) {
    validateJsonSchemaNode(def.parameters, `tool ${def.id}: parameters`)
  }
  const output = def.output
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError(`tool ${def.id}: output is required`)
  }
  validateJsonSchemaNode(output.schema, `tool ${def.id}: output.schema`)
  const exec = def.execute
  if (exec === null || typeof exec !== 'object' || Array.isArray(exec)) {
    throw new TypeError(`tool ${def.id}: execute is required`)
  }
  if (typeof exec.kind !== 'string' || !['shell', 'http', 'delegate', 'fs', 'ask-user'].includes(exec.kind)) {
    throw new TypeError(`tool ${def.id}: execute.kind must be shell/http/delegate/fs/ask-user`)
  }
  if (exec.kind === 'shell' && (typeof exec.command !== 'string' || exec.command.trim().length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.command is required for shell`)
  }
  if (exec.kind === 'http' && (typeof exec.url !== 'string' || exec.url.trim().length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.url is required for http`)
  }
  if (exec.kind === 'delegate' && (typeof exec.tool !== 'string' || exec.tool.length === 0)) {
    throw new TypeError(`tool ${def.id}: execute.tool is required for delegate`)
  }
  if (exec.kind === 'fs' && (typeof exec.action !== 'string'
    || (!['read', 'write', 'append', 'list', 'delete'].includes(exec.action) && !exec.action.includes('{{args.')))) {
    throw new TypeError(`tool ${def.id}: execute.action must be read/write/append/list/delete (or {{args.*}} template) for fs`)
  }
  if (def.enabled !== undefined && typeof def.enabled !== 'boolean') {
    throw new TypeError(`tool ${def.id}: enabled must be a boolean`)
  }
  // 与 Node 定时器的有符号 32 位上限一致，避免溢出后变成 1 ms。
  if (def.timeoutMs !== undefined && (!Number.isSafeInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 2_147_483_647)) {
    throw new TypeError(`tool ${def.id}: timeoutMs must be an integer from 1 to 2147483647`)
  }
  for (const field of ['command', 'shell', 'url', 'method', 'tool', 'action', 'path', 'content', 'question']) {
    if (exec[field] !== undefined && typeof exec[field] !== 'string') {
      throw new TypeError(`tool ${def.id}: execute.${field} must be a string`)
    }
  }
  if (exec.shell !== undefined && (exec.shell.trim().length === 0 || exec.shell.includes('\0'))) {
    throw new TypeError(`tool ${def.id}: execute.shell must be a non-empty executable name or path without NUL`)
  }
  if (exec.method !== undefined && !/^\{\{args\.[A-Za-z0-9_.]+\}\}$/.test(exec.method) && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(exec.method)
    || ['CONNECT', 'TRACE', 'TRACK'].includes(exec.method.toUpperCase()))) {
    throw new TypeError(`tool ${def.id}: execute.method must be a supported HTTP method token`)
  }
  if (exec.kind === 'fs' && (typeof exec.path !== 'string' || exec.path.includes('\0'))) {
    throw new TypeError(`tool ${def.id}: execute.path must be a string without NUL for fs`)
  }
  for (const field of ['env', 'headers', 'args']) {
    const value = exec[field]
    if (value === undefined) continue
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(`tool ${def.id}: execute.${field} must be an object`)
    }
    if (field !== 'args' && Object.values(value).some((entry) => typeof entry !== 'string')) {
      throw new TypeError(`tool ${def.id}: execute.${field} values must be strings`)
    }
    if (field === 'env' && Object.entries(value).some(([key, entry]) => key.length === 0 || /[=\0]/.test(key) || entry.includes('\0'))) {
      throw new TypeError(`tool ${def.id}: execute.env must contain valid environment names and values`)
    }
    if (field === 'headers') {
      try { new Headers(value) } catch {
        throw new TypeError(`tool ${def.id}: execute.headers must contain valid HTTP names and values`)
      }
    }
  }
  // 单条上限覆盖命令、文件内容及嵌套 body/args/schema；不丢弃模板未知字段。
  let serialized
  try { serialized = JSON.stringify(def) } catch {
    throw new TypeError(`tool ${def.id}: definition must be JSON serializable`)
  }
  if (Buffer.byteLength(serialized, 'utf8') > 1_048_576) {
    throw new TypeError(`tool ${def.id}: definition must not exceed 1048576 UTF-8 bytes`)
  }
}
