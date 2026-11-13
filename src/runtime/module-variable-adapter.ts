import { readModuleVariables, editModuleVariables } from '../host/module-variables.ts'
import type { ModuleVariablesEdit } from '../host/module-variables.ts'
import type { ModuleVariableRevisions } from '../shared/module-variables.ts'
import type { SessionVariableOwner } from '../host/session-variables.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ModuleWriteError } from '../host/module-write.ts'
import { assertModuleDirectory, assertModuleId, assertModuleSnapshotSource } from '../host/module-install.ts'
import { join } from 'node:path'
import { ensureModuleSlices } from '../host/module-slices.ts'

/** 引擎只收受控来源身份；读取新快照和发布切片均不重挂 Agent。 */
export interface VariableEvaluationContext { agent?: unknown; signal?: AbortSignal }
export interface VariableRuntimeOptions {
  sessionVariables?: () => SessionVariableOwner | undefined
  runtimeValue?: (id: string, key: string, agent: Agent, signal?: AbortSignal) => string | undefined
  /** 装配期运行时事实（例如角色委派写入的 role）；按会话覆盖 effective，不写盘。 */
  runtimeVariables?: (id: string, sessionId: string) => Record<string, string> | undefined
}
type VariableEdit = Omit<ModuleVariablesEdit, 'scope' | 'expectedRevisions'> & {
  scope: 'global' | 'module' | 'session'
  expectedRevisions: Partial<ModuleVariableRevisions> & { session?: string | null }
}

export function createModuleVariableAdapter(moduleRoot: string, options: VariableRuntimeOptions = {}) {
  const directory = (id: string) => assertModuleDirectory(moduleRoot, id)
  const sessionOf = (context: VariableEvaluationContext) => {
    context.signal?.throwIfAborted()
    const agent = context.agent as Agent | undefined
    if (!agent?.session?.id) throw new ModuleWriteError('会话变量缺少实际 Agent 身份')
    return agent.session.id
  }
  const ownerOf = () => {
    const owner = options.sessionVariables?.()
    if (!owner) throw new ModuleWriteError('会话变量需要宿主 storageDomain，当前不可用', 409, 'session-variables-unavailable')
    return owner
  }
  return {
    read: (id: string, context: VariableEvaluationContext = {}) => {
      assertModuleId(id)
      context.signal?.throwIfAborted()
      const state = readModuleVariables(join(moduleRoot, id), { runtime: true })
      const owner = options.sessionVariables?.()
      // 运行时事实与持久会话变量都按真实 Agent 身份取；没有 Agent 时两者都不读。
      const sessionId = context.agent ? sessionOf(context) : undefined
      const assertCurrent = (current: VariableEvaluationContext = {}) => {
        current.signal?.throwIfAborted()
        const dir = assertModuleSnapshotSource(moduleRoot, id)
        if (!readModuleVariables(dir, { runtime: true }).enabled) throw new ModuleWriteError('变量求值已关闭')
        if (owner && sessionId !== undefined && (options.sessionVariables?.() !== owner || sessionOf(current) !== sessionId)) throw new ModuleWriteError('会话变量来源或身份已变化')
      }
      if (!state.enabled || !context.agent) return { ...state, assertCurrent }
      // 运行时事实不是第二份配置：它只覆盖同名键，未定义时不改变任何既有读取结果。
      const runtime = options.runtimeVariables?.(id, sessionId!)
      if (!owner) return runtime === undefined ? { ...state, assertCurrent }
        : { ...state, effective: { ...state.effective, ...runtime }, assertCurrent }
      const session = owner.read(join(moduleRoot, id), sessionId!)
      return { ...state, session: session.variables, effective: { ...state.effective, ...session.variables, ...runtime },
        revisions: { ...state.revisions, session: session.revision }, assertCurrent }
    },
    readRuntime: (id: string, key: string, context: VariableEvaluationContext = {}) => {
      sessionOf(context)
      if (!readModuleVariables(join(moduleRoot, id), { runtime: true }).enabled) return undefined
      return options.runtimeValue?.(id, key, context.agent as Agent, context.signal)
    },
    commit: (id: string, request: VariableEdit, context: VariableEvaluationContext = {}) => {
      context.signal?.throwIfAborted()
      const dir = directory(id)
      const { session, ...dependencies } = request.expectedRevisions
      if (request.scope === 'session') {
        if (!Object.hasOwn(request.expectedRevisions, 'session') || !request.changes || request.values !== undefined || request.enabled !== undefined) {
          throw new ModuleWriteError('会话变量提交需要 changes 与 session 版本')
        }
        const sessionId = sessionOf(context), owner = ownerOf()
        return owner.edit(dir, sessionId, { changes: request.changes, expectedRevision: session!, expectedDependencies: dependencies }, {
          signal: context.signal,
          assertAuthorized: () => {
            if (ownerOf() !== owner || sessionOf(context) !== sessionId || directory(id) !== dir) throw new ModuleWriteError('会话变量来源或身份已变化')
            if (!readModuleVariables(dir).enabled) throw new ModuleWriteError('变量求值已关闭')
          },
        })
      }
      const checkSession = Object.hasOwn(request.expectedRevisions, 'session') ? () => {
        if (ownerOf().read(dir, sessionOf(context)).revision !== session) throw new ModuleWriteError('会话变量已变化，请重新读取', 409, 'session-variables-conflict')
      } : undefined
      return editModuleVariables(dir, { ...request, scope: request.scope, expectedRevisions: dependencies }, { checkSession })
    },
    publish: (id: string) => { ensureModuleSlices(directory(id)); },
  }
}
