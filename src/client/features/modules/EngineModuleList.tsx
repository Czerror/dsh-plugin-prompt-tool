import { useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconChevronDownOutlineRegular } from '../../ui/icons.tsx'
import { Menu } from '../../ui/Menu.tsx'
import { Button } from '../../ui/Button.tsx'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, engineRecipe, isEngineCapabilityPresent } from '../../../shared/engine-capabilities.ts'
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
  templatesOnly?: boolean
  layer?: string
  onExtraSelect?: (id: string) => void
  onCreated?: (capabilityId: string) => void
  /** 该页面不提供创建的能力（受众视图差异，如仅主对话生效的能力）。 */
  excludeCapabilities?: readonly string[]
}): ReactNode {
  const { store, t, anchorRef, extraItems = [], onExtraSelect, excludeCapabilities = [] } = props
  const [open, setOpen] = useState(false)
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
  return <span data-engine-create-layer={props.layer}><Menu open={open} onClose={() => setOpen(false)} items={items} align="end" compact
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
    anchor={<Button ref={trigger} shape="pill" variant="outline" disabled={!editable} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t(props.templatesOnly ? 'modules.addTemplates' : 'modules.addCapability')}<IconChevronDownOutlineRegular />
    </Button>} /></span>
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
  return <div className={styles.configActions}><EngineCapabilityCreateMenu {...props} /></div>
}
