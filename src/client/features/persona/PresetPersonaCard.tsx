/** preset.yml 顶层 persona 段编辑卡（官方 @deepseek-ai/dsh-persona 行 config 同构）。
 *  数据源 = /persona：无载荷读、带 persona 写，host 侧走 readPersonaSpec 校验 +
 *  savePresetPersona 原子写盘并重建。prefix/suffix 取代旧 promptConfigs
 *  params.sectionName + text 的人设承载方式；complete 与提示词配置的「独占」互斥，
 *  由 bridge 写盘前 fail loud。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { EngineModuleCard } from '../../ui/EngineModuleCard.tsx'
import { ToggleRow } from '../../ui/ToggleRow.tsx'
import styles from '../../ui/controls.module.css'

type Notice = (kind: 'ok' | 'error', message: string) => void

interface PersonaDraft {
  prefix: string
  suffix: string
  complete: boolean
  includeRuntimeContext: boolean
}

const EMPTY_PERSONA: PersonaDraft = { prefix: '', suffix: '', complete: false, includeRuntimeContext: true }

export function PresetPersonaCard(props: { t: PromptToolTranslate; presetId?: string; disabled?: boolean; onNotice: Notice }): ReactNode {
  const { t, onNotice } = props
  const [draft, setDraft] = useState<PersonaDraft>(EMPTY_PERSONA)
  const [declared, setDeclared] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    void bridgeCall('persona', { expectedPresetId: props.presetId }).then((result) => {
      if (result.ok) {
        const persona = result.value.persona
        setDraft(persona === null ? EMPTY_PERSONA : {
          prefix: persona.prefix,
          suffix: persona.suffix ?? '',
          complete: persona.complete === true,
          includeRuntimeContext: persona.includeRuntimeContext !== false,
        })
        setDeclared(persona !== null)
      } else {
        onNotice('error', result.message ?? t('persona.notice.loadFailed'))
      }
      setLoaded(true)
    })
  }, [props.presetId, onNotice, t])
  useEffect(() => { load() }, [load])

  const patch = (next: Partial<PersonaDraft>): void => {
    setDraft((current) => ({ ...current, ...next }))
    setDirty(true)
  }
  const write = (persona: { prefix: string; suffix?: string; complete?: boolean; includeRuntimeContext?: boolean } | null): void => {
    setSaving(true)
    void bridgeCall('persona', { persona, expectedPresetId: props.presetId }).then((result) => {
      setSaving(false)
      if (result.ok) {
        setDirty(false)
        onNotice('ok', persona === null ? t('persona.notice.removed') : t('persona.notice.saved'))
        load()
      } else {
        onNotice('error', result.message ?? t('persona.notice.saveFailed'))
      }
    })
  }
  const save = (): void => {
    const untouched = draft.prefix === '' && draft.suffix === '' && !draft.complete && draft.includeRuntimeContext
    write(!declared && untouched ? null : {
      prefix: draft.prefix,
      ...(draft.suffix.length > 0 ? { suffix: draft.suffix } : {}),
      ...(draft.complete ? { complete: true } : {}),
      ...(draft.includeRuntimeContext ? {} : { includeRuntimeContext: false }),
    })
  }
  const busy = props.disabled === true || saving || !loaded
  return (
    <EngineModuleCard
      name={t('persona.name')}
      meta={declared ? t('persona.meta.declared') : t('persona.meta.inherited')}
      layer="system-section"
    >
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>{t('persona.prefix.label')}</span>
        <textarea
          className={styles.configTextarea}
          aria-label={t('persona.prefix.aria')}
          value={draft.prefix}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) => patch({ prefix: event.target.value })}
        />
        <span className={styles.configFieldHint}>{t('persona.prefix.hint')}</span>
      </span>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>{t('persona.suffix.label')}</span>
        <textarea
          className={styles.configTextarea}
          aria-label={t('persona.suffix.aria')}
          value={draft.suffix}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) => patch({ suffix: event.target.value })}
        />
        <span className={styles.configFieldHint}>{t('persona.suffix.hint')}</span>
      </span>
      <ToggleRow
        id="persona-complete"
        label={t('persona.complete.label')}
        hint={t('persona.complete.hint')}
        checked={draft.complete}
        disabled={props.disabled}
        onChange={(next) => patch({ complete: next })}
      />
      <ToggleRow
        id="persona-runtime-context"
        label={t('persona.runtimeContext.label')}
        hint={t('persona.runtimeContext.hint')}
        checked={draft.includeRuntimeContext}
        disabled={props.disabled}
        onChange={(next) => patch({ includeRuntimeContext: next })}
      />
      <div className={styles.configActions}>
        <button type="button" className={styles.pillButton} disabled={busy || !dirty} onClick={save}>{saving ? t('persona.saving') : t('persona.save')}</button>
        {declared && (
          <button type="button" className={styles.pillButton} data-danger disabled={busy} onClick={() => write(null)}>{t('persona.remove')}</button>
        )}
      </div>
    </EngineModuleCard>
  )
}
