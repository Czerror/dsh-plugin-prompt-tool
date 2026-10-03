import { useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolStore } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { buildEffortOptions, buildModelOptions, modelChoiceValue, parseModelChoice } from './model-options.ts'
import styles from '../../ui/controls.module.css'

/** 官方当前会话选择独立于模块规则；不再写旧的 layerSettings.model*。 */
export function CurrentSessionModel(props: { store: PromptToolStore; t: PromptToolTranslate }): ReactNode {
  const { store, t } = props, face = store.api.sessionModel
  const view = useSyncExternalStore(face.subscribe, face.snapshot)
  const [busy, setBusy] = useState(false)
  const provider = view.selection?.provider ?? store.hostDefaultModel?.provider ?? ''
  const model = view.selection?.model ?? store.hostDefaultModel?.model ?? ''
  const reasoningEffort = view.selection?.reasoningEffort ?? store.hostDefaultModel?.reasoningEffort ?? ''
  const options = buildModelOptions(store.modelCatalog, provider && model ? [{ provider, model }] : []).filter(option => option.value !== '')
  const efforts = buildEffortOptions(store.modelReasoning[modelChoiceValue(provider, model)], reasoningEffort)
  const select = (change: { provider?: string; model?: string; reasoningEffort?: string }): void => {
    const selection = { provider, model, reasoningEffort, ...change }
    if (!view.selectable || busy || !selection.provider || !selection.model) return
    setBusy(true)
    void face.select({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }).then(() => { store.showNotice('ok', t('rules.sessionModelSaved')); void store.load() })
      .catch((error: unknown) => store.showNotice('error', String(error))).finally(() => setBusy(false))
  }
  return <EngineModuleCard name={t('rules.sessionModel')} embedded>
    <div className={styles.sessionModelRow}>
      <MenuSelect compact ariaLabel={t('rules.sessionModel')} placeholder={t('field.default')} value={provider && model ? modelChoiceValue(provider, model) : ''} options={options} disabled={!view.selectable || busy}
        onChange={value => { const next = parseModelChoice(value); if (next) select(next) }} />
      <MenuSelect compact ariaLabel={t('rules.reasoningEffort')} placeholder={t('field.default')} value={reasoningEffort} options={efforts} disabled={!view.selectable || busy} onChange={reasoningEffort => select({ reasoningEffort })} />
    </div>
  </EngineModuleCard>
}
