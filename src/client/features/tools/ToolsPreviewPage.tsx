import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import css from './tools.module.css'

/** 参考官方 plugin-inventory 的搜索、分组与详情卡；数据仍是模型工具面。 */
export function ToolsPreviewPage({ api, presetId, t }: { api: PromptToolHostApi; presetId?: string; t: PromptToolTranslate }): ReactNode {
  const [query, setQuery] = useState('')
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState('')
  const [presets, setPresets] = useState<Awaited<ReturnType<PromptToolHostApi['listAgentPresets']>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const face = api.sessionModel
  const { sessionId } = useSyncExternalStore(face.subscribe, face.snapshot, face.snapshot)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void Promise.resolve().then(() => api.listAgentPresets()).then((options) => {
      if (!active) return
      setPresets(options)
      setSelectedId((current) => options.some((preset) => preset.id === current)
        ? current : options.some((preset) => preset.id === presetId) ? presetId! : options[0]?.id ?? '')
      setLoading(false)
    }, (reason: unknown) => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : t('tools.loadFailed'))
      setLoading(false)
    })
    return () => { active = false }
  }, [api.listAgentPresets, presetId, revision, t])

  return <section className={css.toolsPreviewPage} aria-label={t('tools.aria')}>
    <label className={css.toolSearch}>
      <IconSearchOutline16 aria-hidden="true" />
      <input type="search" aria-label={t('tools.search.aria')} placeholder={t('tools.search.placeholder')} value={query}
        onChange={(event) => setQuery(event.target.value)} />
    </label>
    <ToolSurfaceView sessionId={sessionId ?? ''} label={t('tools.surface.session')} t={t} query={query} />
    <ToolSurfaceView presetId={selectedId} label={t('tools.surface.preset')} t={t} query={query} headerAction={
      <MenuSelect ariaLabel={t('tools.surface.source.aria')} value={selectedId} placeholder={t('tools.surface.source.placeholder')}
        disabled={loading || presets.length === 0} className={css.toolPresetSelect} onChange={setSelectedId}
        options={presets.map((preset) => ({ value: preset.id, label: preset.name ?? preset.id }))} />
    }>
      <div className={css.toolSurfaceControls}>
        <button type="button" className={css.toolRefresh} disabled={loading} onClick={() => setRevision((value) => value + 1)}>{t('tools.refreshPresets')}</button>
        {loading && <span className={css.toolSurfaceHint} role="status">{t('tools.loadingPresets')}</span>}
        {error && <span className={css.toolSurfaceError} role="alert">{error}</span>}
        {!loading && !error && presets.length === 0 && <span className={css.toolSurfaceHint}>{t('tools.noPresets')}</span>}
      </div>
    </ToolSurfaceView>
    <p className={css.toolSurfaceHint}>{t('tools.footnote')}</p>
  </section>
}
