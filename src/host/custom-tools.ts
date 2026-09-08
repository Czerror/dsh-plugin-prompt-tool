/** 自定义工具的保存校验与物化：只编译定义，不注册或执行工具，不修改输入。 */
import { parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
// @ts-expect-error 仓库根 ESM 引擎文件由 tsdown 作为源码依赖打包，无独立声明文件。
import { validateDefinition } from '../../engine/tool-definition.mjs'
import { validateCustomToolIdentities } from '../shared/engine-capabilities.ts'
import { assertSafeConfigId } from './prompt-configs.ts'

/** 官方 DSL → 运行时 JSON Schema；非法字段抛错，id 必填，空 name 回落 id。 */
export function compileCustomTool(tool: Record<string, unknown>): Record<string, unknown> {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
    throw new TypeError('custom tool must be an object')
  }
  const id = typeof tool.id === 'string' ? tool.id.trim() : ''
  assertSafeConfigId(id)
  const name = typeof tool.name === 'string' ? tool.name.trim() || id : tool.name === undefined ? id : tool.name
  const next: Record<string, unknown> = { ...tool, id, name }
  if (tool.parameters !== undefined) {
    try {
      next.parameters = parameterSchemaSpecToJsonSchema(tool.parameters as never)
    } catch (error) {
      throw new TypeError(`parameters: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const output = tool.output
  if (output === null || typeof output !== 'object' || Array.isArray(output)) {
    throw new TypeError('output.schema is required')
  }
  const outputRecord = output as Record<string, unknown>
  try {
    next.output = { ...outputRecord, schema: valueSchemaSpecToJsonSchema(outputRecord.schema as never) }
  } catch (error) {
    throw new TypeError(`output.schema: ${error instanceof Error ? error.message : String(error)}`)
  }
  validateDefinition(next)
  return next
}

/** 先拒绝非法/重复身份，再完整编译每条定义（包括停用条目），供 bridge 写盘前调用。 */
export function validateCustomTools(tools: readonly unknown[]): string[] {
  const errors = validateCustomToolIdentities(tools)
  if (errors.length > 0) return errors
  for (const [index, tool] of tools.entries()) {
    try {
      compileCustomTool(tool as Record<string, unknown>)
    } catch (error) {
      errors.push(`customTools[${index}]: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return errors
}
