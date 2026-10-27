/** 每个 Agent 聚合已声明来源，工具与来源授权一起释放。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { createModuleRetrieval } from '../host/module-retrieval.ts'
import type { LoadRetrievalSession, RetrievalReference } from '../host/module-retrieval.ts'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'

export interface RetrievalConfig { paths: readonly string[]; sessions: readonly string[] }
export interface RetrievalMount { agent: Agent; sourceModuleId: string; sourceModuleDir: string }

/** 调用方已确认 tools 就绪；同步注册使初始化错误回到当前能力的挂载路径。 */
export function registerModuleRetrievalTools(ctx: Context, retrievalOf: (exec: ToolExecution, moduleId: string | undefined) => ReturnType<typeof createModuleRetrieval>): () => void {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('检索工具注册需要 tools 服务')
  const disposers: Array<() => void> = []
  const dispose = (): void => { for (const off of disposers.splice(0).reverse()) off() }
  try {
    disposers.push(tools.register(defineTool({
        name: MODULE_TOOL_NAMES.search,
        description: '搜索 moduleId 声明模块已授权的文件、账本或历史会话。结果中的 reference 可交 module_open 回取相同原文。',
        parameters: { moduleId: MODULE_ID_PARAM, query: { type: 'string', required: true }, limit: { type: 'number' } },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => {
          if (Object.keys(args).some(key => !['moduleId', 'query', 'limit'].includes(key))) throw new Error('检索请求含未知字段')
          exec.signal?.throwIfAborted()
          const value = await retrievalOf(exec, args.moduleId).search({ query: args.query, limit: args.limit })
          exec.signal?.throwIfAborted()
          retrievalOf(exec, args.moduleId)
          return value
        },
      })))
    disposers.push(tools.register(defineTool({
        name: MODULE_TOOL_NAMES.open,
        description: '回取 module_search 返回的引用。每次重新检查来源授权与版本；引用不是访问凭据。',
        parameters: { moduleId: MODULE_ID_PARAM, reference: { type: 'object', additionalProperties: true, required: true } },
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args, exec) => {
          if (Object.keys(args).some(key => !['moduleId', 'reference'].includes(key))) throw new Error('回取请求含未知字段')
          exec.signal?.throwIfAborted()
          const value = await retrievalOf(exec, args.moduleId).open(args.reference as unknown as RetrievalReference)
          exec.signal?.throwIfAborted()
          retrievalOf(exec, args.moduleId)
          return value
        },
      })))
  } catch (error) { dispose(); throw error }
  return dispose
}

export function createModuleRetrievalProvider(host: Pick<ModuleToolHost, 'target'>, loadSession?: LoadRetrievalSession) {
  type Declaration = { config: RetrievalConfig; dir: string }
  type State = { modules: Map<string, Map<symbol, Declaration>>; indexes: Map<string, ReturnType<typeof createModuleRetrieval>>; dispose: () => void }
  const agents = new WeakMap<Agent, State>()
  const retrievalFor = (state: State, moduleId: string, agent: Agent) => {
    let retrieval = state.indexes.get(moduleId)
    if (retrieval === undefined) {
      retrieval = createModuleRetrieval(() => {
        const current = [...(state.modules.get(moduleId)?.values() ?? [])].at(-1)
        if (!current) throw new Error('检索模块未授权')
        return { moduleId, dir: current.dir, paths: current.config.paths, sessions: current.config.sessions, session: agent.session }
      }, loadSession)
      state.indexes.set(moduleId, retrieval)
    }
    return retrieval
  }
  return {
    async refresh(agent: Agent, moduleId: string, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const state = agents.get(agent)
      if (!state?.modules.has(moduleId)) throw new Error('检索模块未授权')
      const result = await retrievalFor(state, moduleId, agent).refresh()
      signal?.throwIfAborted()
      if (!state.modules.has(moduleId)) throw new Error('检索模块未授权')
      return result
    },
    mount(_ctx: Context, config: RetrievalConfig, options: RetrievalMount): () => void {
      const { agent, sourceModuleId, sourceModuleDir } = options
      if (!agent?.ctx || !sourceModuleId || !sourceModuleDir) throw new Error('检索缺少宿主来源模块身份')
      if (!Array.isArray(config.paths) || config.paths.length > 2048 || config.paths.some(path => typeof path !== 'string')
        || !Array.isArray(config.sessions) || config.sessions.length > 128 || config.sessions.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('检索来源白名单无效或超限')
      let state = agents.get(agent)
      if (state === undefined) {
        const modules = new Map<string, Map<symbol, Declaration>>()
        const indexes = new Map<string, ReturnType<typeof createModuleRetrieval>>()
        const dispose = registerModuleRetrievalTools(agent.ctx, (exec, moduleId) => {
          if (exec.agent !== agent) throw new Error('检索 Agent 未授权')
          const target = host.target(exec, moduleId)
          const declaration = [...(modules.get(target.id)?.values() ?? [])].at(-1)
          if (!declaration || declaration.dir !== target.dir) throw new Error('检索模块未授权')
          return retrievalFor({ modules, indexes, dispose }, target.id, agent)
        })
        state = { modules, indexes, dispose }
        agents.set(agent, state)
      }
      let declarations = state.modules.get(sourceModuleId)
      if (declarations === undefined) { declarations = new Map(); state.modules.set(sourceModuleId, declarations) }
      const token = Symbol(sourceModuleId)
      declarations.set(token, { config, dir: sourceModuleDir })
      const owner = state
      return () => {
        if (!declarations.delete(token)) return
        if (declarations.size === 0) { owner.modules.delete(sourceModuleId); owner.indexes.delete(sourceModuleId) }
        if (owner.modules.size === 0) { owner.dispose(); agents.delete(agent) }
      }
    },
  }
}
