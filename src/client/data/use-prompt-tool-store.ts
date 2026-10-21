import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { EngineMeta, PromptConfigDraft } from '../prompt-tool-types.ts'
import type { PromptToolHostApi } from './host-api.ts'
import { bridgeCall, errorMessage } from './bridge-client.ts'
import {
  EMPTY_FIELDS,
  EMPTY_META,
  type Fields,
  type HostDefaultModel,
} from './prompt-tool-fields.ts'
import { bridgeViewFromBoot, fieldsFromView, skillFieldsFromSnapshot } from './prompt-tool-view.ts'
import { createSkillEditor } from './skill-editor.ts'
import {
  EMPTY_SWITCHES,
  shouldReloadAfterModuleSave,
  snapshotSwitches,
  switchesEqual,
  type SwitchSnapshot,
} from './dirty-state.ts'
import { instructionFileIdOf } from './prompt-config-content.ts'
import {
  applySaveOutcomes,
  EMPTY_INSTRUCTION_POOL,
  instructionSaveRequest,
  isCurrentInstructionSeq,
  isInstructionConflictCode,
  markDraftSaving,
  poolFromSnapshot,
  resetDraftFromSnapshot,
  saveableInstructionDrafts,
  setDraftContent,
  switchInstructionContext,
  unsavedInstructionDrafts,
  type InstructionDraftPool,
  type InstructionSaveOutcome,
} from './instruction-drafts.ts'
import {
  EMPTY_INSTRUCTION_POLICY_SNAPSHOT,
  instructionPolicyPatchForFile,
} from './instruction-policy.ts'
import type { InstructionPolicyFileOverride, InstructionPolicyPatch, InstructionPolicySnapshot } from '../../shared/instructions.ts'
import { projectInstructionCards } from './instruction-cards.ts'
import { createParamEditor, type ParamEditor, type ParamEditorDependencies } from './param-editor.ts'
import { createSerialTaskQueue } from './save-queue.ts'
import { createWorkspaceDrafts } from './workspace-drafts.ts'
import { createTemplateRuleWriter } from './template-rule-writer.ts'
import { createModuleActions } from './module-actions.ts'
import type { ModuleVariableRevisions, ModuleVariableScope } from '../../shared/module-variables.ts'
import { createVariablesDraft, readVariablesDraft, retryModuleVariablesPublication as retryModuleVariablesPublicationRequest, saveModuleVariables as saveModuleVariablesRequest, type VariablesDraft } from './module-variables.ts'
import { canEditModule, moduleDeclares, subjectDraftKey, MODULE_PENDING_MESSAGE, NO_SUBJECT_MESSAGE } from './module-subject.ts'
import { modulesEnabledOps } from '../../shared/module-settings.ts'
import { modelChoiceValue } from '../features/models/model-options.ts'
import type { BridgeResponse, ModelReasoningView } from '../../shared/bridge-contract.ts'
import type {
  DraftsPort,
  HostApiPort,
  InstructionFilesPort,
  ModelsPort,
  ModuleActionsPort,
  ModuleFactsPort,
  NoticePort,
  ParamsPort,
  RuleEditingPort,
  SkillsPort,
  VariablesPort,
} from './store-ports.ts'

/** 官方 ConfigForms 共享镜像传输面：标准字段共用宿主读写队列。 */
export interface PromptToolSettingsTransport {
  /** 宿主注册的 prompt-tool settings namespace 绑定。 */
  scope: ConfigForm<Record<string, unknown>>
  /** 触发一次共享 describe mirror 读取（idle 时才真正发 RPC）。 */
  ensure: () => Promise<void>
  /** 批量 path-op 写入；成功后 scope 快照已 fold 最新 revision。 */
  mutate: (ops: SettingsPathOpView[], expectedRevision?: number) => Promise<void>
}

export type SwitchKey = 'modulesEnabled'

/** 某模块的模板变量读数（类型归域模块 `module-variables.ts`，store 只是它的返回方）。 */
import type { ModuleVariablesView } from './module-variables.ts'
export type { ModuleVariablesView }

/**
 * 工作台 store 的完整类型：各**端口**的交叉（端口定义与用途见 `store-ports.ts`）。
 *
 * 这个别名只服务两类位置：编排层把整个 store 传下去，以及 `usePromptToolStore` 的返回值。
 * **新代码不要对它做 `Pick`**——需要哪几个面，就在 props 上写哪几个端口。
 */
export type PromptToolStore =
  ModuleFactsPort
  & DraftsPort
  & ParamsPort
  & VariablesPort
  & SkillsPort
  & InstructionFilesPort
  & RuleEditingPort
  & ModuleActionsPort
  & NoticePort
  & ModelsPort
  & HostApiPort


/** 等待共享 mirror 的首次应答离开 loading（ready/idle/unavailable 都会返回）。 */
function waitForScope(scope: ConfigForm<Record<string, unknown>>): Promise<ConfigFormSnapshot<Record<string, unknown>>> {
  const current = scope.getSnapshot()
  if (current.status !== 'loading') return Promise.resolve(current)
  return new Promise((resolve) => {
    let settled = false
    const dispose = scope.subscribe(() => {
      const next = scope.getSnapshot()
      if (next.status === 'loading') return
      if (settled) return
      settled = true
      dispose()
      resolve(next)
    })
    // 宿主 mirror 卡 loading 时兜底超时，避免 UI 永久 loading。
    setTimeout(() => {
      if (settled) return
      settled = true
      dispose()
      resolve(scope.getSnapshot())
    }, 5000)
  })
}

/**
 * 把文件草稿状态贴到指令文件卡上（视图元数据，不写进 module.yml）。
 * 卡片正文以草稿池为准：服务端附带的 params.text 不再是文件正文的来源。
 */

