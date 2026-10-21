/** 模板库加载与插入：两页共用，顶部注入模板与层内工具按钮分别提供真实锚点。 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptConfigTemplateEntry } from '../../prompt-tool-types.ts'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { DraftsPort, ModuleActionsPort, NoticePort, RuleEditingPort } from '../../data/store-ports.ts'
import { BLANK_MODULE_TEMPLATE } from '../../data/module-subject.ts'
import { EngineModuleActions, type ModuleCreateItem } from '../modules/EngineModuleList.tsx'
import { insertToolTemplateIntoDraft } from '../../data/tools-editor.ts'
import { TemplatePicker, TemplateTargetPicker, type TemplateTargetListEntry } from '../../ui/TemplatePicker.tsx'

/** 自定义工具模板条目：与提示词模板同一次 /templates 返回。 */
export type ToolTemplateEntry = { file: string; spec: Record<string, unknown> }

type PendingTemplate = { intentId: number; entry: PromptConfigTemplateEntry }

/** 列表作用域：决定新建配置的消息受众代入方向（过滤状态一律不动）。 */
export type TemplatePickerScope = 'main' | 'subagent'

/** 选完模板后的**唯一**追加步骤：目标模块（已存在模块 / 新建空白模块）。 */
export interface TemplatePickerTarget {
  /** 已存在模块的 id，或「新建空白模块」返回的新模块 id。 */
  moduleId: string
  newlyCreated?: boolean
}

/**
 * 由模板条目派生一条新配置草稿（纯函数：不改动任何过滤/展开状态）。
 *
 * 规则：
 * 1. id 与模板重复时追加 `-2`、`-3`… 后缀，且同名 identity 跟随新 id；
 * 2. 受众按列表作用域代入——子代理列表 → 仅子代理；主会话列表 → 清除模板自带的
 *    「仅子代理」限制（缺省 = 公用，两侧都可见），从而"新建即可见"。
 *
 * @param entry - 模板条目（来自 `/templates`）。
 * @param configs - 当前列表已有配置，用于 id 去重。
 * @param scope - 列表作用域；不传则不改动模板自带受众。
 * @returns 可直接追加进列表的新配置草稿。
 */
export function createConfigFromTemplate(
  entry: PromptConfigTemplateEntry,
  configs: readonly RuleDefinition[],
  scope?: TemplatePickerScope,
): RuleDefinition {
  const clone = structuredClone(entry.spec)
  let suffix = 2
  while (configs.some((config) => config.id === clone.id)) clone.id = `${entry.spec.id}-${suffix++}`
  clone.enabled = false
  clone.then = clone.then.map(action => {
    if (action.kind !== 'inject-text') return action
    const config = action.config !== null && typeof action.config === 'object' && !Array.isArray(action.config) ? action.config as Record<string, unknown> : {}
    const { id: _sourceId, ...content } = config
    return { ...action, config: { ...content, ...(scope === 'subagent' ? { audience: 'subagent' } : scope === 'main' && config.audience === 'subagent' ? { audience: null } : {}) } }
  })
  return clone
}

/**
 * 模板库加载 + 「选完模板只加一步选目标」两段式（T18 页级创建的唯一形态）：
 * `pickTemplate` 只记下模板并打开目标选择，`confirmTarget` 才按**目标模块自己的配置**去重派生草稿
 * 并连同显式主语回调（id 去重不能用工作区全集，否则别的模块的同名 id 会给新卡误加后缀）。
 * 成功提示不在这里发：它只该在内容真的写进目标模块之后出现（见 `applyCreateWrite`）。
 */
