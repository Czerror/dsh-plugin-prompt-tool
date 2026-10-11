/** 模板库加载与插入：两页共用，顶部注入模板与层内工具按钮分别提供真实锚点。 */
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { bridgeCall, errorMessage } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptConfigTemplateEntry } from '../../prompt-tool-types.ts'
import type { RuleDefinition } from '../../../shared/rules.ts'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { ModuleRuleEditor } from '../../data/use-rule-editor.ts'
import { BLANK_MODULE_TEMPLATE } from '../../data/module-subject.ts'
import { EngineModuleActions, type ModuleCreateItem } from '../modules/EngineModuleList.tsx'
import { insertToolTemplateIntoDraft } from '../tools/CustomToolsCard.tsx'
import { TemplatePicker, TemplateTargetPicker, type TemplateTargetListEntry } from '../../ui/TemplatePicker.tsx'

/** 自定义工具模板条目：与提示词模板同一次 /templates 返回。 */
export type ToolTemplateEntry = { file: string; spec: Record<string, unknown> }

/** 列表作用域：决定新建配置的消息受众代入方向（过滤状态一律不动）。 */
export type TemplatePickerScope = 'main' | 'subagent'

/** 选完模板后的**唯一**追加步骤：目标模块（已存在模块 / 新建空白模块）。 */
export interface TemplatePickerTarget {
  /** 已存在模块的 id，或「新建空白模块」返回的新模块 id。 */
  moduleId: string
}

/** 这次创建写不写得进去：写 / 等目标读回 / 拒绝。拒绝**绝不**允许走到成功提示。 */
export type CreateWritePlan = 'write' | 'pending' | 'reject'

/**
 * 写前的唯一判定（纯函数，供测试直接对拍）：
 * 目标不可写（未启用／只读／损坏）→ `reject`；可写但编辑器还没读回（新建模块要下一帧）→ `pending`；
 * 可写且已读回 → `write`。**先判可写再判读回**：不可写不能靠「等一等」变成可写。
 */
export const planCreateWrite = (state: { writable: boolean; ownerFound: boolean; ownerLoaded: boolean }): CreateWritePlan =>
  !state.writable ? 'reject' : state.ownerFound && state.ownerLoaded ? 'write' : 'pending'

/**
 * 按判定执行，**顺序固定**：拒绝＝就地报错且一个字都不写；写入＝先落草稿再报成功。
 * 任何路径都不允许「先报成功、再静默挂起」。
 */
export function applyCreateWrite(args: {
  plan: CreateWritePlan
  add: () => void
  onOk: () => void
  onError: () => void
}): 'written' | 'pending' | 'rejected' {
  if (args.plan === 'reject') { args.onError(); return 'rejected' }
  if (args.plan === 'pending') return 'pending'
  args.add()
  args.onOk()
  return 'written'
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
  confirmTarget: (target: TemplatePickerTarget, configsAtTarget?: readonly RuleDefinition[]) => void
  /** 放弃这次创建：关闭目标选择并丢掉待写入的模板。 */
  cancelTarget: () => void
} {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const popoverAnchorRef = useRef<HTMLButtonElement | null>(null)
  const [templates, setTemplates] = useState<PromptConfigTemplateEntry[]>([])
  const [toolTemplates, setToolTemplates] = useState<ToolTemplateEntry[]>([])
  const [open, setOpen] = useState(false)
  const [targetOpen, setTargetOpen] = useState(false)
  const pendingEntry = useRef<PromptConfigTemplateEntry>()
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
    pendingEntry.current = entry
    setTargetOpen(true)
  }

  const confirmTarget = (target: TemplatePickerTarget, configsAtTarget?: readonly RuleDefinition[]): void => {
    const entry = pendingEntry.current
    if (entry === undefined) return
    pendingEntry.current = undefined
    setTargetOpen(false)
    // 去重集合＝目标模块自己的配置：其它模块有同名 id 不影响写进这个模块。
    const clone = createConfigFromTemplate(entry, configsAtTarget ?? [], scope)
    setCreatedConfigId(clone.id)
    // 只交回「写什么、写进谁」；成功与否（以及那时的提示）由调用方按实际写入结果决定。
    onPickConfig(clone, target, entry.file)
  }

  const cancelTarget = (): void => { pendingEntry.current = undefined; setTargetOpen(false) }

  return { anchorRef, popoverAnchorRef, templates, toolTemplates, open, targetOpen, layer, toolsOnly, createdConfigId, openPicker, openTools, closePicker, pickTemplate, confirmTarget, cancelTarget }
}