export function usePromptToolStore(api: PromptToolHostApi, settings: PromptToolSettingsTransport): PromptToolStore {
  const editorDrafts = useRef(createWorkspaceDrafts()).current
  const [modelCatalog, setModelCatalog] = useState<Record<string, string[]>>({})
  const [modelReasoning, setModelReasoning] = useState<Record<string, ModelReasoningView>>({})
  const [hostDefaultModel, setHostDefaultModel] = useState<HostDefaultModel | undefined>(undefined)
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS)
  const [meta, setMeta] = useState<EngineMeta>(EMPTY_META)
  /** meta 的 ref 镜像：写盘守卫与按主语读取在回调里执行，等下一次渲染的快照会过期。 */
  const metaRef = useRef<EngineMeta>(EMPTY_META)
  const publishMeta = useCallback((next: EngineMeta) => { metaRef.current = next; setMeta(next) }, [])
  const markModuleDeclared = useCallback((moduleId: string, section: string): void => {
    const current = metaRef.current
    const modules = current.modules
    const module = modules?.find(candidate => candidate.id === moduleId)
    if (module === undefined || modules === undefined) return
    if (module.declares?.includes(section) === true) return
    publishMeta({ ...current, modules: modules.map(candidate => candidate.id === moduleId
      ? { ...candidate, declares: [...(candidate.declares ?? []), section] }
      : candidate) })
  }, [publishMeta])
  const [savedSwitches, setSavedSwitches] = useState<SwitchSnapshot>(EMPTY_SWITCHES)

  // 池本体读 ref（`getInstructionPool` 回调式读取）；这里的 state 只承担触发重渲染。
  const [, setInstructionPool] = useState<InstructionDraftPool>(EMPTY_INSTRUCTION_POOL)
  const [instructionPolicy, setInstructionPolicy] = useState<InstructionPolicySnapshot>(EMPTY_INSTRUCTION_POLICY_SNAPSHOT)
  /** 变量范围按模块各存一份（同一模块的层卡共享）；范围变化只影响该模块的读数与草稿键。 */
  const variablesScopesRef = useRef(new Map<string, ModuleVariableScope>())
  const [, publishSubject] = useState(0)
  /** 该模块此刻是否可写（总闸 + 该模块事实）：写路径与卡片的禁用判据同源。 */
  const editableSubject = useCallback((moduleId: string): boolean =>
    canEditModule({ modulesEnabled: fieldsRef.current.modulesEnabled }, metaRef.current.modules, moduleId), [])
  /** 该模块是否在装配集合里（`/meta` 的 modules）：按主语读/写的状态只对集合内的模块落地。 */
  const assembledModule = useCallback((moduleId: string): boolean =>
    (metaRef.current.modules ?? []).some((module) => module.id === moduleId), [])
  /**
   * 声明面准入：`/meta` 明确下发该模块且不含这些节时为假——**没声明就不发这次读**
   * （发过去也是 400 `module-not-declared`）。未下发/未知一律为真：不把「读不到」当「没声明」。
   */
  const sectionDeclared = useCallback((moduleId: string, ...sections: readonly string[]): boolean =>
    moduleDeclares(metaRef.current.modules, moduleId, ...sections,
      ...(sections.includes('params') || sections.includes('layerSettings') ? ['modules', 'moduleConfigs'] : [])) !== false, [])
  /** 变量草稿只在有主语时建键：无主语返回 undefined（不建 `undefined:module` 之类的串模块键）。 */
  const variablesDraftFor = useCallback((moduleId: string | undefined, scope: ModuleVariableScope): VariablesDraft | undefined => {
    const key = subjectDraftKey(moduleId, scope)
    if (key === undefined) return undefined
    const retained = editorDrafts.variables.get(key)
    if (retained !== undefined) return retained
    const created = createVariablesDraft(scope)
    editorDrafts.variables.set(key, created)
    return created
  }, [editorDrafts])
  const [loading, setLoading] = useState(false)
  const [skillsBusy, setSkillsBusy] = useState(false)
  /**
   * 技能目录族的**状态载体**：写锁（并发守卫）、序号（陈旧应答判定）、会话（上下文一致性）同属一族。
   * 序号与会话与核心 `load` **共用**——它读序号判这次技能读是否过期、在应答落地时写会话。
   * 忙碌态 `skillsBusy` **不在载体里**：它是 state、要触发重渲染，塞进 ref 会让忙碌态不更新。
   */
  const skillCatalogRef = useRef({ seq: 0, session: undefined as string | undefined, writing: false })
  const [notice, setNotice] = useState('')
  const [noticeKind, setNoticeKind] = useState<'ok' | 'error'>('ok')
  /** 通知前导胶囊（会话名）：与 notice 同批更新，清空时一并清掉。 */
  const [noticePill, setNoticePill] = useState<string | undefined>(undefined)
  const fieldsRef = useRef<Fields>(EMPTY_FIELDS)
  /** fields 订阅者集合：patch/load 每次产生新 fields 引用时广播。
   *  shortcut: 单订阅通道（无 selector 缓存层），selector 在消费侧 useRef 缓存。 */
  const fieldsListenersRef = useRef(new Set<() => void>())
  const publishFields = useCallback((next: Fields) => {
    fieldsRef.current = next
    setFields(next)
    for (const listener of fieldsListenersRef.current) listener()
  }, [])
  const getFields = useCallback(() => fieldsRef.current, [])
  const subscribeFields = useCallback((listener: () => void) => {
    fieldsListenersRef.current.add(listener)
    return () => { fieldsListenersRef.current.delete(listener) }
  }, [])
  /** 参数草稿广播：未完成的数字输入与错误态按同一草稿键在镜像控件之间同步。
   *  草稿池是可变 Map（不触发 React 重渲染），因此写入方显式发布修订号；
   *  这是既有 subscribeFields 的同一模式，不是第二份状态或事件总线。 */
  const draftListenersRef = useRef(new Set<() => void>())
  const draftRevisionRef = useRef(0)
  const getDraftRevision = useCallback(() => draftRevisionRef.current, [])
  const publishDrafts = useCallback(() => {
    draftRevisionRef.current += 1
    for (const listener of draftListenersRef.current) listener()
  }, [])
  const subscribeDrafts = useCallback((listener: () => void) => {
    draftListenersRef.current.add(listener)
    return () => { draftListenersRef.current.delete(listener) }
  }, [])
  /** 指令文件草稿池（独立于 fields）：patch/保存/重新读取都经此发布。 */
  const instructionPoolRef = useRef<InstructionDraftPool>(EMPTY_INSTRUCTION_POOL)
  const instructionPolicyRef = useRef<InstructionPolicySnapshot>(EMPTY_INSTRUCTION_POLICY_SNAPSHOT)
  /** 服务端下发的卡壳：投影的卡片身份来源，只随快照更新，不因编辑改写。 */
  const instructionShellsRef = useRef<PromptConfigDraft[]>([])
  const instructionSeqRef = useRef(0)
  /** 上一次指令上下文对应的会话 id：变化即建立新上下文（旧草稿保留但不可写）。 */
  const instructionSessionRef = useRef<string | undefined>(undefined)
  /** 视图永远是 (壳, 池, 策略) 的投影：三份输入谁变了都调它，不再手工同步。 */
  const refreshInstructionCards = useCallback(() => {
    const current = fieldsRef.current
    publishFields({
      ...current,
      promptConfigs: projectInstructionCards(instructionShellsRef.current, instructionPoolRef.current, instructionPolicyRef.current),
    })
  }, [publishFields])
  const publishInstructions = useCallback((next: InstructionDraftPool) => {
    instructionPoolRef.current = next
    setInstructionPool(next)
    refreshInstructionCards()
  }, [refreshInstructionCards])
  const publishInstructionPolicy = useCallback((next: InstructionPolicySnapshot) => {
    instructionPolicyRef.current = next
    setInstructionPolicy(next)
    refreshInstructionCards()
  }, [refreshInstructionCards])
  const revisionRef = useRef<number | undefined>(undefined)
  const saveQueueRef = useRef(createSerialTaskQueue())
  const moduleSaveQueueRef = useRef(createSerialTaskQueue())
  const loadSeqRef = useRef(0)
  const metaSeqRef = useRef(0)
  /** 用户草稿版本：patch 时递增。load 应答返回时若版本变化，跳过覆盖，避免
   *  保存后的静默刷新吞掉用户在读取期间的编辑。 */
  const draftVersionRef = useRef(0)
  const paramEditorRef = useRef<{ editor: ParamEditor; deps: ParamEditorDependencies }>()
  const setModuleVariables = useCallback((moduleId: string, next: Record<string, string>) => {
    const draft = variablesDraftFor(moduleId, variablesScopesRef.current.get(moduleId) ?? 'module')
    if (draft === undefined) return
    draftVersionRef.current += 1
    draft.variables = next
    publishSubject(version => version + 1)
    publishDrafts()
  }, [publishDrafts, variablesDraftFor])
  const setModuleVariablesEnabled = useCallback((moduleId: string, next: boolean) => {
    if ((variablesScopesRef.current.get(moduleId) ?? 'module') !== 'module') return
    const draft = variablesDraftFor(moduleId, 'module')
    if (draft === undefined) return
    draftVersionRef.current += 1
    draft.enabled = next
    publishSubject(version => version + 1)
    publishDrafts()
  }, [publishDrafts, variablesDraftFor])
  const enqueueModuleTask = useCallback(<T,>(moduleId: string | undefined, task: () => Promise<T>): Promise<T> => moduleSaveQueueRef.current.enqueue(async () => {
    if (moduleId === undefined) throw new Error(NO_SUBJECT_MESSAGE)
    return task()
  }), [])
  const enqueueRuleTask = useCallback(<T,>(task: () => Promise<T>): Promise<T> => moduleSaveQueueRef.current.enqueue(task), [])

  const showNotice = useCallback((kind: 'ok' | 'error', message: string, pill?: string) => {
    setNotice(message)
    setNoticeKind(kind)
    setNoticePill(pill)
  }, [])

  /** 清空通知（含胶囊）：快照应用完成后调用，旧提示不跨加载常驻。 */
  const clearNotice = useCallback(() => {
    setNotice('')
    setNoticePill(undefined)
  }, [])

  const refreshVariables = useCallback(async (moduleId: string, scope: ModuleVariableScope): Promise<void> => {
    const draft = variablesDraftFor(moduleId, scope)
    if (draft === undefined) return
    if (!sectionDeclared(moduleId, 'variables', 'variablesEnabled') && scope === 'module') {
      // 声明面明确未声明：磁盘上（这个模块的作用域）没有该节，空基线就是真值，不发读。
      // 合成基线不带任何版本 → 首次保存整键不带 `expectedRevisions`（没有前状态就没有可冲突的对象），
      // 服务端写路径建立该节，真版本由写应答回填。
      // 全局作用域不受这个模块的声明面约束（读它不会 400），仍走真实读取，版本期望照旧。
      draft.baseline ??= { scope, variables: {}, enabled: true, revisions: {} as unknown as ModuleVariableRevisions }
      publishSubject(version => version + 1)
      return
    }
    const pending = readVariablesDraft(moduleId, draft, body => bridgeCall('moduleVariables', body, moduleId))
    publishSubject(version => version + 1)
    await pending
    publishSubject(version => version + 1)
    if (variablesScopesRef.current.get(moduleId) === scope && draft.error) showNotice('error', draft.error)
  }, [variablesDraftFor, sectionDeclared, showNotice])
  const ensureModuleVariables = useCallback((moduleId: string): void => {
    const scope = variablesScopesRef.current.get(moduleId) ?? 'module'
    const draft = variablesDraftFor(moduleId, scope)
    if (draft === undefined || draft.baseline !== undefined || draft.loading) return
    void refreshVariables(moduleId, scope)
  }, [refreshVariables, variablesDraftFor])
  const setModuleVariablesScope = useCallback((moduleId: string, scope: ModuleVariableScope): void => {
    if ((variablesScopesRef.current.get(moduleId) ?? 'module') === scope) return
    variablesScopesRef.current.set(moduleId, scope)
    publishSubject(version => version + 1)
    void refreshVariables(moduleId, scope)
  }, [refreshVariables])

  /** 模型目录惰性加载：独立于主 load（/describe 不再阻塞等模型查询）。 */
  /** 模型目录：默认走 10 分钟缓存；refresh=true 时请求宿主越过 TTL 重新查询。 */
  const loadModels = useCallback(async (refresh = false): Promise<void> => {
    const res = refresh ? await bridgeCall('models', { refresh: true }) : await bridgeCall('models')
    if (res.ok) setModelCatalog(res.value.modelCatalog ?? {})
  }, [])

  /** 已发起过查询的路由键：避免同一路由随每次渲染重复请求（结果无论成败都不重发）。 */
  const reasoningRequestedRef = useRef(new Set<string>())
  const ensureModelReasoning = useCallback((provider: string, model: string): void => {
    if (provider.length === 0 || model.length === 0) return
    const key = modelChoiceValue(provider, model)
    if (reasoningRequestedRef.current.has(key)) return
    reasoningRequestedRef.current.add(key)
    void (async () => {
      const res = await bridgeCall('modelReasoning', { provider, model })
      // 未查到（失败/超时/未注册）：保持「未查到」，不写入空档位，UI 不虚构选项。
      if (!res.ok) return
      setModelReasoning((previous) => ({ ...previous, [key]: res.value.reasoning }))
    })()
  }, [])

  const applyView = useCallback((res: BridgeResponse<'bootstrap'>, skillsSeq: number): Fields => {
    setModelCatalog(res.ok ? res.modelCatalog ?? {} : {})
    setHostDefaultModel(res.ok ? res.hostDefaultModel : undefined)
    const next = fieldsFromView(res)
    if (skillsSeq !== skillCatalogRef.current.seq) {
      const current = fieldsRef.current
      Object.assign(next, { skillCatalog: current.skillCatalog, skillsComplete: current.skillsComplete, skillFolders: current.skillFolders, skillsRoot: current.skillsRoot })
    }
    // 服务端快照只提供卡壳；视图由投影给出，不把服务端正文写进 fields。
    instructionShellsRef.current = next.promptConfigs
    const projected = { ...next, promptConfigs: projectInstructionCards(next.promptConfigs, instructionPoolRef.current, instructionPolicyRef.current) }
    publishFields(projected)
    setSavedSwitches(snapshotSwitches(next))
    // revision 只在首次建立，后续由 enqueueSave 的 mutate 应答维护——/bootstrap 的
    // descriptor 有 30s 服务端缓存，用其 revision 倒退会导致下一次保存 409。
    if (res.ok && revisionRef.current === undefined) revisionRef.current = res.value.revision
    return projected
  }, [])

  const load = useCallback(async (options?: { silent?: boolean }) => {
    // 并发保护：慢的旧请求不得覆盖新请求（last-good 语义保留旧数据）。
    const seq = ++loadSeqRef.current
    const metaSeq = ++metaSeqRef.current
    const skillsSeq = skillCatalogRef.current.seq
    const draftVersion = draftVersionRef.current
    const sessionId = api.currentSessionId()
    // silent：保存后静默刷新（不闪 loading、避免重渲染风暴与滚动跳动）；失败仍报错。
    if (!options?.silent) setLoading(true)
    try {
      // /bootstrap 聚合读取：meta + describe runtime facts + 实际生效配置一次取回（此前 5 端点
      // 串行，module.yml 每端点读盘解析）。**不带主语**：空主语只回全局段，模块数据由各卡按
      // 自己归属（`moduleId`）读——工作台按装配集合呈现，没有「当前模块」。
      // 带当前会话 id：服务端据此解析该本地 Agent 的工作区，返回对应指令文件快照。
      // 会话/工作区切换：建立新的指令上下文。草稿保留但旧上下文不可写，未保存的文件
      // 与版本在切换到新工作区后必须重新读取校验，防止把 A 的正文写进 B 的文件集。
      if (sessionId !== instructionSessionRef.current) {
        instructionSessionRef.current = sessionId
        // 新上下文还没有卡壳：清空后由发布链重投影，旧卡不留在视图里。
        instructionShellsRef.current = []
        publishInstructions(switchInstructionContext(instructionPoolRef.current, ++instructionSeqRef.current))
      }
      const instructionSnapshot = instructionPoolRef.current
      const policySnapshot = instructionPolicyRef.current
      const boot = await bridgeCall('bootstrap', sessionId === undefined ? {} : { sessionId })
      if (seq !== loadSeqRef.current || sessionId !== api.currentSessionId()) return EMPTY_FIELDS
      if (!boot.ok) {
        showNotice('error', '读取配置失败：' + (boot.message ?? 'bootstrap unavailable'))
        return EMPTY_FIELDS
      }
      // 模块目录事实不属于字段草稿：创建/启用后的刷新不能被无关输入拦住。
      // 契约的 meta 段只声明四项共性（层序／编辑组／层契约／官方刻度）；引擎实际下发的完整形状是
      // 客户端视图 `EngineMeta`（另含 layers／strategies／slotKinds…），按既有事实收窄一次。
      if (boot.meta !== undefined && metaSeq === metaSeqRef.current) publishMeta(boot.meta.meta as unknown as EngineMeta)
      // 两次读取都完成后才应用快照；任何 await 期间的新上下文/草稿/文件结果优先。
      const policyRes = await bridgeCall('instructionsPolicy')
      if (seq !== loadSeqRef.current || sessionId !== api.currentSessionId()) return EMPTY_FIELDS
      if (instructionPoolRef.current !== instructionSnapshot) return fieldsRef.current
      const fieldsChanged = draftVersionRef.current !== draftVersion
      // /bootstrap 已携带 settings descriptor（value/base/revision）：直接作为 fields
      // 主源，不再 await settings.ensure()——宿主全量 describe mirror 是切换模块后
      // 配置卡十几秒才出现的瓶颈。
      if (!fieldsChanged) {
        applyView(bridgeViewFromBoot(boot), skillsSeq)
        // 全局参数仍保护读取期间的新输入；指令文件上下文独立回填。
        if (boot.globalParams !== undefined) paramEditorRef.current!.editor.applyGlobal(boot.globalParams)
        if (skillsSeq === skillCatalogRef.current.seq) skillCatalogRef.current.session = sessionId
      }
      // 指令文件（独立来源）：正文、身份、版本、读取状态来自同一次读取。
      if (boot.ok && boot.instructions !== undefined) {
        publishInstructions(poolFromSnapshot(boot.instructions, ++instructionSeqRef.current, instructionPoolRef.current))
        // 切到别的工作区后，未保存草稿的文件可能已不在当前可见范围：保留草稿，但要说清楚。
        const visible = new Set(boot.instructions.files.map((file) => file.fileId))
        const stranded = unsavedInstructionDrafts(instructionPoolRef.current).filter((draft) => !visible.has(draft.fileId))
        if (stranded.length > 0) {
          showNotice('error', `有 ${stranded.length} 个未保存的指令文件草稿不在当前工作区（${stranded.map((draft) => draft.displayPath).join('、')}），已保留；切回原工作区后可继续保存`)
        }
      }
      // 指令卡策略（独立存储，默认禁用）：读失败时明确标记，UI 据此禁用策略编辑。
      const policyValue = policyRes.ok ? policyRes.value : undefined
      // 响应缺少策略快照（老宿主/异常载荷）不得当成「空策略」放开编辑。
      if (instructionPolicyRef.current === policySnapshot) publishInstructionPolicy(policyValue?.policy === undefined
        ? { ...EMPTY_INSTRUCTION_POLICY_SNAPSHOT, error: `未读取到指令策略：${policyRes.ok ? '响应缺少策略快照' : policyRes.message ?? 'settings bridge unavailable'}` }
        : {
          policy: policyValue.policy,
          revision: policyValue.revision ?? null,
          exists: policyValue.exists === true,
          ...(policyValue.error === undefined ? {} : { error: policyValue.error }),
        })
      // 实际生效配置（引擎从生成目录加载；settings.promptConfigs 仅为覆盖层，
      // 默认为空不代表无配置）。非空时以实际配置为准，并同步已保存快照避免误判 dirty。
      if (boot.ok && boot.promptConfigs !== undefined
        && Array.isArray(boot.promptConfigs.promptConfigs) && boot.promptConfigs.promptConfigs.length > 0) {
        // 引擎自动生成的模型参数配置（model-params / subagent-model-params）由
        // 「模型设置」卡片管理，不进入模块列表（避免重复编辑入口）。
        const engineGenerated = new Set(['model-params', 'subagent-model-params'])
        // 契约只保证「这是一个数组」（卡片的完整形状是客户端视图 `PromptConfigDraft`）：按既有事实收窄一次。
        const cards = boot.promptConfigs.promptConfigs as PromptConfigDraft[]
        const userConfigs = cards.filter((config) => !engineGenerated.has(config.id) && instructionFileIdOf(config) !== undefined)
        // 内容资产条目（prompt-injector / instruction-hint）：params.text（生成目录文件渲染产物）
        // 提升到 text 框显示，编辑入口统一为模块卡片。
        // 服务端下发的卡壳是投影的身份来源；正文与状态由草稿池给。
        instructionShellsRef.current = userConfigs
        refreshInstructionCards()
      }
      if (fieldsChanged) return fieldsRef.current
      paramEditorRef.current!.editor.reloadModules()
      for (const moduleId of variablesScopesRef.current.keys()) {
        if (!assembledModule(moduleId)) variablesScopesRef.current.delete(moduleId)
      }
      // 共享的模块文件同时承载参数与规则：全局重载后已加载的规则草稿重新取版本；
      // 原始字段与未保存编辑由各规则 owner 保留（owner 侧只在 loaded=false 时重读）。
      for (const rulesDraft of editorDrafts.rules.values()) {
        if (rulesDraft.loaded && rulesDraft.busy === undefined) rulesDraft.loaded = false
      }
      publishDrafts()
      const pendingPublication = [...variablesScopesRef.current].flatMap(([moduleId, scope]) => {
        const draft = variablesDraftFor(moduleId, scope)
        return draft?.error ?? draft?.baseline?.publicationError ?? []
      })[0]
      if (pendingPublication) showNotice('error', pendingPublication)
      else clearNotice()
      return fieldsRef.current
    } catch (error) {
      if (seq === loadSeqRef.current && sessionId === api.currentSessionId() && draftVersionRef.current === draftVersion) showNotice('error', '读取失败：' + errorMessage(error))
      return EMPTY_FIELDS
    } finally {
      if (seq === loadSeqRef.current && !options?.silent) setLoading(false)
    }
  }, [api, applyView, assembledModule, clearNotice, editorDrafts, publishDrafts, publishInstructionPolicy, publishInstructions, settings, showNotice, variablesDraftFor])

  // 挂载即后台拉取模型目录（不阻塞工作台首屏；10min 缓存兜底重复打开）。
  useEffect(() => {
    void loadModels()
  }, [loadModels])

  // 会话 id 晚于工作台首次打开就绪时（页面加载、会话恢复）补一次加载。
  // ui-session 的作用域绑定要等主视图 retain 该会话之后才有值（官方 publishMain
  // 以 retainedBy.mainView > 0 为准），否则首屏会一直停在「只有全局文件」的范围，
  // 直到用户关掉工作台重开。
  useEffect(() => api.subscribeSessionChange(() => { void load() }), [api, load])

  // 目录就绪后补查当前会话与宿主默认路由的推理档位。
  // 只查这几条可见路由：不遍历整个目录，也不把目录当授权白名单。
  useEffect(() => {
    reasoningRequestedRef.current.clear()
    const face = api.sessionModel.snapshot()
    const sessionSelection = face.selection
    const routes: Array<{ provider?: string; model?: string }> = [
      { provider: sessionSelection?.provider, model: sessionSelection?.model },
      { provider: hostDefaultModel?.provider, model: hostDefaultModel?.model },
    ]
    for (const route of routes) {
      if (route.provider !== undefined && route.model !== undefined) {
        ensureModelReasoning(route.provider, route.model)
      }
    }
  }, [api, ensureModelReasoning, hostDefaultModel?.model, hostDefaultModel?.provider, modelCatalog])

  const refreshRevision = useCallback(async () => {
    try {
      await settings.ensure()
      const snapshot = await waitForScope(settings.scope)
      if (snapshot.revision !== undefined) revisionRef.current = snapshot.revision
    } catch {
      // 刷新失败保持原 revision，用户可重试。
    }
  }, [settings])

  const patch = useCallback((partial: Partial<Fields>) => {
    draftVersionRef.current += 1
    // 文件卡正文是草稿池的输入：只镜像正文，视图由投影给出，卡壳不因编辑改写。
    const { promptConfigs: patchedConfigs, ...rest } = partial
    if (Array.isArray(patchedConfigs)) {
      let pool = instructionPoolRef.current
      for (const config of patchedConfigs) {
        const fileId = instructionFileIdOf(config)
        if (fileId === undefined || typeof config.text !== 'string') continue
        const draft = pool.drafts.find((entry) => entry.fileId === fileId)
        if (draft === undefined || draft.content === config.text) continue
        pool = setDraftContent(pool, fileId, config.text)
      }
      if (pool !== instructionPoolRef.current) publishInstructions(pool)
    }
    // 发布链之后 fieldsRef 已是新投影，其余字段以它为基合并。
    let next: Fields = { ...fieldsRef.current, ...rest }
    // complete 互斥：官方 complete 段一个 scope 只能有一个，开启任一 enabled 配置的
    // complete 时自动关闭其他 enabled 配置的 complete。disabled 配置不参与（引擎
    // effectiveList 已过滤，不注册即不独占；重新启用时由本次收敛）。顶层人设的
    // complete 不在本数组内，跨层冲突由 settings bridge 写盘前 fail loud。
    if (Array.isArray(next.promptConfigs)) {
      const activeComplete = (config: PromptConfigDraft): boolean => config.enabled !== false && config.params?.complete === true
      const enabledComplete = next.promptConfigs.some(activeComplete)
      if (enabledComplete) {
        const kept = next.promptConfigs.findIndex(activeComplete)
        next = {
          ...next,
          promptConfigs: next.promptConfigs.map((config, index) =>
            index === kept || config.enabled === false
              ? config
              : { ...config, params: { ...config.params, complete: false } }),
        }
      }
    }
    publishFields(next)
  }, [publishFields, publishInstructions])

  const enqueueSave = useCallback((ops: SettingsPathOpView[], okMessage: string | undefined, onSaved: () => void, setBusy?: (busy: boolean) => void): Promise<boolean> => {
    setBusy?.(true)
    return saveQueueRef.current.enqueue(async () => {
      try {
        await settings.mutate(ops, revisionRef.current)
        revisionRef.current = settings.scope.getSnapshot().revision
        onSaved()
        if (okMessage) showNotice('ok', okMessage)
        return true
      } catch (error) {
        // settings 注册重建（fiber reload）会把 namespace revision 归零，客户端
        // 持有的版本号随即过期：冲突时重试一次不带 expectedRevision（官方语义 =
        // 不检查并发，last-write-wins），全局开关不会再被过期版本号卡死。
        const message = errorMessage(error)
        if (/expected revision|changed since it was read/i.test(message)) {
          try {
            await settings.mutate(ops)
            revisionRef.current = settings.scope.getSnapshot().revision
            onSaved()
            if (okMessage) showNotice('ok', okMessage)
            return true
          } catch (retryError) {
            await refreshRevision()
            showNotice('error', '保存失败：' + errorMessage(retryError) + '（已刷新配置版本，可重试）')
          }
        } else {
          await refreshRevision()
          showNotice('error', '保存失败：' + message + '（已刷新配置版本，可重试）')
        }
        return false
      } finally {
        setBusy?.(false)
      }
    })
  }, [refreshRevision, settings, showNotice])

  /** 已保存开关快照的 ref 镜像：离开前保存要判断「真的脏吗」，而渲染期的 state 在闭包里会过期。 */
  const savedSwitchesRef = useRef(savedSwitches)
  savedSwitchesRef.current = savedSwitches

  /** 全局开关保存：技能状态已不进 settings（调用策略直接写技能文件，走自己的端点）。 */
  const persistSwitches = useCallback((onSaved?: () => void): Promise<boolean> => {
    const savedSnapshot = snapshotSwitches(fieldsRef.current)
    return enqueueSave(
      modulesEnabledOps(fieldsRef.current.modulesEnabled),
      undefined,
      () => {
        setSavedSwitches(savedSnapshot)
        onSaved?.()
      },
    )
  }, [enqueueSave])

  const paramDeps: ParamEditorDependencies = {
    isPresent: assembledModule,
    declares: moduleId => sectionDeclared(moduleId, 'params', 'layerSettings'),
    canEdit: editableSubject,
    globalEnabled: () => fieldsRef.current.modulesEnabled,
    hasRawDraft: moduleId => [...editorDrafts.fields].some(([key, field]) => key.startsWith(moduleId + ':param:') && (field.text !== field.source || field.error !== '')),
    enqueue: task => moduleSaveQueueRef.current.enqueue(task),
    changed: () => publishSubject(version => version + 1),
    edited: () => {
      draftVersionRef.current += 1
      publishSubject(version => version + 1)
      publishDrafts()
    },
    showNotice,
    prepareRefresh: scope => {
      if (scope === 'global') return async () => { await load({ silent: true }) }
      const draftVersion = draftVersionRef.current
      const configsWereClean = unsavedInstructionDrafts(instructionPoolRef.current).length === 0
      return async () => {
        if (shouldReloadAfterModuleSave(draftVersion, draftVersionRef.current, configsWereClean)) await load({ silent: true })
      }
    },
  }
  // 实例跨渲染保留参数状态；接线更新以捕获本次渲染的 load 与保存基线。
  if (paramEditorRef.current === undefined) paramEditorRef.current = { editor: createParamEditor(paramDeps), deps: paramDeps }
  else Object.assign(paramEditorRef.current.deps, paramDeps)
  const paramEditor = paramEditorRef.current.editor

  /**
   * 指令文件显式保存：只提交「已改动 + 读取就绪 + 有基线版本 + 上下文匹配」的文件。
   * 逐文件结果；失败与冲突都保留草稿，不触发模块重建，也不重载覆盖用户输入。
   */
  const persistInstructionFiles = useCallback(async (fileIds?: readonly string[]): Promise<boolean> => {
    const pool = instructionPoolRef.current
    const pending = unsavedInstructionDrafts(pool).filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
    if (pending.length === 0) return true
    const targets = saveableInstructionDrafts(pool)
      .filter((draft) => fileIds === undefined || fileIds.includes(draft.fileId))
    const sessionId = api.currentSessionId()
    const isCurrent = (): boolean => isCurrentInstructionSeq(instructionPoolRef.current, pool.latest)
      && instructionPoolRef.current.contextId === pool.contextId
      && sessionId === api.currentSessionId() && sessionId === instructionSessionRef.current
    if (!isCurrent()) return false
    const requests = new Map(targets.flatMap((draft) => {
      const request = instructionSaveRequest(instructionPoolRef.current, draft.fileId, sessionId)
      return request === undefined ? [] : [[draft.fileId, request] as const]
    }))
    for (const fileId of requests.keys()) {
      const saving = markDraftSaving(instructionPoolRef.current, fileId, true)
      publishInstructions(saving)
    }
    const results: InstructionSaveOutcome[] = pending.filter((draft) => !requests.has(draft.fileId)).map((draft) => ({
      fileId: draft.fileId, ok: false, message: draft.error ?? draft.message ?? '文件尚不可写、存在冲突或正在保存',
    }))
    for (const [fileId, request] of requests) {
      // 每次发送前和应答后都复核；切换工作区后不能继续提交批次中的旧文件。
      if (!isCurrent()) return false
      const current = instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)
      if (current?.saving !== true || current.revision !== request.expectedRevision || current.contextId !== request.contextId) {
        results.push({ fileId, ok: false, message: '文件已重新读取，本次旧草稿未继续保存' })
        continue
      }
      const res = await bridgeCall('agentsFile', request)
      if (!isCurrent()) return false
      const latest = instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)
      if (latest?.saving !== true || latest.revision !== request.expectedRevision || latest.contextId !== request.contextId) {
        results.push({ fileId, ok: false, message: '文件已重新读取，迟到保存结果未应用' })
        continue
      }
      const result: InstructionSaveOutcome = res.ok && typeof res.value.revision === 'string'
        ? { fileId, ok: true, revision: res.value.revision }
        : { fileId, ok: false, message: res.ok ? '保存响应缺少文件版本' : res.message ?? '写盘失败', conflict: !res.ok && isInstructionConflictCode(res.code) }
      results.push(result)
      // 已成功的文件立即确认；后续文件失败或切换上下文也不丢失成功基线。
      const settled = applySaveOutcomes(instructionPoolRef.current, [result], requests)
      publishInstructions(settled)
    }
    const failures = results.filter((result) => !result.ok)
    if (failures.length > 0) {
      const label = (fileId: string): string => instructionPoolRef.current.drafts.find((draft) => draft.fileId === fileId)?.displayPath ?? fileId
      showNotice('error', `指令文件保存失败（${failures.length}/${results.length}）：${failures.map((failure) => `${label(failure.fileId)}：${failure.message ?? '未知错误'}`).join('；')}`)
      return false
    }
    showNotice('ok', `已保存指令文件：${results.length} 个`)
    return true
  }, [api, publishInstructions, showNotice])

  /**
   * 写单个文件的开关与显示名（独立于模块）。
   * 带读取时 revision 的乐观并发；失败保留快照并提示，不偷偷改本地状态。
   */
  const persistInstructionPolicy = useCallback((policy: InstructionPolicyPatch): Promise<boolean> => saveQueueRef.current.enqueue(async () => {
    const current = instructionPolicyRef.current
    if (current.error !== undefined) {
      showNotice('error', `指令策略不可写：${current.error}`)
      return false
    }
    const res = await bridgeCall('instructionsPolicy', {
      policy,
      expectedRevision: current.revision,
    })
    if (instructionPolicyRef.current !== current) return false
    if (!res.ok || res.value.policy === undefined || res.value.error !== undefined) {
      showNotice('error', '指令策略保存失败：' + (res.ok ? res.value.error ?? '响应缺少策略快照' : res.message ?? 'settings bridge unavailable'))
      return false
    }
    publishInstructionPolicy({ policy: res.value.policy, revision: res.value.revision, exists: res.value.exists })
    showNotice('ok', '指令策略已保存（影响后续注入，不撤回已进入会话的内容）')
    return true
  }), [publishInstructionPolicy, showNotice])

  const updateInstructionPolicy = useCallback((fileId: string, override: InstructionPolicyFileOverride | null): Promise<boolean> => (
    persistInstructionPolicy(instructionPolicyPatchForFile(fileId, override))
  ), [persistInstructionPolicy])

  /** 冲突处理：重新读取单个文件并丢弃本地草稿（不自动重载，避免悄悄覆盖用户输入）。 */
  const reloadInstructionFile = useCallback(async (fileId: string): Promise<void> => {
    const sessionId = api.currentSessionId()
    const pool = instructionPoolRef.current
    const draft = pool.drafts.find((entry) => entry.fileId === fileId)
    if (pool.contextId === null || draft?.contextId !== pool.contextId || sessionId !== instructionSessionRef.current) return
    const res = await bridgeCall('promptConfigs', sessionId === undefined ? {} : { sessionId })
    if (sessionId !== api.currentSessionId() || !isCurrentInstructionSeq(instructionPoolRef.current, pool.latest)
      || instructionPoolRef.current.contextId !== pool.contextId) return
    if (instructionPoolRef.current.drafts.find((entry) => entry.fileId === fileId) !== draft) {
      showNotice('error', '重新读取期间文件草稿已更新，本次读取未覆盖新草稿')
      return
    }
    if (!res.ok || res.value.instructions === undefined) {
      showNotice('error', `重新读取指令文件失败：${res.ok ? '未返回指令文件快照' : res.message ?? 'settings bridge unavailable'}`)
      return
    }
    if (res.value.instructions.context.contextId !== pool.contextId) {
      showNotice('error', '指令文件上下文已变化，本次读取未应用；请重新加载工作台')
      return
    }
    const file = res.value.instructions.files.find((entry) => entry.fileId === fileId)
    if (file === undefined) {
      showNotice('error', '该指令文件不在当前工作区范围内，本地草稿已保留但不可写')
      return
    }
    const reset = resetDraftFromSnapshot(instructionPoolRef.current, file)
    publishInstructions(reset)
    showNotice('ok', `已重新读取指令文件：${file.displayPath}`)
  }, [api, publishInstructions, showNotice])

  /** 每个模块/范围保留独立草稿（主语＝调用方给的模块 id）；响应只确认请求时捕获的值。 */
  const saveModuleVariables = useCallback(async (moduleId: string, next?: Record<string, string>, enabledOverride?: boolean): Promise<boolean> => {
    if (!editableSubject(moduleId)) {
      showNotice('error', NO_SUBJECT_MESSAGE)
      return false
    }
    const scope = variablesScopesRef.current.get(moduleId) ?? 'module'
    const draft = variablesDraftFor(moduleId, scope)
    if (draft === undefined) {
      showNotice('error', NO_SUBJECT_MESSAGE)
      return false
    }
    if (draft.baseline === undefined) {
      showNotice('error', MODULE_PENDING_MESSAGE)
      return false
    }
    const previousValues = draft.variables
    const desired = { variables: { ...(next ?? draft.variables) }, enabled: enabledOverride ?? draft.enabled }
    return enqueueModuleTask(moduleId, async () => {
      const baseline = draft.baseline
      if (!baseline) throw new Error(MODULE_PENDING_MESSAGE)
      draft.saving = true
      publishSubject(version => version + 1)
      try {
        const res = await saveModuleVariablesRequest(moduleId, baseline, desired, body => bridgeCall('moduleVariables', body, moduleId))
        draft.baseline = res.baseline
        if (next !== undefined && draft.variables === previousValues) draft.variables = { ...next }
        draft.error = res.publicationError ?? ''
        if ((variablesScopesRef.current.get(moduleId) ?? 'module') === scope) showNotice(res.publicationError ? 'error' : 'ok', res.publicationError ?? '变量已保存')
        return !res.publicationError
      } finally { draft.saving = false; publishSubject(version => version + 1); publishDrafts() }
    }).catch(error => {
      draft.error = errorMessage(error)
      if ((variablesScopesRef.current.get(moduleId) ?? 'module') === scope) showNotice('error', draft.error)
      return false
    })
  }, [editableSubject, enqueueModuleTask, publishDrafts, showNotice, variablesDraftFor])

  const retryModuleVariablesPublication = useCallback(async (moduleId: string): Promise<boolean> => {
    if (!editableSubject(moduleId)) {
      showNotice('error', NO_SUBJECT_MESSAGE)
      return false
    }
    const scope = variablesScopesRef.current.get(moduleId) ?? 'module'
    const draft = variablesDraftFor(moduleId, scope)
    if (draft === undefined) return false
    return enqueueModuleTask(moduleId, async () => {
      if (!draft.baseline?.publicationPending) {
        await refreshVariables(moduleId, scope)
        return !draft.error
      }
      const result = await retryModuleVariablesPublicationRequest(moduleId, draft.baseline, body => bridgeCall('moduleVariables', body, moduleId))
      draft.baseline = result.baseline
      draft.error = result.publicationError ?? ''
      publishSubject(version => version + 1)
      if ((variablesScopesRef.current.get(moduleId) ?? 'module') === scope) showNotice(result.publicationError ? 'error' : 'ok', result.publicationError ?? '变量发布已完成')
      return !result.publicationError
    }).catch(error => { showNotice('error', errorMessage(error)); return false })
  }, [editableSubject, enqueueModuleTask, refreshVariables, showNotice, variablesDraftFor])

  /** 某模块的模板变量读数：层卡按归属取它（值、开关、范围与状态都随主语）。 */
  const moduleVariables = useCallback((moduleId: string): ModuleVariablesView => {
    const scope = variablesScopesRef.current.get(moduleId) ?? 'module'
    const draft = variablesDraftFor(moduleId, scope)
    return {
      scope,
      values: draft?.variables ?? {},
      inherited: draft?.snapshot?.global ?? {},
      enabled: draft?.enabled ?? true,
      loading: draft === undefined ? false : draft.loading || draft.baseline === undefined,
      error: draft?.error ?? '',
      publicationPending: draft?.baseline?.publicationPending === true,
    }
  }, [variablesDraftFor])

  /** 总闸只有一个方向：关闭/开启会重建或移除生成目录，保存后必须重新加载，否则模块卡片仍显示旧配置。 */
  const toggle = useCallback(() => {
    patch({ modulesEnabled: !fieldsRef.current.modulesEnabled })
    void persistSwitches(() => { void load({ silent: true }) })
  }, [patch, persistSwitches, load])

  /** 能力变更的主语＝调用方给的模块 id；与参数保存共用模块队列。 */
  const changeModuleCapability = useCallback((moduleId: string, action: 'create' | 'create-recipe' | 'remove', id: string): Promise<boolean> => {
    if (!editableSubject(moduleId)) {
      showNotice('error', NO_SUBJECT_MESSAGE)
      return Promise.resolve(false)
    }
    return moduleSaveQueueRef.current.enqueue(async () => {
      const request = action === 'create-recipe' ? { action, recipeId: id } : { action, capabilityId: id }
      const result = await bridgeCall('moduleCapability', { ...request, expectedModuleId: moduleId }, moduleId)
      if (!result.ok) {
        showNotice('error', '引擎能力变更失败：' + (result.message ?? 'settings bridge unavailable'))
        return false
      }
      await load({ silent: true })
      showNotice('ok', action === 'remove' ? `已移除引擎能力：${id}` : `已装配引擎能力：${id}`)
      return true
    })
  }, [editableSubject, load, showNotice])
  const createModuleCapability = useCallback((moduleId: string, action: 'create' | 'create-recipe', id: string) => changeModuleCapability(moduleId, action, id), [changeModuleCapability])
  const removeModuleCapability = useCallback((moduleId: string, id: string) => changeModuleCapability(moduleId, 'remove', id), [changeModuleCapability])

  /** 模块操作只刷新目录事实和规则版本，不覆盖总闸、指令或参数的未保存输入。 */
  const refreshModules = useCallback(async (): Promise<boolean> => {
    const seq = ++metaSeqRef.current
    const result = await bridgeCall('meta')
    if (seq !== metaSeqRef.current || !result.ok) return false
    publishMeta({ ...metaRef.current, ...result.value.meta })
    paramEditor.refreshModules()
    for (const draft of editorDrafts.rules.values()) if (draft.loaded && draft.busy === undefined) draft.loaded = false
    publishDrafts()
    return true
  }, [editorDrafts, paramEditor, publishMeta, publishDrafts])
  const [moduleActions] = useState(() => createModuleActions({ enqueue: enqueueRuleTask, refresh: refreshModules }))
  /** 新建只复制定义、保持关闭；id 与刷新结果由模块操作返回。 */
  const createModule = useCallback((): Promise<string | undefined> => {
    return moduleActions.create().then(result => {
      if (!result.ok) { showNotice('error', result.message ?? '新建模块失败'); return undefined }
      if (result.refreshError !== undefined) showNotice('error', '模块已创建，但列表刷新失败；请重新打开工作台，不要重复创建。')
      return result.value.id
    })
  }, [moduleActions, showNotice])
  const templateWriter = useRef<ReturnType<typeof createTemplateRuleWriter>>()
  templateWriter.current ??= createTemplateRuleWriter({
    drafts: editorDrafts, modules: () => metaRef.current.modules, changed: publishDrafts, markDeclared: markModuleDeclared,
    enqueue: enqueueRuleTask, actions: moduleActions,
  })

  /**
   * 技能目录与写入 owner：110 行实现搬进 `skill-editor.ts`，这里只做组装与转发。
   * 依赖都是稳定的（ref / state setter / useCallback），所以只建一次。
   */
  const skillEditorRef = useRef<ReturnType<typeof createSkillEditor>>()
  const skillEditor = (skillEditorRef.current ??= createSkillEditor({
    state: skillCatalogRef,
    currentSessionId: () => api.currentSessionId(),
    publishSkills: (snapshot) => publishFields({ ...fieldsRef.current, ...skillFieldsFromSnapshot(snapshot) }),
    setBusy: setSkillsBusy,
    skillsRoot: () => fieldsRef.current.skillsRoot ?? '',
    showNotice,
    openPath: (path) => api.openPath(path),
  }))

  const currentSwitches = snapshotSwitches(fields)
  const dirtySwitches = !switchesEqual(currentSwitches, savedSwitches)


  /**
   * 离开前保存：只做「判断 → 调已有 persist」，不新写保存逻辑。
   *
   * 开关先比实时快照（脏了才发请求，避免每次关抽屉都空写一次）；指令文件直接交给
   * `persistInstructionFiles` 自己过滤（它的契约就是只提交已改动、可写、上下文匹配的文件）。
   * 失败只报一次并保留脏标记（`savedSwitches` 没被更新、文件草稿仍脏），**不阻断离开**。
   */
  const persistBeforeLeave = useCallback(async (): Promise<boolean> => {
    let ok = true
    if (!switchesEqual(snapshotSwitches(fieldsRef.current), savedSwitchesRef.current)) ok = await persistSwitches()
    if (!await persistInstructionFiles()) ok = false
    if (!ok) showNotice('error', '离开前保存未完成：草稿仍在本地，请检查后重试')
    return ok
  }, [persistSwitches, persistInstructionFiles, showNotice])

  // 返回引用稳定化：memo 子组件以 props.store 同一性跳过父级重渲染（订阅式 selector
  // 化依赖稳定 store 引用）；每次渲染重建内容对象但复用 ref 外壳。
  const storeRef = useRef<PromptToolStore>()
  storeRef.current = {
    editorDrafts,
    api,
    fields,
    getFields,
    subscribeFields,
    getDraftRevision,
    subscribeDrafts,
    publishDrafts,
    meta,
    loading,
    modelCatalog,
    modelReasoning,
    hostDefaultModel,
    getInstructionPool: () => instructionPoolRef.current,
    persistInstructionFiles,
    persistBeforeLeave,
    reloadInstructionFile,
    instructionPolicy,
    updateInstructionPolicy,
    skillsBusy,
    notice,
    noticeKind,
    noticePill,
    load,
    showNotice,
    patch,
    persistSwitches,
    persistParamOverrides: paramEditor.persistParamOverrides,
    moduleParamsOf: paramEditor.moduleParamsOf,
    ensureModuleParams: paramEditor.ensureModuleParams,
    setModuleParam: paramEditor.setModuleParam,
    // 全局层读数读 ref（与 `moduleParamsOf` 同形）：SSR 下没有二次渲染，state 快照会停在旧值。
    get globalParams() { return paramEditor.globalParams },
    get globalParamsLoaded() { return paramEditor.globalParamsLoaded },
    setGlobalParam: paramEditor.setGlobalParam,
    persistGlobalParams: paramEditor.persistGlobalParams,
    enqueueRuleTask,
    moduleVariables,
    ensureModuleVariables,
    setModuleVariablesScope,
    setModuleVariables,
    setModuleVariablesEnabled,
    saveModuleVariables,
    retryModuleVariablesPublication,
    toggle,
    createModuleCapability,
    removeModuleCapability,
    createModule,
    moduleActions,
    createTemplateRule: templateWriter.current,
    ...skillEditor,
    dirtySwitches,
  }
  return storeRef.current
}
