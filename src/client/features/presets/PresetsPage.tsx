/** 「预设和配置」页：全局开关 + 预设切换/导入 + 提示词配置列表统一管理。 */
import { memo, type ReactNode } from 'react'
import { usePromptToolFields } from '../../data/use-prompt-tool-fields.ts'
import { PresetSwitcher } from './PresetSwitcher.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import { CollapsibleCard } from '../../ui/CollapsibleCard.tsx'
import { SettingInputRow } from '../../ui/SettingInputRow.tsx'
import sharedCss from '../../ui/controls.module.css'
import featureCss from './presets.module.css'

const ui = { ...sharedCss, ...featureCss }
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'

export const PresetsPage = memo(function PresetsPage(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props
  const fields = usePromptToolFields(store, (value) => value)
  return (
    <>
      <section className={ui.section} aria-label={t('presets.aria')}>
        <div className={ui.rowGroup}>
          <ToggleRow id="pt-write-preset" label={t('presets.writePreset.label')} hint={t('presets.writePreset.hint')}
            checked={fields.writePreset} onChange={() => store.toggle('writePreset')} />
        </div>
      </section>
      <CollapsibleCard id="pt-host-generated" title={t('presets.agents.title')} meta={t('presets.agents.meta')}>
        <SettingInputRow id="pt-preset-order" label={t('presets.order.label')} hint={t('presets.order.hint')}
          type="number" value={String(fields.presetOrder)}
          onInput={(value) => store.patch({ presetOrder: Number(value) || 0 })}
          onCommit={store.persistSwitches} />
      </CollapsibleCard>
      <PresetSwitcher store={store} t={t} />
    </>
  )
})
