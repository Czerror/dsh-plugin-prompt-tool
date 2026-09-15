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

/** 同层共用一张行为卡；下拉只切换编辑目标，不改变其他已装配行为。 */
export function EngineBehaviorCard({ store, t, capabilities, focusCapability }: {
  store: PromptToolStore
  t: PromptToolTranslate
  capabilities: readonly EngineCapability[]
  focusCapability?: string
}): ReactNode {
  const [selectedId, setSelectedId] = useState(focusCapability)
  useEffect(() => { if (focusCapability !== undefined) setSelectedId(focusCapability) }, [focusCapability])
  const selected = capabilities.find(({ id }) => id === selectedId) ?? capabilities[0]
  if (selected === undefined) return null
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  return <EngineModuleCard name={t('modules.behavior.name')} layer={selected.displayLayer}
    meta={capabilities.map(({ id }) => id).join(' · ')} revealKey={selected.id}
    onDelete={editable ? () => void store.removeEngineCapability(selected.id) : undefined}>
    <label className={styles.configFieldLabel}>{t('modules.behavior.label')}
      <MenuSelect ariaLabel={t('modules.behavior.label')} value={selected.id}
        options={capabilities.map(({ id }) => ({ value: id, label: id }))} onChange={setSelectedId} />
    </label>
    <p className={styles.configFieldHint}>{t('modules.behavior.hint')}</p>
    <EngineParamFields store={store} card={selected.id} t={t} />
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
}: {
  store: PromptToolStore
  t: PromptToolTranslate
  layerFilter?: string
  showActions?: boolean
  showPromptDefaults?: boolean
  showStatus?: boolean
  focusCapability?: string
}): ReactNode {
  const capabilities = ENGINE_CAPABILITIES.filter(({ id, displayLayer }) =>
    (layerFilter === 'all' || layerFilter === displayLayer) && isEngineCapabilityPresent(id, store.moduleFacts))
  const layers = [...new Set(capabilities.map(({ displayLayer }) => displayLayer))]
  return <>
    {showActions && <EngineModuleActions store={store} t={t} />}
    {layers.map((layer) => (
      <EngineBehaviorCard key={layer} store={store} t={t} focusCapability={focusCapability}
        capabilities={capabilities.filter(({ displayLayer }) => displayLayer === layer)} />
    ))}
    {showPromptDefaults && (layerFilter === 'all' || layerFilter === 'pre-step') && <EnginePromptDefaultsCard store={store} t={t} />}
    {showStatus && store.moduleFacts === undefined && <p className={styles.configFieldHint} role="status">{t('modules.status.reading')}</p>}
    {showStatus && store.moduleFacts !== undefined && capabilities.length === 0 && <p className={styles.configFieldHint} role="status">{layerFilter === 'all' ? t('modules.status.emptyAll') : t('modules.status.emptyFiltered')}</p>}
  </>
}
