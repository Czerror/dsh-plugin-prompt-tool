/** instructions 域端点：指令文件（AGENTS.md 等）读写、指令策略与声明规则事务。 */
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { isEditableModuleDir, packageEngineDir } from '../../host/module-dirs.ts'
import { ensureModuleSlices, loadModuleDefinition } from '../../host/module-slices.ts'
import { ModuleWriteError } from '../../host/module-write.ts'
import { createModuleRule, editModuleRules, readModuleRules } from '../../host/module-rules.ts'
import { writeAgentsFileChecked } from '../../host/agents-cards.ts'
import { instructionPolicyPath, readInstructionPolicy, writeInstructionPolicy } from '../../host/instructions-policy.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import type { RuleDefinition, RuleEdit, RuleEditorMeta, RuleRevisions } from '../../shared/rules.ts'
import { writeLayerSettingsError } from '../module-subject-gate.ts'
import {
  instructionOwner,
  isRecord,
  mergeInstructionCards,
  readSessionIdField,
  resolveInstructionScope,
  type BridgeRuntime,
} from '../bridge-runtime.ts'

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type InstructionsRuntime = Pick<BridgeRuntime, 'deps' | 'scope' | 'register' | 'gate'>

/**
 * 规则编辑器元数据（谓词/动作/位置清单）：动态 import 而非静态——`rule-spec.mjs` 是纯 JS，
 * 静态引入会把整个引擎拖进插件的模块图。ESM 自带缓存，这里每次取值不会重复解析。
 */
async function ruleEditorMeta(): Promise<RuleEditorMeta> {
  const { getRuleEditorMeta } = await import(pathToFileURL(join(packageEngineDir(), 'rule-spec.mjs')).href) as { getRuleEditorMeta: () => RuleEditorMeta }
  return getRuleEditorMeta()
}

