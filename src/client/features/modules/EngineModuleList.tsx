import { useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, isEngineCapabilityPresent } from '../../../shared/engine-capabilities.ts'
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
        if (value !== undefined) void store.createEngineCapability(kind === 'recipe' ? 'create-recipe' : 'create', value)
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

/** 能力存在性来自实际装配，字段来自共享参数目录；参数不再手工复制到各卡。层筛选只影响展示。 */
export function EngineModuleCards({
  store,
  t,
  layerFilter = 'all',
  showActions = true,
  showPromptDefaults = true,
  showStatus = true,
}: {
  store: PromptToolStore
  t: PromptToolTranslate
  layerFilter?: string
  showActions?: boolean
  showPromptDefaults?: boolean
  showStatus?: boolean
}): ReactNode {
  const capabilities = ENGINE_CAPABILITIES.filter(({ id, displayLayer }) =>
    (layerFilter === 'all' || layerFilter === displayLayer) && isEngineCapabilityPresent(id, store.moduleFacts))
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  return <>
    {showActions && <EngineModuleActions store={store} t={t} />}
    {capabilities.map((capability) => (
      <EngineModuleCard key={capability.id} name={capability.id} layer={capability.displayLayer}
        meta={t('modules.card.meta')}
        onDelete={editable ? () => void store.removeEngineCapability(capability.id) : undefined}>
        <EngineParamFields store={store} card={capability.id} t={t} />
      </EngineModuleCard>
    ))}
    {showPromptDefaults && (layerFilter === 'all' || layerFilter === 'pre-step') && <EnginePromptDefaultsCard store={store} t={t} />}
    {showStatus && store.moduleFacts === undefined && <p className={styles.configFieldHint} role="status">{t('modules.status.reading')}</p>}
    {showStatus && store.moduleFacts !== undefined && capabilities.length === 0 && <p className={styles.configFieldHint} role="status">{layerFilter === 'all' ? t('modules.status.emptyAll') : t('modules.status.emptyFiltered')}</p>}
  </>
}
