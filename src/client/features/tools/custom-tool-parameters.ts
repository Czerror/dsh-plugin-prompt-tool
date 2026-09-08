/** 行编辑只改指定字段；高级 Schema 和模板未知字段保持原样。 */
export function patchToolParameter(
  spec: Record<string, unknown>,
  patch: { type?: string; required?: boolean; description?: string },
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...spec, ...patch }
  if (patch.type !== undefined) {
    const currentType = spec.type ?? (Array.isArray(spec.oneOf) ? 'oneOf' : undefined)
    if (currentType !== patch.type) {
      // 用户明确切换类型时移除旧类型约束；改名称/描述/必填不走此分支。
      for (const key of ['properties', 'additionalProperties', 'items', 'oneOf', 'enum', 'const']) delete next[key]
    }
    if (patch.type === 'object') next.additionalProperties ??= true
    if (patch.type === 'array') next.items ??= { type: 'json' }
    if (patch.type === 'oneOf') {
      delete next.type
      next.oneOf ??= [{ type: 'string' }, { type: 'number' }]
    }
  }
  return next
}
