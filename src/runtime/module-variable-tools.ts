/** 模块变量工具只调用持久变量所有者；内容更新不重装 Agent。 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { editModuleVariables, readModuleVariables } from '../host/module-variables.ts'
import type { ModuleVariableRevisions, ModuleVariablesResult } from '../host/module-variables.ts'
import { assertVariableValues } from '../host/module-slices.ts'
import { ModuleWriteError } from '../host/module-write.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import type { SessionVariableOwner } from '../host/session-variables.ts'

export function registerModuleVariableTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>, sessions?: () => SessionVariableOwner | undefined): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.variables,
    description: '读写持久变量：scope=session 按来源模块和真实当前会话隔离，读取按会话→模块→全局回落；scope=module 按模块→全局；scope=global 仅全局。list/get 返回来源与版本；set 必须显式 value，空串保留，delete 删除后回落。写入携 expectedRevisions。session 需要宿主 storageDomain，不接受指定其他会话；soul.mark 是限长短状态，更新时间由宿主记录。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      scope: { type: 'string', enum: ['global', 'module', 'session'], required: true },
      action: { type: 'string', enum: ['list', 'get', 'set', 'delete'], required: true },
      key: { type: 'string' }, value: { type: 'string' },
      expectedRevisions: { type: 'object', additionalProperties: true },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          moduleId: { type: 'string', required: true }, scope: { type: 'string', enum: ['global', 'module', 'session'], required: true },
          revisions: { type: 'object', additionalProperties: false, required: true, properties: {
            global: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true }, module: { type: 'string', required: true }, settings: { type: 'string', required: true },
            session: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          } },
          enabled: { type: 'boolean', required: true },
          variables: { type: 'object', additionalProperties: true }, sources: { type: 'object', additionalProperties: true },
          key: { type: 'string' }, value: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          source: { oneOf: [{ type: 'string', enum: ['global', 'module', 'session'] }, { type: 'null' }] },
          persisted: { type: 'boolean' }, publicationSuppressed: { type: 'boolean' }, publicationPending: { type: 'boolean' }, publicationError: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'scope', 'action', 'key', 'value', 'expectedRevisions'].includes(key))) throw new ModuleWriteError('变量工具含未知字段')
      const writing = args.action === 'set' || args.action === 'delete'
      if (args.action === 'list' && args.key !== undefined || args.action !== 'set' && args.value !== undefined) throw new ModuleWriteError('该变量操作不接受 key 或 value')
      if (!writing && args.expectedRevisions !== undefined) throw new ModuleWriteError('读取变量不接受写入版本')
      if (args.action !== 'list') {
        if (typeof args.key !== 'string') throw new ModuleWriteError('变量操作需要 key')
        assertVariableValues({ [args.key]: '' })
      }
      if (args.action === 'set' && typeof args.value !== 'string') throw new ModuleWriteError('set 必须显式提供字符串 value；空串是有效值')
      if (writing && args.expectedRevisions === undefined) throw new ModuleWriteError('写变量必须提供 expectedRevisions')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId)
      if (args.scope === 'session') {
        const sessionId = exec.agent?.session.id, owner = sessions?.()
        if (!sessionId || !owner) throw new ModuleWriteError('会话变量需要真实会话与宿主 storageDomain')
        const state = readModuleVariables(target.dir)
        if (!state.enabled) throw new ModuleWriteError('变量求值已关闭')
        const revisions = args.expectedRevisions as (Partial<ModuleVariableRevisions> & { session?: string | null }) | undefined
        if (writing && (!revisions || !Object.hasOwn(revisions, 'session'))) throw new ModuleWriteError('会话写入需要 session 版本')
        const { session: expectedRevision, ...expectedDependencies } = revisions ?? {}
        const assertAuthorized = () => {
          exec.signal.throwIfAborted()
          if (sessions?.() !== owner || exec.agent?.session.id !== sessionId || host.target(exec, args.moduleId).dir !== target.dir) throw new ModuleWriteError('会话变量来源或身份已变化')
          if (!readModuleVariables(target.dir).enabled) throw new ModuleWriteError('变量求值已关闭')
        }
        const result = writing ? await owner.edit(target.dir, sessionId, {
          changes: { [args.key!]: args.action === 'delete' ? null : args.value! }, expectedRevision: expectedRevision!, expectedDependencies,
        }, { signal: exec.signal, assertAuthorized }) : owner.read(target.dir, sessionId)
        if (writing) {
          try { assertAuthorized() }
          catch { return { moduleId: target.id, scope: args.scope, revisions: { ...state.revisions, session: result.revision }, enabled: false, persisted: true, publicationSuppressed: true } }
        }
        const current = state, variables = { ...current.effective, ...result.variables }
        const source = (key: string): 'session' | 'module' | 'global' | null => Object.hasOwn(result.variables, key) ? 'session'
          : Object.hasOwn(current.module, key) ? 'module' : Object.hasOwn(current.global, key) ? 'global' : null
        return { moduleId: target.id, scope: args.scope, revisions: { ...current.revisions, session: result.revision }, enabled: current.enabled,
          ...(args.action === 'list' ? { variables, sources: Object.fromEntries(Object.keys(variables).map(key => [key, source(key)])) }
            : { key: args.key!, value: Object.hasOwn(variables, args.key!) ? variables[args.key!]! : null, source: source(args.key!) }),
          ...(writing ? { persisted: true } : {}),
        }
      }
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
