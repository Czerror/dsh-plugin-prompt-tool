/**
 * tool-scope — 工具面的作用域快照，避免各消费方把全局视图当成模型可见面。
 *
 * - global：不带 scope 的 `tools.schemas()`，只有全局层；用于 `restrict` 的已知名与诊断。
 * - visible：带 agent 的 `tools.schemas(agent)`，包含预设/祖先/本层工具；模型真正能看到的范围。
 * - scoped：visible 中不在 global 的名字，即由 agent/祖先层补充的工具。
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
  return {
    global,
    visible,
    globalNames,
    scoped: visible.filter((schema) => !globalNames.has(schema?.name)),
  }
}
