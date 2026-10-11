/** 模块变量工具只调用持久变量所有者；内容更新不重装 Agent。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { editModuleVariables, readModuleVariables } from '../host/module-variables.ts'
import type { ModuleVariableRevisions, ModuleVariablesResult } from '../host/module-variables.ts'
import { assertVariableValues, ModuleRulesError } from '../host/module-storage.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'

export function registerModuleVariableTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.variables,
    description: '读写跨会话持久变量：scope=module 使用 moduleId 声明的模块并回落全局，scope=global 影响同一 DSH_HOME 的所有模块。list/get 返回有效来源和版本；set 必须显式 value，空字符串保留；delete 只删目标范围的键，模块删除后回落全局。写入带读取时的 expectedRevisions；不使用会话内变量表。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      scope: { type: 'string', enum: ['global', 'module'], required: true },
      action: { type: 'string', enum: ['list', 'get', 'set', 'delete'], required: true },
      key: { type: 'string' }, value: { type: 'string' },
      expectedRevisions: { type: 'object', additionalProperties: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          moduleId: { type: 'string', required: true }, scope: { type: 'string', enum: ['global', 'module'], required: true },
          revisions: { type: 'object', additionalProperties: false, required: true, properties: {
            global: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, module: { type: 'string', required: true }, settings: { type: 'string', required: true },
          } },
          enabled: { type: 'boolean', required: true },
          variables: { type: 'object', additionalProperties: true }, sources: { type: 'object', additionalProperties: true },
          key: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          source: { oneOf: [{ type: 'string', enum: ['global', 'module'] }, { type: 'null' }] },
          persisted: { type: 'boolean' }, publicationPending: { type: 'boolean' }, publicationError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'scope', 'action', 'key', 'value', 'expectedRevisions'].includes(key))) throw new ModuleRulesError('变量工具含未知字段')
      const writing = args.action === 'set' || args.action === 'delete'
      if (args.action === 'list' && args.key !== undefined || args.action !== 'set' && args.value !== undefined) throw new ModuleRulesError('该变量操作不接受 key 或 value')
      if (!writing && args.expectedRevisions !== undefined) throw new ModuleRulesError('读取变量不接受写入版本')
      if (args.action !== 'list') {
        if (typeof args.key !== 'string') throw new ModuleRulesError('变量操作需要 key')
        assertVariableValues({ [args.key]: '' })
      }
      if (args.action === 'set' && typeof args.value !== 'string') throw new ModuleRulesError('set 必须显式提供字符串 value；空串是有效值')
      if (writing && args.expectedRevisions === undefined) throw new ModuleRulesError('写变量必须提供 expectedRevisions')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId)
      let saved: ModuleVariablesResult | undefined
      const state = writing ? (saved = editModuleVariables(target.dir, {
        scope: args.scope, changes: { [args.key!]: args.action === 'delete' ? null : args.value! },
        expectedRevisions: args.expectedRevisions as Partial<ModuleVariableRevisions>,
      })) : readModuleVariables(target.dir)
      const variables = args.scope === 'global' ? state.global : state.effective
      const source = (key: string): 'module' | 'global' | null => !Object.hasOwn(variables, key) ? null
        : args.scope === 'module' && Object.hasOwn(state.module, key) ? 'module' : 'global'
      return {
        moduleId: target.id, scope: args.scope, revisions: state.revisions, enabled: state.enabled,
        ...(args.action === 'list' ? { variables, sources: Object.fromEntries(Object.keys(variables).map(key => [key, source(key)])) }
          : { key: args.key!, value: Object.hasOwn(variables, args.key!) ? variables[args.key!]! : null, source: source(args.key!) }),
        ...(saved === undefined ? {} : { persisted: saved.persisted,
          ...(saved.publicationPending === undefined ? {} : { publicationPending: saved.publicationPending }),
          ...(saved.publicationError === undefined ? {} : { publicationError: saved.publicationError }),
        }),
      }
    },
  })))
  return () => { void fiber.dispose() }
}