export function useTemplatePicker(
  onPickConfig: (config: RuleDefinition, target: TemplatePickerTarget, file: string) => void,
  onNotice: (kind: 'ok' | 'error', message: string) => void,
  t: PromptToolTranslate,
  /** 传入列表作用域时，新建配置代入该受众，保证"新建即可见"；不传 = 不改动模板受众。 */
  scope?: TemplatePickerScope,
): {
  anchorRef: RefObject<HTMLButtonElement>
  popoverAnchorRef: RefObject<HTMLButtonElement>
  templates: PromptConfigTemplateEntry[]
  toolTemplates: ToolTemplateEntry[]
  open: boolean
  /** 目标选择步骤是否打开。 */
  targetOpen: boolean
  /** 当前目标选择意图；异步新建模块完成后只允许仍属当前意图的回调提交。 */
  targetIntentId: number
  /** 当前浮层的插入点层级过滤；undefined 表示按层分组展示全部模板。 */
  layer: string | undefined
  /** 只展示工具模板（菜单「添加工具模板」入口）。 */
  toolsOnly: boolean
  createdConfigId: string | undefined
  /** 打开模板浮层；传入插入点层级时只列该层模板（无分组标题）。 */
  openPicker: (layer?: string, anchor?: HTMLButtonElement) => void
  /** 打开只含工具模板的浮层。 */
  openTools: (anchor: HTMLButtonElement) => void
  closePicker: () => void
  pickTemplate: (entry: PromptConfigTemplateEntry) => void
  /** 确认目标模块：按目标模块自己的配置去重派生草稿，连同显式主语交回调用方。 */
  confirmTarget: (target: TemplatePickerTarget, configsAtTarget?: readonly RuleDefinition[], expectedIntentId?: number) => void
  /** 放弃这次创建：关闭目标选择并丢掉待写入的模板。 */
  cancelTarget: () => void
} {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [toolTemplates, setToolTemplates] = useState<ToolTemplateEntry[]>([])
  const [open, setOpen] = useState(false)
  const [targetOpen, setTargetOpen] = useState(false)
  const pendingEntry = useRef<PendingTemplate>()
  const targetIntentRef = useRef(0)
  useEffect(() => () => { targetIntentRef.current++ }, [scope])
  const [layer, setLayer] = useState<string | undefined>(undefined)
  const [toolsOnly, setToolsOnly] = useState(false)
  const [createdConfigId, setCreatedConfigId] = useState<string>()

  const loadTemplates = async (): Promise<void> => {
    if (templates.length > 0) return
    try {
      const res = await bridgeCall('templates')
      if (!res.ok) {
        onNotice('error', t('templates.loadFailed', { reason: res.message ?? 'settings bridge unavailable' }))
        return
      }
      if (!Array.isArray(res.value.templates)) {
        onNotice('error', t('templates.emptyList'))
        return
      }
      setTemplates(res.value.templates as PromptConfigTemplateEntry[])
      setToolTemplates((res.value.toolTemplates ?? []) as ToolTemplateEntry[])
    } catch (error) {
      onNotice('error', t('templates.loadFailed', { reason: errorMessage(error) }))
    }
  }

  const openPicker = (target?: string, anchor?: HTMLButtonElement): void => {
    // 锚点优先级：菜单按钮（页级下拉）> 常驻按钮 ref。
    popoverAnchorRef.current = anchor ?? anchorRef.current
    setLayer(target)
    setToolsOnly(false)
    setOpen(true)
    void loadTemplates()
  }

  const openTools = (anchor: HTMLButtonElement): void => {
    popoverAnchorRef.current = anchor
    anchor.focus()
    setLayer(undefined)
    setToolsOnly(true)
    setOpen(true)
    void loadTemplates()
  }

  const closePicker = (): void => setOpen(false)

  const pickTemplate = (entry: PromptConfigTemplateEntry): void => {
    setOpen(false)
    // 目标未定：只记下模板，等用户选完目标（唯一的那一步）再按目标模块去重派生草稿。
    const intentId = ++targetIntentRef.current
    pendingEntry.current = { intentId, entry }
    setTargetOpen(true)
  }

  const confirmTarget = (target: TemplatePickerTarget, configsAtTarget?: readonly RuleDefinition[], expectedIntentId?: number): void => {
    const pending = pendingEntry.current
    if (pending === undefined) return
    if (expectedIntentId !== undefined && (expectedIntentId !== targetIntentRef.current || expectedIntentId !== pending.intentId)) return
    const { entry } = pending
    pendingEntry.current = undefined
    setTargetOpen(false)
    // 去重集合＝目标模块自己的配置：其它模块有同名 id 不影响写进这个模块。
    const clone = createConfigFromTemplate(entry, configsAtTarget ?? [], scope)
    setCreatedConfigId(clone.id)
    // 只交回「写什么、写进谁」；成功与否（以及那时的提示）由调用方按实际写入结果决定。
    onPickConfig(clone, target, entry.file)
  }

  const cancelTarget = (): void => { pendingEntry.current = undefined; targetIntentRef.current++; setTargetOpen(false) }

  return { anchorRef, popoverAnchorRef, templates, toolTemplates, open, targetOpen, targetIntentId: targetIntentRef.current, layer, toolsOnly, createdConfigId, openPicker, openTools, closePicker, pickTemplate, confirmTarget, cancelTarget }
}

/**
 * 页级创建编排：页级「添加」下拉 → 注入模板浮层 → **只加一步**选目标 → 写入所选模块。
 *
 * 两次受众页（主会话 / 子代理）共用这一份编排，视图差异只在调用方传进来的 `items`、`scope`
 * 与 `targets`；「主语」始终来自目标选择那一步，不存在任何全局「当前模块」。
 *
 * 写入只以显式 moduleId 为主语，服务端在目标模块锁内按规则 id 分配后缀；规则卡 owner
 * 只负责成功后的展示刷新，不是创建前置。这样未启用模块与空白模块都能直接接收首条模板。
 */
