import { useRef, useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '../../ui/icons.tsx'
import { Menu } from '../../ui/Menu.tsx'
import { Button } from '../../ui/Button.tsx'
import type { ModuleActionsPort, ModuleFactsPort } from '../../data/store-ports.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MODULE_CAPABILITIES, ENGINE_RECIPES, engineRecipe } from '../../../shared/engine-capabilities.ts'
import { canEditModule } from '../../data/module-subject.ts'
import { layerCards } from '../../data/layer-cards.ts'
import { PublicationNotice } from '../../ui/PublicationNotice.tsx'

/** 合并进页级「添加」菜单的创建项（注入模板按层分组）。 */
export interface ModuleCreateItem {
  id: string
  label: string
}

/**
 * 页级下拉「添加」：本轮创建的唯一入口（T18 起不再有每模块横栏）。
 *
 * 为什么主语不在菜单里：选择器只回答「创建什么」，目标模块由随后的
 * `TemplateTargetPicker` 一步选（已存在 / 新建空白模块）——主语来自那次选择。
 */
export function EngineModuleActions(props: {
  t: PromptToolTranslate
  /** 菜单按钮 ref：模板浮层锚定到该按钮。 */
  anchorRef?: React.RefObject<HTMLButtonElement>
  /** 菜单项：注入模板的层清单。 */
  extraItems?: readonly ModuleCreateItem[]
  onExtraSelect?: (id: string) => void
  /** 菜单按钮文案（默认＝添加注入模板）。 */
  label?: string
}): ReactNode {
  const { t, anchorRef, extraItems = [], onExtraSelect } = props
  const [open, setOpen] = useState(false)
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const trigger = anchorRef ?? fallbackAnchor
  if (extraItems.length === 0) return null
  return <span data-engine-add-menu><Menu open={open} onClose={() => setOpen(false)} items={extraItems} align="end" compact
    onSelect={(id) => {
      setOpen(false)
      trigger.current?.focus()
      if (extraItems.some((item) => item.id === id)) onExtraSelect?.(id)
    }}
    anchor={<Button ref={trigger} shape="pill" variant="outline" aria-label={props.label ?? t('modules.addTemplates')} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {props.label ?? t('modules.addTemplates')}<IconChevronDownOutlineRegular />
    </Button>} /></span>
}

/** 模块能力创建菜单：**主语＝调用方给的模块**（`moduleId`），没有归属模块就不出创建入口。 */
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
  const { store, t, moduleId, excludeCapabilities = [] } = props
  const [open, setOpen] = useState(false)
  const [publication, setPublication] = useState<{ pending: boolean; error?: string }>()
  const fallbackAnchor = useRef<HTMLButtonElement>(null)
  const editable = canEditModule(store.fields, store.meta.modules, moduleId)
  if (!editable) return null
  const excluded = new Set(excludeCapabilities)
  const items = [
    ...layerCards(store.meta.modules, props.layer, moduleId, excludeCapabilities)
      .filter((card) => card.kind === 'missingCapability')
      .map((card) => ({ id: `cap:${card.id}`, label: t('modules.addCapabilityItem', { id: card.id }) })),
    ...ENGINE_RECIPES.filter(({ capabilities }) => !capabilities.some((id) => excluded.has(id))
      && MODULE_CAPABILITIES.find(({ id }) => id === capabilities[0])?.displayLayer === props.layer)
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
      void store.createModuleCapability(moduleId, kind === 'recipe' ? 'create-recipe' : 'create', value).then((result) => {
        const capabilityId = kind === 'recipe' ? engineRecipe(value)?.capabilities[0] : value
        setPublication(result.publication)
        if (result.ok && capabilityId !== undefined) props.onCreated?.(capabilityId)
      })
    }}
    anchor={<Button ref={fallbackAnchor} shape="pill" variant="outline" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      {t('modules.addCapability')}<IconChevronDownOutlineRegular />
    </Button>} />
      <PublicationNotice publication={publication} pendingLabel={t('publication.pending')} retryLabel={t('publication.retry')}
        onRetry={() => { void store.retryModuleCapability(moduleId).then((result) => setPublication(result.publication)) }} />
    </span>
}
