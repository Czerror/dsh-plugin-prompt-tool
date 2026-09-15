import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, engineRecipe, isEngineCapabilityPresent, type EngineCapability } from '../../../shared/engine-capabilities.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { EngineParamFields } from './EngineParamFields.tsx'
import styles from '../../ui/controls.module.css'

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
  onExtraSelect?: (id: string) => void
  onCreated?: (capabilityId: string) => void
}): ReactNode {
  const { store, t, anchorRef, extraItems = [], onExtraSelect } = props
  const [open, setOpen] = useState(false)
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  if (!editable && extraItems.length === 0) return null
  const items = [
    ...extraItems,
    ...(editable
      ? [
        ...ENGINE_CAPABILITIES.filter(({ id }) => !isEngineCapabilityPresent(id, store.moduleFacts))
          .map(({ id }) => ({ id: `cap:${id}`, label: t('modules.addCapabilityItem', { id }) })),
        ...ENGINE_RECIPES.map(({ id }) => ({ id: `recipe:${id}`, label: t('modules.createRecipeItem', { id }) })),
      ]
      : []),
  ]
  return <Menu open={open} onClose={() => setOpen(false)} items={items} align="end" portal compact
    onSelect={(id) => {
      setOpen(false)
      const [kind, value] = id.split(':', 2)
      if (kind === 'cap' || kind === 'recipe') {
        if (value !== undefined) void store.createEngineCapability(kind === 'recipe' ? 'create-recipe' : 'create', value).then((created) => {
          const capabilityId = kind === 'recipe' ? engineRecipe(value)?.capabilities[0] : value
          if (created && capabilityId !== undefined) props.onCreated?.(capabilityId)
        })
      } else onExtraSelect?.(id)
    }}
    anchor={<button ref={anchorRef} type="button" className={styles.pillButton} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t('modules.addCapability')}<IconChevronDownOutline14 />
    </button>} />
}

export function EngineModuleActions(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  anchorRef?: RefObject<HTMLButtonElement>
  extraItems?: readonly ModuleCreateItem[]
  onExtraSelect?: (id: string) => void
  onCreated?: (capabilityId: string) => void
}): ReactNode {
  return <div className={styles.configActions}><EngineCapabilityCreateMenu {...props} /></div>
}

export function EnginePromptDefaultsCard({ store, t }: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  return (
    <EngineModuleCard name={t('modules.promptDefaults.name')} meta={t('modules.promptDefaults.meta')}>
      <EngineParamFields store={store} card="prompt-defaults" t={t} />
    </EngineModuleCard>
  )
}

/** 层卡内的额外可编辑条目（如 AGENTS 指令文件）：由 app 层组合注入，feature 不跨域引用。 */
export interface LayerCardEntry {
  id: string
  label: string
}

/** 同层共用一张卡；下拉只切换编辑目标，不改变其他已装配行为。 */
export function EngineBehaviorCard(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  /** 卡所属插入点层：能力为空时仍可承载 extraEntries。 */
  layer: string
  capabilities: readonly EngineCapability[]
  /** 与能力共用同一个选择下拉的额外条目（如指令文件）。 */
  extraEntries?: readonly LayerCardEntry[]
  renderExtra?: (id: string) => ReactNode
  extraMeta?: string
  /** 卡内顶部插槽（如独立指令文件来源开关）。 */
  headerSlot?: ReactNode
  focusCapability?: string
}): ReactNode {
  const { store, t, layer, capabilities, extraEntries = [], renderExtra, extraMeta, headerSlot, focusCapability } = props
  const [selectedId, setSelectedId] = useState(focusCapability)
  useEffect(() => { if (focusCapability !== undefined) setSelectedId(focusCapability) }, [focusCapability])
  const options = [
    ...capabilities.map(({ id }) => ({ value: id, label: id })),
    ...extraEntries.map(({ id, label }) => ({ value: id, label })),
  ]
  const activeId = options.some(({ value }) => value === selectedId) ? selectedId : options[0]?.value
  if (activeId === undefined) return null
  const capability = capabilities.find(({ id }) => id === activeId)
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  return <EngineModuleCard name={t('modules.behavior.name')} layer={layer}
    meta={[...capabilities.map(({ id }) => id), ...(extraMeta === undefined ? [] : [extraMeta])].join(' · ')}
    revealKey={activeId}
    onDelete={capability === undefined || !editable ? undefined : () => void store.removeEngineCapability(capability.id)}>
    {headerSlot}
    {options.length > 1 && <>
      <label className={styles.configFieldLabel}>{t('modules.behavior.label')}
        <MenuSelect ariaLabel={t('modules.behavior.label')} value={activeId} options={options} onChange={setSelectedId} />
      </label>
      <p className={styles.configFieldHint}>{t('modules.behavior.hint')}</p>
    </>}
    {capability === undefined ? renderExtra?.(activeId) : <EngineParamFields store={store} card={capability.id} t={t} />}
  </EngineModuleCard>
}

/** 能力存在性来自实际装配；只统一卡片呈现，不建立第二份配置或运行时顺序。 */
export function EngineModuleCards({
  store,
  t,
  layerFilter = 'all',
  showActions = true,
  showPromptDefaults = true,
  showStatus = true,
  focusCapability,
  preStepEntries,
  renderPreStepEntry,
  preStepMeta,
  preStepSlot,
}: {
  store: PromptToolStore
  t: PromptToolTranslate
  layerFilter?: string
  showActions?: boolean
  showPromptDefaults?: boolean
  showStatus?: boolean
  focusCapability?: string
  /** 前置步骤层额外条目（AGENTS 指令文件）：与同层能力共用下拉。 */
  preStepEntries?: readonly LayerCardEntry[]
  renderPreStepEntry?: (id: string) => ReactNode
  preStepMeta?: string
  /** 前置步骤层卡顶部插槽（独立来源开关）。 */
  preStepSlot?: ReactNode
}): ReactNode {
  const capabilities = ENGINE_CAPABILITIES.filter(({ id, displayLayer }) =>
    (layerFilter === 'all' || layerFilter === displayLayer) && isEngineCapabilityPresent(id, store.moduleFacts))
  // 指令文件只属于前置步骤：有文件条目时该层即使是空能力也要出卡。
  const showPreStep = (layerFilter === 'all' || layerFilter === 'pre-step')
    && ((preStepEntries?.length ?? 0) > 0 || preStepSlot !== undefined)
  const layers = [...new Set([...capabilities.map(({ displayLayer }) => displayLayer), ...(showPreStep ? ['pre-step'] : [])])]
  return <>
    {showActions && <EngineModuleActions store={store} t={t} />}
    {layers.map((layer) => (
      <EngineBehaviorCard key={layer} store={store} t={t} layer={layer} focusCapability={focusCapability}
        capabilities={capabilities.filter(({ displayLayer }) => displayLayer === layer)}
        {...(layer === 'pre-step'
          ? { extraEntries: preStepEntries, renderExtra: renderPreStepEntry, extraMeta: preStepMeta, headerSlot: preStepSlot }
          : {})} />
    ))}
    {showPromptDefaults && (layerFilter === 'all' || layerFilter === 'pre-step') && <EnginePromptDefaultsCard store={store} t={t} />}
    {showStatus && store.moduleFacts === undefined && <p className={styles.configFieldHint} role="status">{t('modules.status.reading')}</p>}
    {showStatus && store.moduleFacts !== undefined && layers.length === 0 && <p className={styles.configFieldHint} role="status">{layerFilter === 'all' ? t('modules.status.emptyAll') : t('modules.status.emptyFiltered')}</p>}
  </>
}
