import { useState, type ReactNode } from 'react'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ENGINE_CAPABILITIES, ENGINE_RECIPES, isEngineCapabilityPresent } from '../../../shared/engine-capabilities.ts'
import { EngineParamFields } from './EngineParamFields.tsx'
import styles from '../../ui/controls.module.css'

export function EngineCapabilityCreateMenu({ store }: { store: PromptToolStore }): ReactNode {
  const [open, setOpen] = useState(false)
  if (!store.fields.writePreset || store.moduleFacts?.editable !== true) return null
  const items = [
    ...ENGINE_CAPABILITIES.filter(({ id }) => !isEngineCapabilityPresent(id, store.moduleFacts))
      .map(({ id }) => ({ id: `cap:${id}`, label: `添加模块 · ${id}` })),
    ...ENGINE_RECIPES.map(({ id }) => ({ id: `recipe:${id}`, label: `连锁创建 · ${id}` })),
  ]
  return <Menu open={open} onClose={() => setOpen(false)} items={items} align="end" portal compact
    onSelect={(id) => {
      setOpen(false)
      const [kind, value] = id.split(':', 2)
      if (value !== undefined) void store.createEngineCapability(kind === 'recipe' ? 'create-recipe' : 'create', value)
    }}
    anchor={<button type="button" className={styles.pillButton} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      添加能力 / 工具模块<IconChevronDownOutline14 />
    </button>} />
}

export function EngineModuleActions({ store }: { store: PromptToolStore }): ReactNode {
  return <div className={styles.configActions}><EngineCapabilityCreateMenu store={store} /></div>
}

export function EnginePromptDefaultsCard({ store }: { store: PromptToolStore }): ReactNode {
  return (
    <EngineModuleCard name="提示词生成默认值" meta="预设级提示词生成默认值；不自动添加能力模块。">
      <EngineParamFields store={store} card="prompt-defaults" />
    </EngineModuleCard>
  )
}

/** 能力存在性来自实际装配，字段来自共享参数目录；参数不再手工复制到各卡。层筛选只影响展示。 */
export function EngineModuleCards({
  store,
  layerFilter = 'all',
  showActions = true,
  showPromptDefaults = true,
  showStatus = true,
}: {
  store: PromptToolStore
  layerFilter?: string
  showActions?: boolean
  showPromptDefaults?: boolean
  showStatus?: boolean
}): ReactNode {
  const capabilities = ENGINE_CAPABILITIES.filter(({ id, displayLayer }) =>
    (layerFilter === 'all' || layerFilter === displayLayer) && isEngineCapabilityPresent(id, store.moduleFacts))
  const editable = store.fields.writePreset && store.moduleFacts?.editable === true
  return <>
    {showActions && <EngineModuleActions store={store} />}
    {capabilities.map((capability) => (
      <EngineModuleCard key={capability.id} name={capability.id} layer={capability.displayLayer}
        meta="配置随当前预设保存；仅装配已选模块。"
        onDelete={editable ? () => void store.removeEngineCapability(capability.id) : undefined}>
        <EngineParamFields store={store} card={capability.id} />
      </EngineModuleCard>
    ))}
    {showPromptDefaults && (layerFilter === 'all' || layerFilter === 'pre-step') && <EnginePromptDefaultsCard store={store} />}
    {showStatus && store.moduleFacts === undefined && <p className={styles.configFieldHint} role="status">正在读取当前预设模块事实…</p>}
    {showStatus && store.moduleFacts !== undefined && capabilities.length === 0 && <p className={styles.configFieldHint} role="status">{layerFilter === 'all' ? '当前预设无已装配的引擎能力；可按需添加模块。' : '当前分类无已装配的引擎能力；可按需添加模块。'}</p>}
  </>
}
