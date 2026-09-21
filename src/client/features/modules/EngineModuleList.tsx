import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { useMenuFocus } from '../../ui/menu-focus.ts'
import { cssEscapeId, scrollToCreatedCard } from '../../ui/reveal-card.ts'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, engineRecipe, isEngineCapabilityPresent } from '../../../shared/engine-capabilities.ts'
import { EngineParamFields, matchesEditorGroup } from './EngineParamFields.tsx'
import styles from '../../ui/controls.module.css'

/** 能力卡内的附加编辑器插槽上下文（跨 feature 的自定义编辑器由页面注入，模块层不反向依赖）。 */
export interface CapabilityEditorSlot {
  capabilityId: string
  store: PromptToolStore
  t: PromptToolTranslate
}

/** 合并进「添加能力 / 工具模块」菜单的创建项（提示词配置、自定义工具）。 */
export interface ModuleCreateItem {
  id: string
  label: string
}

export function EngineCapabilityCreateMenu(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 菜单按钮 ref：模板浮层锚定到该按钮。 */
  anchorRef?: RefObject<HTMLButtonElement>
  /** 合并入口：排在能力模块项之前的创建项。 */
  extraItems?: readonly ModuleCreateItem[]
  templatesOnly?: boolean
  layer?: string
  onExtraSelect?: (id: string) => void
  onCreated?: (capabilityId: string) => void
  /** 该页面不提供创建的能力（如子代理页排除仅主对话生效的 tool-filter）。 */
  excludeCapabilities?: readonly string[]
}): ReactNode {
  const { store, t, anchorRef, extraItems = [], onExtraSelect, excludeCapabilities = [] } = props
  const [open, setOpen] = useState(false)
  const firstItemRef = useMenuFocus(open)
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const trigger = anchorRef ?? fallbackAnchor
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  const excluded = new Set(excludeCapabilities)
  if (!editable && extraItems.length === 0) return null
  const items = [
    ...extraItems,
    ...(editable && !props.templatesOnly
      ? [
        ...ENGINE_CAPABILITIES.filter(({ id, displayLayer }) => !excluded.has(id) && !isEngineCapabilityPresent(id, store.moduleFacts)
          && (props.layer === undefined || displayLayer === props.layer))
          .map(({ id }) => ({ id: `cap:${id}`, label: t('modules.addCapabilityItem', { id }) })),
        ...ENGINE_RECIPES.filter(({ capabilities }) => !capabilities.some((id) => excluded.has(id))
          && (props.layer === undefined || ENGINE_CAPABILITIES.find(({ id }) => id === capabilities[0])?.displayLayer === props.layer))
          .map(({ id }) => ({ id: `recipe:${id}`, label: t('modules.createRecipeItem', { id }) })),
      ]
      : []),
  ]
  if (items.length === 0) return null
  return <span data-engine-create-layer={props.layer} onKeyDown={(event) => {
    if (!open || !['Escape', 'Tab'].includes(event.key)) return
    event.stopPropagation()
    if (event.key === 'Escape') event.preventDefault()
    trigger.current?.focus()
    setOpen(false)
  }}><Menu open={open} onClose={() => setOpen(false)} items={items.map((item, index) => ({ ...item, label: <span ref={index === 0 ? firstItemRef : undefined}>{item.label}</span> }))} align="end" portal compact autoFocus
    onSelect={(id) => {
      setOpen(false)
      trigger.current?.focus()
      if (!editable || !items.some((item) => item.id === id)) return
      const [kind, value] = id.split(':', 2)
      if (kind === 'cap' || kind === 'recipe') {
        if (value !== undefined) void store.createEngineCapability(kind === 'recipe' ? 'create-recipe' : 'create', value).then((created) => {
          const capabilityId = kind === 'recipe' ? engineRecipe(value)?.capabilities[0] : value
          if (created && capabilityId !== undefined) props.onCreated?.(capabilityId)
        })
      } else onExtraSelect?.(id)
    }}
    anchor={<button ref={trigger} type="button" className={styles.pillButton} disabled={!editable} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t(props.templatesOnly ? 'modules.addTemplates' : 'modules.addCapability')}<IconChevronDownOutline14 />
    </button>} /></span>
}

export function EngineModuleActions(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  anchorRef?: RefObject<HTMLButtonElement>
  extraItems?: readonly ModuleCreateItem[]
  templatesOnly?: boolean
  layer?: string
  onExtraSelect?: (id: string) => void
  onCreated?: (capabilityId: string) => void
  /** 该页面不提供创建的能力。 */
  excludeCapabilities?: readonly string[]
}): ReactNode {
  // 工具栏只放按钮：说明文字由 EngineModuleCards 渲染在卡片列表上方，
  // 避免挤进 .configActions（flex + margin-left:auto）导致按钮偏移。
  return <div className={styles.configActions}><EngineCapabilityCreateMenu {...props} /></div>
}