export function useTemplateCreate(props: {
  store: RuleEditingPort & NoticePort & DraftsPort & ModuleActionsPort
  t: PromptToolTranslate
  /** 菜单项：注入模板的层清单（id 形如 `tpl:<layer>`）。 */
  items: readonly ModuleCreateItem[]
  scope: TemplatePickerScope
  /** 目标选择的候选：只列可写模块，包含未启用模块。 */
  targets: readonly TemplateTargetListEntry[]
  /** 已存在的模块目录 id 全集（含未启用）：只影响新建 id 预览（种子化的空白模板默认未启用）。 */
  existingIds: readonly string[]
  /** 创建成功后展开新卡（主语＝所选目标模块）。 */
  onCreated: (moduleId: string, configKey: string) => void
}): {
  toolbar: ReactNode
  dialogs: ReactNode
  /** 卡内「添加工具模板…」入口：主语＝**该卡所属模块**（工具模板不进目标选择那一步）。 */
  openToolsForModule: (moduleId: string, anchor: HTMLButtonElement) => void
} {
  const { store, t, items, scope, targets, existingIds, onCreated } = props
  /** 卡内工具模板入口打开时记下主权模块：点选模板后要落进它的工具草稿。 */
  const toolModule = useRef<string>()
  const writeGeneration = useRef(0)
  useEffect(() => () => { writeGeneration.current++ }, [scope])
  const writeInto = useCallback(async (target: TemplatePickerTarget, config: RuleDefinition, file: string): Promise<void> => {
    const { moduleId } = target
    const generation = writeGeneration.current
    const result = await store.createTemplateRule(moduleId, config, target.newlyCreated)
    if (!result.ok) {
      if (writeGeneration.current !== generation) return
      store.showNotice('error', `${t('rules.create.failed')}（moduleId=${moduleId}）`)
      return
    }
    const createdRuleId = result.value.createdRuleId ?? config.id
    if (writeGeneration.current !== generation) return
    if (!result.localConflict) onCreated(moduleId, createdRuleId)
    if (result.moduleEnableError !== undefined) {
      store.showNotice('error', t('rules.create.enableFailed', { id: moduleId, reason: result.moduleEnableError }))
    } else if (result.refreshError !== undefined) {
      store.showNotice('error', t('rules.create.refreshFailed', { id: moduleId }))
    } else if (result.localConflict) {
      store.showNotice('error', t('rules.create.localConflict', { id: moduleId }))
    } else if (result.value.publicationPending === true || result.value.publicationError !== undefined) {
      store.showNotice('error', `${t('persona.sources.publicationPending')}：${result.value.publicationError ?? '请重试'}`)
    } else {
      store.showNotice('ok', t('templates.inserted', { file, id: createdRuleId }))
    }
  }, [onCreated, store, t])
  const picker = useTemplatePicker((config, target, file) => { void writeInto(target, config, file) }, store.showNotice, t, scope)
  const cancelTarget = useCallback(() => {
    writeGeneration.current++
    picker.cancelTarget()
  }, [picker])
  const openToolsForModule = useCallback((moduleId: string, anchor: HTMLButtonElement): void => {
    toolModule.current = moduleId
    picker.openTools(anchor)
  }, [picker])
  const pickToolTemplate = useCallback((spec: Record<string, unknown>): void => {
    const moduleId = toolModule.current
    picker.closePicker()
    if (moduleId === undefined) return
    // 工具模板＝往该卡自己模块的工具草稿里插一条（主语＝该卡所属模块），不进选目标那一步。
    void insertToolTemplateIntoDraft(store.editorDrafts, moduleId, spec).then((result) => {
      if (result === 'duplicate') store.showNotice('error', t('customTools.duplicateId', { id: String(spec.id ?? '') }))
      else if (result === 'failed') store.showNotice('error', t('customTools.loadFailed'))
      else store.showNotice('ok', t('customTools.templateInserted', { id: String(spec.id ?? '') }))
    })
  }, [picker, store, t])
  const toolbar = <EngineModuleActions t={t} anchorRef={picker.anchorRef} extraItems={items}
    onExtraSelect={(id) => { if (id.startsWith('tpl:')) picker.openPicker(id.slice(4)) }} />
  const dialogs = <>
    {picker.open && <TemplatePicker t={t} anchorRef={picker.popoverAnchorRef} templates={picker.toolsOnly ? [] : picker.templates}
      layer={picker.layer} toolTemplates={picker.layer === undefined ? picker.toolTemplates : undefined}
      onPick={picker.pickTemplate} onPickTool={pickToolTemplate} onClose={picker.closePicker} />}
    {picker.targetOpen && <TemplateTargetPicker t={t} anchorRef={picker.popoverAnchorRef} modules={targets}
      existingIds={existingIds}
      newModuleTemplate={BLANK_MODULE_TEMPLATE}
      onPick={(moduleId, newlyCreated) => picker.confirmTarget({ moduleId, newlyCreated }, undefined, picker.targetIntentId)}
      onCreate={store.createModule === undefined ? undefined : async () => {
        const generation = writeGeneration.current
        const moduleId = await store.createModule!()
        if (generation !== writeGeneration.current) return undefined
        return moduleId
      }}
      onClose={cancelTarget} />}
  </>
  return { toolbar, dialogs, openToolsForModule }
}
