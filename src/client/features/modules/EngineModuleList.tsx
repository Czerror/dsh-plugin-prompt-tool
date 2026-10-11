import { useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '../../ui/icons.tsx'
import { Menu } from '../../ui/Menu.tsx'
import { Button } from '../../ui/Button.tsx'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MODULE_CAPABILITIES, ENGINE_RECIPES, engineRecipe, isModuleCapabilityPresent } from '../../../shared/engine-capabilities.ts'
import { canEditModule, moduleFactsOf } from '../../data/module-subject.ts'

/** 模块能力创建菜单：**主语＝调用方给的模块**（`moduleId`），没有归属模块就不出创建入口。 */
export function ModuleCapabilityCreateMenu(props: {
  store: PromptToolStore
  t: PromptToolTranslate
  moduleId: string
  layer?: string
  onCreated?: (capabilityId: string) => void
  /** 该页面不提供创建的能力（受众视图差异，如仅主对话生效的能力）。 */
  excludeCapabilities?: readonly string[]
}): ReactNode {
  const { store, t, moduleId, excludeCapabilities = [] } = props
  const [open, setOpen] = useState(false)
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const editable = canEditModule(store.fields, store.meta.modules, moduleId)
  if (!editable) return null
  const facts = moduleFactsOf(store.meta.modules, moduleId)
  const excluded = new Set(excludeCapabilities)
  const items = [
    ...MODULE_CAPABILITIES.filter(({ id, displayLayer }) => !excluded.has(id) && !isModuleCapabilityPresent(id, facts)
      && (props.layer === undefined || displayLayer === props.layer))
      .map(({ id }) => ({ id: `cap:${id}`, label: t('modules.addCapabilityItem', { id }) })),
    ...ENGINE_RECIPES.filter(({ capabilities }) => !capabilities.some((id) => excluded.has(id))
      && (props.layer === undefined || MODULE_CAPABILITIES.find(({ id }) => id === capabilities[0])?.displayLayer === props.layer))
      .map(({ id }) => ({ id: `recipe:${id}`, label: t('modules.createRecipeItem', { id }) })),
  ]
  if (items.length === 0) return null
  return <span data-engine-create-layer={props.layer}><Menu open={open} onClose={() => setOpen(false)} items={items} align="end" compact
    onSelect={(id) => {
      setOpen(false)
      fallbackAnchor.current?.focus()
      if (!items.some((item) => item.id === id)) return
      const [kind, value] = id.split(':', 2)
      if (value === undefined) return
      void store.createModuleCapability(moduleId, kind === 'recipe' ? 'create-recipe' : 'create', value).then((created) => {
        const capabilityId = kind === 'recipe' ? engineRecipe(value)?.capabilities[0] : value
        if (created && capabilityId !== undefined) props.onCreated?.(capabilityId)
      })
    }}
    anchor={<Button ref={fallbackAnchor} shape="pill" variant="outline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t('modules.addCapability')}<IconChevronDownOutlineRegular />
    </Button>} /></span>
}
