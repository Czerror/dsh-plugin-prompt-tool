/** preset.yml 顶层 persona 段编辑卡（官方 @deepseek-ai/dsh-persona 行 config 同构）。
 *  数据源 = /persona：无载荷读、带 persona 写，host 侧走 readPersonaSpec 校验 +
 *  savePresetPersona 原子写盘并重建。prefix/suffix 取代旧 promptConfigs
 *  params.sectionName + text 的人设承载方式；complete 与提示词配置的「独占」互斥，
 *  由 bridge 写盘前 fail loud。 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { bridgeCall } from '../../data/bridge-client.ts'
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

export function PresetPersonaCard(props: { presetId?: string; disabled?: boolean; onNotice: Notice }): ReactNode {
  const { onNotice } = props
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
        onNotice('error', result.message ?? '人设读取失败')
      }
      setLoaded(true)
    })
  }, [props.presetId, onNotice])
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
        onNotice('ok', persona === null ? '已移除人设段（回落宿主部署人设）' : '人设已保存并重建')
        load()
      } else {
        onNotice('error', result.message ?? '人设保存失败')
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
      name="人设"
      meta={declared ? 'preset.yml 顶层 persona · 官方 @deepseek-ai/dsh-persona 行同构' : '未声明：继承宿主部署人设'}
      layer="system-section"
    >
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>前缀 prefix</span>
        <textarea
          className={styles.configTextarea}
          aria-label="人设前缀"
          value={draft.prefix}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) => patch({ prefix: event.target.value })}
        />
        <span className={styles.configFieldHint}>渲染为 deployment:persona-prefix（第一方指导之前，官方 order 0）；支持 {'{{model}}'} / {'{{cwd}}'} 等官方变量；留空 = 该段渲染时丢弃。</span>
      </span>
      <span className={styles.configFieldStack}>
        <span className={styles.configFieldLabel}>后缀 suffix</span>
        <textarea
          className={styles.configTextarea}
          aria-label="人设后缀"
          value={draft.suffix}
          spellCheck={false}
          disabled={props.disabled}
          onChange={(event) => patch({ suffix: event.target.value })}
        />
        <span className={styles.configFieldHint}>渲染为 deployment:persona-suffix（第一方指导之后，官方 order 10200）；留空 = 遮蔽宿主后缀。</span>
      </span>
      <ToggleRow
        id="persona-complete"
        label="独占"
        hint="prefix 成为唯一系统提示段；与提示词配置的「独占」互斥"
        checked={draft.complete}
        disabled={props.disabled}
        onChange={(next) => patch({ complete: next })}
      />
      <ToggleRow
        id="persona-runtime-context"
        label="动态运行时上下文"
        hint="关闭 = 该 scope 不附加动态快照（官方 includeRuntimeContext:false）"
        checked={draft.includeRuntimeContext}
        disabled={props.disabled}
        onChange={(next) => patch({ includeRuntimeContext: next })}
      />
      <div className={styles.configActions}>
        <button type="button" className={styles.pillButton} disabled={busy || !dirty} onClick={save}>{saving ? '保存中…' : '保存人设'}</button>
        {declared && (
          <button type="button" className={styles.pillButton} data-danger disabled={busy} onClick={() => write(null)}>移除人设段</button>
        )}
      </div>
    </EngineModuleCard>
  )
}
