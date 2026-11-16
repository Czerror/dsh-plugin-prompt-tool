import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MODULE_ID_PARAM } from '../host/module-tool-target.ts'
import type { ModuleToolHost } from '../host/module-tool-target.ts'
import { markSoulState, readSoulState } from '../host/soul-state.ts'
import { MODULE_TOOL_NAMES } from '../shared/engine-capabilities.ts'
import type { SessionVariableOwner } from '../host/session-variables.ts'
import { readModuleVariables } from '../host/module-variables.ts'
import type { SoulKnowledgeOwner } from '../host/soul-knowledge.ts'
import { SOUL_SELF_SERVICE } from '../../engine/service-names.mjs'
import type { Agent } from '@deepseek-ai/dsh-agent'

type Observation = string | number | boolean | null | Observation[] | { [key: string]: Observation }
export interface SoulStateObservation {
  status: (exec: ToolExecution, moduleId: string) => Observation | Promise<Observation>
  check: (exec: ToolExecution, moduleId: string, includeUpgrade?: boolean) => Observation | Promise<Observation>
}

export function registerSoulStateTools(ctx: Context, host: Pick<ModuleToolHost, 'target'>, observe: SoulStateObservation | undefined, sessions: () => SessionVariableOwner | undefined, knowledge?: () => SoulKnowledgeOwner | undefined): () => void {
  const sessionOwner = (): SessionVariableOwner => {
    const owner = sessions?.()
    if (owner === undefined) throw new Error('会话变量持久化依赖不可用，不能读取当前状态')
    return owner
  }
  const fiber = ctx.inject(['tools'], toolsCtx => toolsCtx.tools.register(defineTool({
    name: MODULE_TOOL_NAMES.soulState,
    description: '读取真实当前会话Soul状态或只读运行诊断；check显式includeUpgrade=true才展开完整升级文件候选。mark记录短状态及时间，需要status版本，首次null；标记时间不代表实际活动，不关闭账本事项。阶段收尾consolidate提交text、已登记条目/来源refs及生成前knowledge.consolidationRevision作为expectedRevision；只整理新增材料，不额外调用模型；published才生效，candidate仅保存未生效。learn提交text、layer、正式条目ref和knowledge.binding.revision作为expectedRevision；明确长期用户反馈可标basis=explicit-long-term，推断用inference，refs补充独立经历的条目/已发布摘要；assessment含decision(adopt/candidate)、reason(采纳/替代/保留及反证处理依据)、unresolved(是否尚有未解反证)、counterRefs(反证引用数组)。至少两次独立真实经历、同范围且有理由采纳无未解反证才生效；同源摘要不能重复计数，不能将推断称为用户意见或将局部经历推广全局，不确定保留candidate。核心/锁定变化仅候选，交用户knowledge命令确认；可用previous声明同层学习替换，不能自报确认或作者。assist在当前根用户回合共享预算内请求一次无工具辅助整理，立即返回排队状态；status查看生成、发布、取消、失败和预算，不接受自报来源或用量。',
    parameters: {
      moduleId: MODULE_ID_PARAM, action: { type: 'string', enum: ['status', 'mark', 'check', 'consolidate', 'learn', 'assist'], required: true },
      layer: { type: 'string', enum: ['expression', 'judgment', 'experience', 'core', 'locked'] }, ref: { type: 'string' }, previous: { type: 'string' },
      basis: { type: 'string', enum: ['explicit-long-term', 'inference'] },
      assessment: { type: 'json' },
      text: { type: 'string' }, expectedRevision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      refs: { type: 'array', items: { type: 'string' } },
      includeUpgrade: { type: 'boolean' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      sessionId: { type: 'string' }, revision: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      mark: { oneOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, properties: { text: { type: 'string' }, recordedAt: { type: 'string' } } }] },
      observation: { type: 'json' },
      knowledge: { type: 'json' },
      recording: { type: 'json' },
      publication: { type: 'json' },
      learning: { type: 'json' },
      assistedConsolidation: { type: 'json' },
      persisted: { type: 'boolean' }, publicationSuppressed: { type: 'boolean' },
    } }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      if (Object.keys(args).some(key => !['moduleId', 'action', 'text', 'expectedRevision', 'includeUpgrade', 'refs', 'layer', 'ref', 'previous', 'basis', 'assessment'].includes(key))) throw new Error('Soul状态请求含未知字段，不能指定其他会话')
      if (args.includeUpgrade !== undefined && (typeof args.includeUpgrade !== 'boolean' || args.action !== 'check')) throw new Error('只有check接受布尔includeUpgrade')
      exec.signal.throwIfAborted()
      const target = host.target(exec, args.moduleId), sessionId = exec.agent?.session.id
      if (!sessionId) throw new Error('Soul状态缺少实际会话身份')
      if (args.action === 'learn') {
        const owner = knowledge?.()
        if (!owner) throw new Error('知识库持久状态不可用')
        const assertAuthorized = () => {
          exec.signal.throwIfAborted()
          if (knowledge?.() !== owner || host.target(exec, args.moduleId).dir !== target.dir || exec.agent?.session.id !== sessionId) throw new Error('学习来源或会话已变化')
        }
        const learning = await owner.learn(target.dir, sessionId, { text: args.text as string, layer: args.layer as string, ref: args.ref as string, expectedRevision: args.expectedRevision as string, ...(args.refs === undefined ? {} : { refs: args.refs as string[] }), ...(args.assessment === undefined ? {} : { assessment: args.assessment as Parameters<SoulKnowledgeOwner['learn']>[2]['assessment'] }), ...(args.basis === undefined ? {} : { basis: args.basis as string }), ...(args.previous === undefined ? {} : { previous: args.previous as string }) }, exec.signal, assertAuthorized)
        return { sessionId, learning: learning as Observation }
      }
      if (args.layer !== undefined || args.ref !== undefined || args.previous !== undefined || args.basis !== undefined || args.assessment !== undefined) throw new Error('只有learn接受学习字段')
      const assisted = ctx.get(SOUL_SELF_SERVICE) as { requestAssisted?: (id: string, agent: Agent) => Promise<Record<string, unknown>>; assistedStatus?: (id: string, agent: Agent) => Record<string, unknown> } | undefined
      if (args.action === 'assist') {
        if (args.text !== undefined || args.expectedRevision !== undefined || args.refs !== undefined || !exec.agent || !assisted?.requestAssisted) throw new Error('辅助整理只接受当前真实会话和模块，不接受自报材料或预算')
        return { sessionId, assistedConsolidation: await assisted.requestAssisted(target.id, exec.agent) as Observation }
      }
      if (args.refs !== undefined && args.action !== 'consolidate') throw new Error('只有整理接受来源引用')
      if (args.action === 'consolidate') {
        const owner = knowledge?.()
        if (!owner) throw new Error('知识库持久状态不可用')
        const assertAuthorized = () => {
          exec.signal.throwIfAborted()
          if (knowledge?.() !== owner || host.target(exec, args.moduleId).dir !== target.dir || exec.agent?.session.id !== sessionId) throw new Error('整理来源或会话已变化')
        }
        const publication = await owner.consolidate(target.dir, sessionId, { text: args.text as string, refs: args.refs as string[], expectedRevision: args.expectedRevision as string }, exec.signal, assertAuthorized)
        return { sessionId, publication: publication as Observation }
      }
      if (args.action === 'mark') {
        const owner = sessionOwner()
        const assertAuthorized = () => {
          exec.signal.throwIfAborted()
          if (sessionOwner() !== owner) throw new Error('会话变量来源已变化')
          if (host.target(exec, args.moduleId).dir !== target.dir || exec.agent?.session.id !== sessionId) throw new Error('Soul状态来源或会话已变化')
          if (!readModuleVariables(target.dir).enabled) throw new Error('模块变量已关闭，不能写入mark')
        }
        assertAuthorized()
        const saved = await markSoulState(target.dir, sessionId, { text: args.text, expectedRevision: args.expectedRevision }, exec.signal, owner, assertAuthorized)
        try { assertAuthorized() }
        catch { return { sessionId, revision: saved.revision, persisted: true, publicationSuppressed: true } }
        return { sessionId, ...saved }
      }
      if (args.action !== 'status' && args.action !== 'check') throw new Error('Soul状态action无效')
      if (args.text !== undefined || args.expectedRevision !== undefined) throw new Error('Soul状态读取不接受写入字段')
      const assertUpgradeAllowed = () => {
        if (!args.includeUpgrade || !knowledge) return
        const owner = knowledge()
        if (!owner || owner.status(target.dir).state !== 'unbound') throw new Error('受控知识库已接入或授权不可用，模型不能展开完整升级正文；请使用用户升级入口')
      }
      assertUpgradeAllowed()
      const observation = observe ? await observe[args.action](exec, target.id, args.includeUpgrade) : undefined
      assertUpgradeAllowed()
      exec.signal.throwIfAborted()
      if (host.target(exec, args.moduleId).dir !== target.dir || exec.agent?.session.id !== sessionId) throw new Error('Soul状态来源或会话已变化')
      const owner = knowledge?.(), access = owner?.status(target.dir)
      if (access?.binding) access.binding.learning = owner!.learning(target.dir, sessionId, true)
      const recording = access?.state === 'bound' ? owner!.recording(target.dir, sessionId) : { persisted: 0, pending: 0, derivedFailed: 0 }
      return { sessionId, ...readSoulState(target.dir, sessionId, sessionOwner()), knowledge: access ?? { state: 'unavailable', reason: '知识库持久状态不可用' }, assistedConsolidation: exec.agent && assisted?.assistedStatus?.(target.id, exec.agent) as Observation, recording, ...(observation === undefined ? {} : { observation }) }
    },
  })))
  return () => { void fiber.dispose() }
}
