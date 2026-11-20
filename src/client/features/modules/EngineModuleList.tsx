import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Button } from '../../ui/Button.tsx'
import type { ModuleActionsPort, ModuleFactsPort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MODULE_CAPABILITIES, ENGINE_RECIPES, engineRecipe } from '../../../shared/engine-capabilities.ts'
import { canEditModule } from '../../data/module-subject.ts'
import { layerCards } from '../../data/layer-cards.ts'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'
import css from './module-picker-cards.module.css'

/** 合并进页级「添加」清单的创建项（注入模板按层分组）。 */
export interface ModuleCreateItem {
  id: string
  label: string
}

function CreateCommands({ label, trigger, items, onSelect }: {
  label: string
  trigger: RefObject<HTMLButtonElement>
  items: () => readonly ModuleCreateItem[]
  onSelect: (id: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const listId = useId()
  const close = (): void => {
    setOpen(false)
    trigger.current?.focus({ preventScroll: true })
  }
  return <div className={css.commands} onKeyDown={event => {
    if (!open || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    event.stopPropagation()
    event.preventDefault()
    close()
  }}>
    <Button ref={trigger} shape="pill" variant="outline" aria-expanded={open} aria-controls={open ? listId : undefined}
      onClick={() => setOpen(!open)}>{label}</Button>
    {open && <ul id={listId} aria-label={label}>
      {items().map(item => <li key={item.id}>
        <Button variant="outline" onClick={() => { close(); onSelect(item.id) }}>{item.label}</Button>
      </li>)}
    </ul>}
  </div>
}

/** 添加清单只选择模板层，目标模块由后续 TemplateTargetPicker 选择。 */
export function EngineModuleActions(props: {
  t: PromptToolTranslate
  /** 添加按钮 ref：模板浮层锚定到该按钮。 */
  anchorRef?: RefObject<HTMLButtonElement>
  /** 注入模板的层清单。 */
  extraItems?: readonly ModuleCreateItem[]
  onExtraSelect?: (id: string) => void
  /** 添加按钮文案（默认＝添加注入模板）。 */
  label?: string
}): ReactNode {
  const { t, anchorRef, extraItems = [], onExtraSelect } = props
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const trigger = anchorRef ?? fallbackAnchor
  if (extraItems.length === 0) return null
  return <div data-engine-add-menu><CreateCommands label={props.label ?? t('modules.addTemplates')} trigger={trigger}
    items={() => extraItems} onSelect={id => { if (extraItems.some(item => item.id === id)) onExtraSelect?.(id) }} /></div>
}

const noExcludedCapabilities: readonly string[] = []

/** 模块能力创建面板按调用方提供的模块限定写入。 */
export function ModuleCapabilityCreateMenu(props: {
  store: ModuleFactsPort & ModuleActionsPort
  t: PromptToolTranslate
  moduleId: string
  /** 创建菜单归属的层；只列该层未声明的能力。 */
  layer: string
  onCreated?: (capabilityId: string) => void
  /** 该页面不提供创建的能力（受众视图差异，如仅主对话生效的能力）。 */
  excludeCapabilities?: readonly string[]
}): ReactNode {
  const { store, t, moduleId, layer } = props
  const excludeCapabilities = props.excludeCapabilities?.length ? props.excludeCapabilities : noExcludedCapabilities
  const [receipt, setReceipt] = useState<{ moduleId: string; publication?: { pending: boolean; error?: string } }>()
  const publication = receipt?.moduleId === moduleId ? receipt.publication : undefined
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const modules = store.meta.modules
  const editable = canEditModule(store.fields, modules, moduleId)
  const capabilities = useMemo(() => editable
    ? layerCards(modules, layer, moduleId, excludeCapabilities).filter(card => card.kind === 'missingCapability')
    : [], [editable, modules, layer, moduleId, excludeCapabilities])
  const recipes = useMemo(() => editable
    ? ENGINE_RECIPES.filter(({ capabilities }) => !capabilities.some(id => excludeCapabilities.includes(id))
      && MODULE_CAPABILITIES.find(({ id }) => id === capabilities[0])?.displayLayer === layer)
    : [], [editable, layer, excludeCapabilities])
  if (!editable) return null
  const hasCommands = capabilities.length > 0 || recipes.length > 0
  if (!hasCommands && !publication?.pending) return null
  return <div data-engine-create-layer={layer}>
    {hasCommands && <CreateCommands key={moduleId} label={t('modules.addCapability')} trigger={fallbackAnchor}
      items={() => [
        ...capabilities.map(({ id }) => ({ id: `cap:${id}`, label: t('modules.addCapabilityItem', { id }) })),
        ...recipes.map(({ id }) => ({ id: `recipe:${id}`, label: t('modules.createRecipeItem', { id }) })),
      ]}
    onSelect={(id) => {
      const [kind, value] = id.split(':', 2)
      if (value === undefined || !(kind === 'recipe' ? recipes : capabilities).some(item => item.id === value)) return
      void store.createModuleCapability(moduleId, kind === 'recipe' ? 'create-recipe' : 'create', value).then((result) => {
        const capabilityId = kind === 'recipe' ? engineRecipe(value)?.capabilities[0] : value
        if (result.ok) setReceipt({ moduleId, publication: result.publication })
        if (result.ok && capabilityId !== undefined) props.onCreated?.(capabilityId)
      })
    }} />}
    <PublicationNotice publication={publication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
      onRetry={() => { void store.retryModuleCapability(moduleId).then(result => {
        if (result.ok) setReceipt({ moduleId, publication: result.publication })
      }) }} />
  </div>
}