export function registerInstructions(runtime: InstructionsRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.promptConfigs, { handle: async (tx) => {
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'settings-rejected', message: session.message })
        return
      }
      // 实际生效配置 = 模块定义编译出的规则（`rules/` 切片）与指令文件卡；
      // settings 不再承载 promptConfigs（旧覆盖层已退役）。
      const dir = runtime.gate(tx, 'promptConfigs').inspect()
      if (dir === undefined) return
      // 独立文件来源：与 /bootstrap 共用同一读取入口，附正文、字节版本与读取状态。
      const scope = await resolveInstructionScope(runtime.scope, session.sessionId)
      tx.write(200, {
        ok: true,
        value: {
          promptConfigs: mergeInstructionCards(scope.files),
          instructions: { context: scope.context, files: scope.files, owner: instructionOwner() },
        },
      })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.agentsFile, { handle: async (tx) => {
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'settings-rejected', message: session.message })
        return
      }
      const record = tx.record
      const fileId = typeof record.fileId === 'string' ? record.fileId.trim() : ''
      const contextId = typeof record.contextId === 'string' ? record.contextId.trim() : ''
      const content = record.content
      const expectedRevision = record.expectedRevision === null
        ? null
        : (typeof record.expectedRevision === 'string' && record.expectedRevision.length > 0
          ? record.expectedRevision
          : undefined)
      if (fileId === '' || contextId === '' || typeof content !== 'string' || expectedRevision === undefined) {
        tx.write(400, {
          ok: false,
          code: 'settings-rejected',
          message: 'fileId/contextId 必须是非空字符串，content 必须是字符串，expectedRevision 必须是 SHA-256 或 null',
        })
        return
      }
      // 白名单与上下文都由服务端本次重新解析：客户端提交的 contextId 只用于
      // 说明「它是按哪次读取起草的」，过期工作区（切会话/外部改动上下文）一律拒绝。
      const scope = await resolveInstructionScope(runtime.scope, session.sessionId)
      if (contextId !== scope.context.contextId) {
        tx.write(409, {
          ok: false,
          code: 'agents-file-context-stale',
          message: '工作区上下文已变化，未写盘；请重新读取后再保存',
        })
        return
      }
      const file = scope.cards.find((card) => card.fileId === fileId)
      if (file === undefined) {
        tx.write(400, {
          ok: false,
          code: 'settings-rejected',
          message: `unknown agents file: ${fileId}`,
        })
        return
      }
      const outcome = await writeAgentsFileChecked({ file, content, expectedRevision })
      if (!outcome.ok) {
        tx.write(outcome.status, { ok: false, code: outcome.code, message: outcome.message })
        return
      }
      // 正文写入是文件事实，不触发模块重建：运行时下一次读取直接看新文件。
      tx.write(200, { ok: true, value: { fileId: outcome.fileId, revision: outcome.revision } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.instructionsPolicy, { handle: async (tx) => {
      const record = tx.record
      const file = instructionPolicyPath()
      // 省略 policy = 读取：损坏/版本不认识时带 error 返回，客户端据此禁用保存。
      if (record.policy === undefined) {
        const snapshot = readInstructionPolicy(file)
        tx.write(200, {
          ok: true,
          value: {
            policy: snapshot.policy,
            revision: snapshot.revision,
            exists: snapshot.exists,
            ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
          },
        })
        return
      }
      const expectedRevision = record.expectedRevision === null
        ? null
        : (typeof record.expectedRevision === 'string' && record.expectedRevision.length > 0
          ? record.expectedRevision
          : undefined)
      if (expectedRevision === undefined) {
        tx.write(400, {
          ok: false,
          code: 'instructions-policy-invalid',
          message: 'expectedRevision 必须是 SHA-256 或 null',
        })
        return
      }
      const outcome = writeInstructionPolicy({ file, patch: record.policy, expectedRevision })
      if (!outcome.ok) {
        tx.write(outcome.status, { ok: false, code: outcome.code, message: outcome.message })
        return
      }
      tx.write(200, { ok: true, value: { policy: outcome.policy, revision: outcome.revision, exists: true } })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.triggers, { body: 'none', handle: async (tx) => {
      tx.write(410, { ok: false, code: 'rules-route-retired', message: '声明规则已统一为 rules；请改写旧声明（可由内置技能交给模型迁移）并刷新客户端，使用 /rules 编辑。' })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.rules, { handle: async (tx) => {
      const record = tx.record
      // 声明面只在读侧拦：这次请求要落盘（编辑或刷新发布）就放行，写完 rules 段才存在。
      const writing = record.refreshOnly === true
        || record.expectedRulesAbsent === true
        || record.createRule !== undefined
        || ((record.edits !== undefined || record.activateRuleId !== undefined) && record.validateOnly !== true)
      const dir = runtime.gate(tx, 'rules').inspect(writing)
      if (dir === undefined) return
      if (Object.keys(record).some(key => !['expectedModuleId', 'expectedRevisions', 'expectedRulesAbsent', 'createRule', 'edits', 'activateRuleId', 'validateOnly', 'refreshOnly'].includes(key))
        || typeof record.expectedModuleId !== 'string' || record.expectedModuleId === ''
        || (record.edits !== undefined && !Array.isArray(record.edits))
        || (record.activateRuleId !== undefined && (typeof record.activateRuleId !== 'string' || record.activateRuleId.length === 0))
        || (record.validateOnly !== undefined && typeof record.validateOnly !== 'boolean')
        || (record.refreshOnly !== undefined && typeof record.refreshOnly !== 'boolean')
        || (record.createRule !== undefined && !isRecord(record.createRule))
        || (record.expectedRulesAbsent !== undefined && record.expectedRulesAbsent !== true)
        || (record.refreshOnly === true && (record.edits !== undefined || record.activateRuleId !== undefined || record.validateOnly !== undefined || record.expectedRulesAbsent !== undefined || record.createRule !== undefined))
        || (record.createRule !== undefined && (record.edits !== undefined || record.activateRuleId !== undefined || record.validateOnly !== undefined || record.expectedRevisions !== undefined))
        || (record.expectedRulesAbsent === true && (record.createRule === undefined || record.expectedRevisions !== undefined))) {
        tx.write(400, { ok: false, code: 'rules-invalid', message: '规则请求字段、模块身份或版本格式不合法' })
        return
      }
      if (record.refreshOnly === true) {
        if (runtime.gate(tx, 'rules').authorize() === undefined) return
        try { await runtime.deps.overridesChanged?.(basename(dir)) }
        catch (error) {
          const committed = loadModuleDefinition(dir)
          const meta = await ruleEditorMeta()
          tx.write(200, { ok: true, value: { rules: committed.rules, revisions: committed.revisions, meta, persisted: true, publicationPending: true, publicationError: `运行刷新失败：${String(error)}` } })
          return
        }
        const committed = loadModuleDefinition(dir)
        // meta 在组装响应时才取：编译器不可用时这里的失败与其它路径一样落进本端点的
        // `rules-failed`，而不是冒泡成 `bridge-handler-failed`（同一端点不该有两种码）。
        const meta = await ruleEditorMeta()
        tx.write(200, { ok: true, value: { rules: committed.rules, revisions: committed.revisions, meta, publicationPending: false } })
        return
      }
      const editing = record.edits !== undefined || record.activateRuleId !== undefined
      if (editing && !isRecord(record.expectedRevisions)) {
        tx.write(400, { ok: false, code: 'rules-invalid', message: '修改规则必须提供读取时的 expectedRevisions' })
        return
      }
      let createdRuleId: string | undefined
      try {
        // 动态 import 之后的写前复检：可写 + 身份都在这里再判一次（豁免不适用，写端点默认核形状）。
        if (runtime.gate(tx, 'rules').inspect(writing) === undefined) return
        const candidate = record.createRule !== undefined
          ? (() => {
            const created = createModuleRule(dir, { rule: record.createRule as unknown as RuleDefinition, ...(record.expectedRulesAbsent === true ? { expectedRulesAbsent: true } : {}) })
            createdRuleId = created.createdRuleId
            return created.snapshot
          })()
          : editing ? editModuleRules(dir, {
          expectedRevisions: record.expectedRevisions as Partial<RuleRevisions>,
          ...(record.edits === undefined ? {} : { edits: record.edits as RuleEdit[] }),
          ...(record.activateRuleId === undefined ? {} : { activateRuleId: record.activateRuleId as string }),
          ...(record.validateOnly === undefined ? {} : { validateOnly: record.validateOnly as boolean }),
        }) : isEditableModuleDir(dir) ? readModuleRules(dir) : ensureModuleSlices(dir, { writable: false })
        if (writing) {
          try { await runtime.deps.overridesChanged?.(basename(dir)) }
          catch (error) {
            tx.write(200, { ok: true, value: { rules: candidate.rules, revisions: candidate.revisions, meta: await ruleEditorMeta(), ...(createdRuleId === undefined ? {} : { createdRuleId }), persisted: true, publicationPending: true, publicationError: `规则已保存，但运行刷新失败：${String(error)}` } })
            return
          }
        }
        const result = writing ? readModuleRules(dir) : candidate
        if (writing && !isDeepStrictEqual(result.rules, candidate.rules)) {
          tx.write(409, { ok: false, code: 'rules-conflict', message: '重建期间规则再次变化；请重新读取，当前草稿仍保留' })
          return
        }
        tx.write(200, { ok: true, value: { rules: result.rules, revisions: result.revisions, meta: await ruleEditorMeta(), ...(createdRuleId === undefined ? {} : { createdRuleId }) } })
      } catch (error) {
        if (error instanceof ModuleWriteError) {
          createdRuleId ??= error.createdRuleId
          if (error.persisted) {
            const committed = loadModuleDefinition(dir)
            tx.write(200, { ok: true, value: { rules: committed.rules, revisions: committed.revisions, meta: await ruleEditorMeta(), ...(createdRuleId === undefined ? {} : { createdRuleId }), persisted: true, publicationPending: true, publicationError: error.message } })
            return
          }
          tx.write(error.status, { ok: false, code: error.code, message: error.message })
          return
        }
        if (writeLayerSettingsError(tx.write, error)) return
        tx.write(500, { ok: false, code: 'rules-failed', message: String((error as Error).message ?? error) })
      }
    } }),
  ]
}