/**
 * 页级创建编排：页级「添加」下拉 → 注入模板浮层 → **只加一步**选目标 → 写入所选模块。
 *
 * 两次受众页（主会话 / 子代理）共用这一份编排，视图差异只在调用方传进来的 `items`、`scope`
 * 与 `targets`；「主语」始终来自目标选择那一步，不存在任何全局「当前模块」。
 *
 * 两道闸缺一不可：① `targets` 只列可写模块；② 写入前用**同一个判据**再判一次（`planCreateWrite`），
 * 不可写就地报错、绝不静默挂起，也绝不先弹成功。新建分支的时序：`store.createModule()` 会
 * `load()` 重读 /meta，编辑器要到下一帧才有——只有**可写但尚未读回**才走 `pending`。
 */
export function useTemplateCreate(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 菜单项：注入模板的层清单（id 形如 `tpl:<layer>`）。 */
  items: readonly ModuleCreateItem[]
  scope: TemplatePickerScope
  /** 目标选择的候选：**只列可写模块**（未启用／只读／损坏不出现）。 */
  targets: readonly TemplateTargetListEntry[]
  /** 已存在的模块目录 id 全集（含未启用）：只影响新建 id 预览（种子化的空白模板默认未启用）。 */
  existingIds: readonly string[]
  /** 第二道写闸：目标此刻是否可写（与候选过滤同一判据，由调用方给）。 */
  canWrite: (moduleId: string) => boolean
  /** 当前工作区的逐模块编辑器（写入按所选目标取；不在集合里＝尚未读回）。 */
  owners: readonly ModuleRuleEditor[]
  /** 创建成功后展开新卡（主语＝所选目标模块）。 */
  onCreated: (moduleId: string, configKey: string) => void
}): {
  toolbar: ReactNode
  dialogs: ReactNode
  /** 卡内「添加工具模板…」入口：主语＝**该卡所属模块**（工具模板不进目标选择那一步）。 */
  openToolsForModule: (moduleId: string, anchor: HTMLButtonElement) => void
} {
  const { store, t, items, scope, targets, existingIds, canWrite, owners, onCreated } = props
  const [pending, setPending] = useState<{ moduleId: string; config: RuleDefinition; file: string }>()
  /** 卡内工具模板入口打开时记下主权模块：点选模板后要落进它的工具草稿。 */
  const toolModule = useRef<string>()
  const writeInto = useCallback((moduleId: string, config: RuleDefinition, file: string): void => {
    const owner = owners.find((candidate) => candidate.moduleId === moduleId)
    const plan = planCreateWrite({ writable: canWrite(moduleId), ownerFound: owner !== undefined, ownerLoaded: owner?.draft.loaded === true })
    applyCreateWrite({
      plan,
      add: () => { if (owner !== undefined) onCreated(moduleId, owner.editor.add(config)) },
      onOk: () => store.showNotice('ok', t('templates.inserted', { file, id: config.id })),
      onError: () => store.showNotice('error', t('rules.create.failed')),
    })
    if (plan === 'pending') setPending({ moduleId, config, file })
  }, [canWrite, onCreated, owners, store, t])
  // 新建模块的草稿要等它自己的读回；装配集合一出现该模块就收口（只写一次）。
  useEffect(() => {
    if (pending === undefined) return
    const owner = owners.find((candidate) => candidate.moduleId === pending.moduleId)
    if (owner === undefined || !owner.draft.loaded) return
    setPending(undefined)
    onCreated(pending.moduleId, owner.editor.add(pending.config))
    store.showNotice('ok', t('templates.inserted', { file: pending.file, id: pending.config.id }))
  }, [pending, owners, onCreated, store, t])
  const picker = useTemplatePicker((config, target, file) => { writeInto(target.moduleId, config, file) }, store.showNotice, t, scope)
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
  const configsAt = (moduleId: string): RuleDefinition[] =>
    owners.find((owner) => owner.moduleId === moduleId)?.draft.entries.filter((entry) => !entry.deleted).map((entry) => entry.value) ?? []
  const toolbar = <EngineModuleActions store={store} t={t} anchorRef={picker.anchorRef} extraItems={items}
    onExtraSelect={(id) => { if (id.startsWith('tpl:')) picker.openPicker(id.slice(4)) }} />
  const dialogs = <>
    {picker.open && <TemplatePicker t={t} anchorRef={picker.popoverAnchorRef} templates={picker.toolsOnly ? [] : picker.templates}
      layer={picker.layer} toolTemplates={picker.layer === undefined ? picker.toolTemplates : undefined}
      onPick={picker.pickTemplate} onPickTool={pickToolTemplate} onClose={picker.closePicker} />}
    {picker.targetOpen && <TemplateTargetPicker t={t} anchorRef={picker.popoverAnchorRef} modules={targets}
      existingIds={existingIds}
      newModuleTemplate={BLANK_MODULE_TEMPLATE}
      onPick={(moduleId) => picker.confirmTarget({ moduleId }, configsAt(moduleId))}
      onCreate={store.createModule === undefined ? undefined : () => store.createModule!()}
      onClose={picker.cancelTarget} />}
  </>
  return { toolbar, dialogs, openToolsForModule }
}
