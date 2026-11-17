import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SOUL_SELF_SERVICE } from '../../engine/service-names.mjs'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { appendSoulLedger, closeSoulLedger, readSoulLedger, SOUL_LEDGER_TYPES } from '../host/soul-ledger.ts'
import type { SoulKnowledgeOwner } from '../host/soul-knowledge.ts'
import type { ContinuitySource } from '../host/soul-knowledge.ts'
import { revisionOf } from '../host/module-write.ts'
import { join } from 'node:path'

export function registerSoulLedgerTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>, knowledge?: () => SoulKnowledgeOwner | undefined): () => void {
  const fiber = ctx.inject(['tools'], toolsCtx => {
    const offGate = toolsCtx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      const args = exec.arguments as Record<string, unknown> | null
      if (decision.kind !== 'allow' || exec.name !== MODULE_TOOL_NAMES.soulLedger || args?.action !== 'append' || args?.type !== 'lead') return decision
      exec.signal.throwIfAborted()
      return { kind: 'ask', reason: '变更 soul 账本主导会话，需要用户明确指定' }
    })
    const offTool = toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.soulLedger,
    description: '读取、追加或逐项收口模块账本。重要决定、长期反馈、完成事项和保留问题应实际调用记录；未写入不得声称记住，pending只表示待整理。作者时间与受控来源由真实会话提供；promise 仅当前 lead 可写/收口，shelved 原作者或当前 lead 可收口。close 用 targetId、completed/cancelled 和非空 reason；ref 是证据出处。pending/open/pending-review 视图支持版本游标分页。lead 必须用户指定并附 ref。',
    parameters: {
      moduleId: MODULE_ID_PARAM,
      action: { type: 'string', enum: ['list', 'append', 'close'], required: true },
      targetId: { type: 'string' }, outcome: { type: 'string', enum: ['completed', 'cancelled'] }, reason: { type: 'string' },
      type: { type: 'string', enum: [...SOUL_LEDGER_TYPES, 'close'] },
      view: { type: 'string', enum: ['history', 'pending', 'open', 'pending-review'] }, cursor: { type: 'string' },
      text: { type: 'string' }, '概要': { type: 'string' }, ref: { type: 'string' }, feel: { type: 'string' }, limit: { type: 'integer' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        entry: { type: 'object', additionalProperties: true }, entries: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' },
        nextCursor: { type: 'string' }, initialized: { type: 'boolean' }, revision: { type: 'string' },
        derived: { type: 'object', additionalProperties: true },
        persisted: { type: 'boolean' }, reference: { type: 'json' },
      } },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action', 'type', 'text', '概要', 'ref', 'feel', 'limit', 'targetId', 'outcome', 'reason', 'view', 'cursor'].includes(key))) throw new Error('账本工具含未知字段，不能指定作者或覆盖历史')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId)
      const controlled = knowledge?.()?.status(target.dir).state !== 'unbound' && !!knowledge
      const save = async (commit: (origin?: ContinuitySource) => ReturnType<typeof appendSoulLedger>) => {
        if (!controlled) return committed(commit())
        const owner = knowledge?.(), runtime = ctx.get(SOUL_SELF_SERVICE) as { admit?: (id: string, agent: Agent) => Promise<void>; assertParticipating?: (id: string, agent: Agent) => string } | undefined
        if (!owner || !exec.agent || !runtime?.admit) throw new Error('受控账本需要实际Soul装配及持久来源')
        await runtime.admit(target.id, exec.agent)
        return owner.record(target.dir, exec.agent.session.id, revisionOf(JSON.stringify([exec.agent.session.id, exec.callId])), origin => {
          runtime.assertParticipating?.(target.id, exec.agent!)
          if (args.action === 'close' && !owner.records(target.dir, exec.agent!.session.id).some(row => row.entryId === args.targetId)) throw new Error('收口目标来源已撤权')
          return commit(origin)
        }, exec.signal)
      }
      const committed = (result: ReturnType<typeof appendSoulLedger>) => {
        try {
          const owner = ctx.get?.(SOUL_SELF_SERVICE) as { committed?: (id: string, agent: Agent) => { state: string } } | undefined
          const derived = exec.agent && owner?.committed?.(target.id, exec.agent)
          return { ...result, ...(derived ? { derived } : {}) }
        } catch { return { ...result, derived: { state: 'failed', error: '账本已提交；派生状态通知失败，请用soul_state check核对，勿重放写入。' } } }
      }
      if (args.action === 'close') {
        if (args.type !== undefined || args.text !== undefined || args['概要'] !== undefined || args.feel !== undefined || args.limit !== undefined || args.view !== undefined || args.cursor !== undefined) throw new Error('收口不接受追加或读取字段')
        if (!args.targetId || !args.outcome || !args.reason) throw new Error('收口需要 targetId、outcome 与 reason')
        return save(origin => closeSoulLedger(target.dir, { targetId: args.targetId!, outcome: args.outcome!, reason: args.reason!, ...(args.ref === undefined ? {} : { ref: args.ref }) }, { sessionId: exec.agent?.session.id, signal: exec.signal, origin }))
      }
      if (args.targetId !== undefined || args.outcome !== undefined || args.reason !== undefined) throw new Error('只有收口接受 targetId、outcome 与 reason')
      if (args.action === 'list') {
        if (args.text !== undefined || args['概要'] !== undefined || args.ref !== undefined || args.feel !== undefined) throw new Error('读取账本不接受写入字段')
        if (knowledge) {
          const owner = knowledge()
          if (!owner) throw new Error('知识来源授权持久状态不可用')
          if (owner.status(target.dir).state !== 'unbound') {
            return owner.withEvidence([{ directory: target.dir, sessionId: exec.agent?.session.id ?? '' }], exec.signal, () => {
              const records = owner.records(target.dir, exec.agent?.session.id ?? '')
              if (!records.length) throw new Error('旧账本待归类，无受控账本来源')
              const allowed = new Set(records.map(row => row.entryId))
              return readSoulLedger(target.dir, { limit: args.limit, type: args.type, view: args.view, cursor: args.cursor }, allowed)
            })
          }
          owner.assertFile(target.dir, join(target.dir, 'data', '02-soul.jsonl'), exec.agent?.session.id)
        }
        return readSoulLedger(target.dir, { limit: args.limit, type: args.type, view: args.view, cursor: args.cursor })
      }
      if (args.limit !== undefined || args.view !== undefined || args.cursor !== undefined || args.type === undefined) throw new Error('追加账本需要 type 且不接受读取字段')
      if (args.type === 'lead' && !args.ref?.trim()) throw new Error('lead 必须提供用户指定主导的 ref')
      return save(origin => appendSoulLedger(target.dir, { type: args.type!, ...(args.text === undefined ? {} : { text: args.text }), ...(args['概要'] === undefined ? {} : { '概要': args['概要'] }),
        ...(args.ref === undefined ? {} : { ref: args.ref }), ...(args.feel === undefined ? {} : { feel: args.feel }) }, { sessionId: exec.agent?.session.id, signal: exec.signal, origin }))
    },
    }))
    return () => { offGate(); offTool() }
  })
  return () => { void fiber.dispose() }
}
