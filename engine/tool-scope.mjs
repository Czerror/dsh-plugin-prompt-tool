/**
 * tool-scope — 工具面的作用域快照，避免各消费方把全局视图当成模型可见面。
 *
 * 返回两个字段，各自只服务一个调用方：
 * - visible：带 agent 的 `tools.schemas(agent)`，包含预设/祖先/本层工具；模型可见面。
 * - globalNames：不带 scope 的 `tools.schemas()` 名字集合；只供 `restrict` 过滤已知名。
 *
 * 全局原始 schema 与 visible-only 差集不外露；等真实诊断消费方出现再加字段。
 */

const schemaList = (tools, scope) => {
  if (typeof tools?.schemas !== 'function') return []
  const schemas = tools.schemas(scope)
  return Array.isArray(schemas) ? schemas : []
}

export function toolScopeSnapshot(tools, agent) {
  const global = schemaList(tools)
  const visible = agent === undefined ? global : schemaList(tools, agent)
  const globalNames = new Set(global.map((schema) => schema?.name).filter((name) => typeof name === 'string'))
  return { visible, globalNames }
}