export function EnginePromptDefaultsCard({ store, t }: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  return (
    <EngineModuleCard name={t('modules.promptDefaults.name')} meta={t('modules.promptDefaults.meta')}
      defaultExpanded={store.editorDrafts?.expanded.get(`${store.fields.presetTemplate}:prompt-defaults`)}
      onExpandedChange={(value) => store.editorDrafts?.expanded.set(`${store.fields.presetTemplate}:prompt-defaults`, value)}>
      <EngineParamFields store={store} card="prompt-defaults" t={t} />
    </EngineModuleCard>
  )
}

/** 能力存在性来自实际装配；一项已装配能力一张卡，直接编辑自身参数（无编辑目标选择器）。 */
export function EngineModuleCards({
  store,
  t,
  layerFilter = 'all',
  keyword = '',
  showActions = true,
  showPromptDefaults = true,
  showStatus = true,
  focusCapability,
  excludeCapabilities,
  emptyHint,
  hint,
  renderCapabilityExtra,
}: {
  store: PromptToolStore
  t: PromptToolTranslate
  layerFilter?: string
  /** 统一搜索词：能力 id、参数键与参数中文标签都参与匹配（只影响展示）。 */
  keyword?: string
  showActions?: boolean
  showPromptDefaults?: boolean
  showStatus?: boolean
  /** 新建能力后的定位信号：token 每次创建都变化，保证同一能力重复创建仍会再次展开并跳转。 */
  focusCapability?: { id: string; token: number }
  /** 该页面不渲染的能力卡（如子代理页排除仅主对话生效的 tool-filter）。 */
  excludeCapabilities?: readonly string[]
  /** 无卡片时的替代说明（默认按层级给通用空状态）。 */
  emptyHint?: string
  /** 卡片列表上方的说明（工具栏只放按钮，说明文字不挤进按钮行）。 */
  hint?: string
  /** 能力卡内的附加编辑器（由页面注入，避免 feature 间反向依赖）。 */
  renderCapabilityExtra?: (slot: CapabilityEditorSlot) => ReactNode
}): ReactNode {
  const excluded = new Set(excludeCapabilities ?? [])
  const search = keyword.trim().toLowerCase()
  const capabilities = ENGINE_CAPABILITIES.filter(({ id, displayLayer }) =>
    !excluded.has(id)
    && (layerFilter === 'all' || layerFilter === displayLayer)
    && matchesEditorGroup(id, search, t)
    && isEngineCapabilityPresent(id, store.moduleFacts))
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  const focus = focusCapability
  const focusToken = focus?.token
  const focusId = focus?.id
  useEffect(() => {
    if (focusId === undefined) return
    // 新建只做两件事：展开（revealKey）与滚动定位；过滤状态一律不动。
    // 依赖只取 token：避免同一信号因父级重渲染（新对象引用）反复触发滚动。
    return scrollToCreatedCard(`[data-module-card-id="${cssEscapeId(focusId)}"]`)
  }, [focusToken, focusId])
  return <>
    {showActions && <EngineModuleActions store={store} t={t} />}
    {hint !== undefined && <p className={styles.configFieldHint}>{hint}</p>}
    {capabilities.map((capability) => (
      <EngineModuleCard key={capability.id} name={capability.id} layer={capability.displayLayer}
        meta={capability.moduleKeys.join(' · ')}
        revealKey={capability.id === focus?.id ? String(focus.token) : undefined}
        anchorId={capability.id}
        defaultExpanded={store.editorDrafts?.expanded.get(`${store.fields.presetTemplate}:capability:${capability.id}`)}
        onExpandedChange={(value) => store.editorDrafts?.expanded.set(`${store.fields.presetTemplate}:capability:${capability.id}`, value)}
        deleteLabels={{ title: t('card.deleteTitle', { name: capability.id }), description: t('card.deleteDescription', { name: capability.id }), confirm: t('toolEditor.confirmRemove'), cancel: t('toolEditor.cancel'), failure: t('card.operationFailed') }}
        readOnlyReason={!editable ? t('configs.readOnly.system') : undefined}
        onDelete={editable ? async () => { if (!await store.removeEngineCapability(capability.id)) throw new Error(t('card.operationFailed')) } : undefined}>
        <EngineParamFields store={store} card={capability.id} t={t} />
        {renderCapabilityExtra?.({ capabilityId: capability.id, store, t })}
      </EngineModuleCard>
    ))}
    {showPromptDefaults && (layerFilter === 'all' || layerFilter === 'pre-step') && matchesEditorGroup('prompt-defaults', search, t) && <EnginePromptDefaultsCard store={store} t={t} />}
    {showStatus && store.moduleFacts === undefined && <p className={styles.configFieldHint} role="status">{t('modules.status.reading')}</p>}
    {showStatus && store.moduleFacts !== undefined && capabilities.length === 0 && (
      <p className={styles.configFieldHint} role="status">
        {search.length > 0
          ? t('modules.status.emptySearch', { keyword: keyword.trim() })
          : emptyHint ?? (layerFilter === 'all' ? t('modules.status.emptyAll') : t('modules.status.emptyFiltered'))}
      </p>
    )}
  </>
}
