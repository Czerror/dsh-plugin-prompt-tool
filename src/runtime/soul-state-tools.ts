import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { markSoulState, readSoulState } from '../host/soul-state.ts'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'

type Observation = string | number | boolean | null | Observation[] | { [key: string]: Observation }
export interface SoulStateObservation {
  status: (exec: ToolExecution, moduleId: string) => Observation | Promise<Observation>
  check: (exec: ToolExecution, moduleId: string, includeUpgrade?: boolean) => Observation | Promise<Observation>
}

export function registerSoulStateTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>, observe?: SoulStateObservation): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.soulState,
    description: '读取真实当前会话Soul状态或只读运行诊断；check显式includeUpgrade=true才展开完整升级文件候选。mark记录短状态及时间，需要status版本，首次null；标记时间不代表实际活动，不关闭账本事项。',
    parameters: {
      moduleId: MODULE_ID_PARAM, action: { type: 'string', enum: ['status', 'mark', 'check'], required: true },
      text: { type: 'string' }, expectedRevision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      includeUpgrade: { type: 'boolean' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      sessionId: { type: 'string' }, revision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      mark: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, recordedAt: { type: 'string' } } }] },
      observation: { type: 'json' },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action', 'text', 'expectedRevision', 'includeUpgrade'].includes(key))) throw new Error('Soul状态请求含未知字段，不能指定其他会话')
      if (args.includeUpgrade !== undefined && (typeof args.includeUpgrade !== 'boolean' || args.action !== 'check')) throw new Error('只有check接受布尔includeUpgrade')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId), sessionId = exec.agent?.session.id
      if (!sessionId) throw new Error('Soul状态缺少实际会话身份')
      if (args.action === 'mark') return { sessionId, ...markSoulState(target.dir, sessionId, { text: args.text, expectedRevision: args.expectedRevision }, exec.signal) }
      if (args.action !== 'status' && args.action !== 'check') throw new Error('Soul状态action无效')
      if (args.text !== undefined || args.expectedRevision !== undefined) throw new Error('Soul状态读取不接受写入字段')
      const observation = observe ? await observe[args.action](exec, target.id, args.includeUpgrade) : undefined
      exec.signal.throwIfAborted()
      if (host.target(exec, args.moduleId).dir !== target.dir || exec.agent?.session.id !== sessionId) throw new Error('Soul状态来源或会话已变化')
      return { sessionId, ...readSoulState(target.dir, sessionId), ...(observation === undefined ? {} : { observation }) }
    },
  })))
  return () => { void fiber.dispose() }
}
