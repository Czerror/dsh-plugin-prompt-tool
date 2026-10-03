import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button } from '../../ui/Button.tsx'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { SearchInput } from '../../ui/SearchInput.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import { officialPresetSources } from './preset-sources.ts'
import css from './tools.module.css'

/** 参考官方 plugin-inventory 的搜索、分组与详情卡；数据仍是模型工具面。 */
export function ToolsPreviewPage({ api, presetId, t, browse, onNavigate, onReady }: { api: PromptToolHostApi; presetId?: string; t: PromptToolTranslate; browse?: { query: string; selectedId: string; expanded: Record<string, boolean> }; onNavigate?: (page: 'modules') => void; onReady?: () => void }): ReactNode {
  const [query, setQuery] = useState(browse?.query ?? '')
  const [revision, setRevision] = useState(0)
  const [selectedId, setSelectedId] = useState(browse?.selectedId ?? '')
  const [presets, setPresets] = useState<Awaited<ReturnType<PromptToolHostApi['listAgentPresets']>>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const face = api.sessionModel
  const { sessionId } = useSyncExternalStore(face.subscribe, face.snapshot, face.snapshot)
  const [readySession, setReadySession] = useState<string>()
  const [readyPreset, setReadyPreset] = useState<string>()
  const sessionReady = useCallback(() => setReadySession(sessionId ?? ''), [sessionId])
  const presetReady = useCallback(() => setReadyPreset(selectedId), [selectedId])
  useEffect(() => {
    if (!loading && readySession === (sessionId ?? '') && readyPreset === selectedId) onReady?.()
  }, [loading, readySession, readyPreset, sessionId, selectedId, onReady])
  useEffect(() => { if (browse) Object.assign(browse, { query, selectedId }) }, [browse, query, selectedId])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError('')
    void Promise.resolve().then(() => api.listAgentPresets()).then((options) => {
      if (!active) return
      // 只列可用项：缺组合文件的预设选中也读不出工具面（规则与回归测试同源，见 preset-sources.ts）。
      const available = officialPresetSources(options)
      setPresets(available)
      setSelectedId((current) => available.some((preset) => preset.id === current)
        ? current : available.some((preset) => preset.id === presetId) ? presetId! : available[0]?.id ?? '')
      setLoading(false)
    }, (reason: unknown) => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : t('tools.loadFailed'))
      setLoading(false)
    })
    return () => { active = false }
  }, [api.listAgentPresets, presetId, revision, t])

  return <section className={css.toolsPreviewPage} aria-label={t('tools.aria')}>
    <SearchInput aria-label={t('tools.search.aria')} placeholder={t('tools.search.placeholder')} value={query}
      onChange={(event) => setQuery(event.target.value)} />
    <ToolSurfaceView sessionId={sessionId ?? ''} onReady={sessionReady} expandedState={browse?.expanded} label={t('tools.surface.session')} t={t} query={query} />
    <ToolSurfaceView presetId={selectedId} onReady={presetReady} expandedState={browse?.expanded} label={t('tools.surface.preset')} t={t} query={query} headerAction={
      // 模块来源控制区住在标题行：分组默认折叠，来源选择、加载/错误与空态引导不能跟着藏进内容区。
      <div className={css.toolPresetControls} aria-busy={loading}>
        {/* 展开下拉即重新读取 roster（不设独立刷新按钮）；列表非空时不禁用，刷新期间保留旧选项。 */}
        <MenuSelect ariaLabel={t('tools.surface.source.aria')} value={selectedId} placeholder={t('tools.surface.source.placeholder')}
          disabled={presets.length === 0} className={css.toolPresetSelect} onChange={setSelectedId}
          onOpen={() => setRevision((value) => value + 1)}
          options={presets.map((preset) => ({ value: preset.id, disabled: preset.broken !== undefined,
            label: `${preset.name ?? preset.id}${preset.broken === undefined ? '' : ` · ${preset.broken}`}` }))} />
        {loading && presets.length === 0 && <span className={css.toolSurfaceHint} role="status">{t('tools.loadingPresets')}</span>}
        {error && <span className={css.toolSurfaceError} role="alert">{error}</span>}
        {!loading && !error && presets.length === 0 && <span className={css.toolSurfaceHint}>{t('tools.noPresets')} {onNavigate && <Button shape="pill" size="sm" variant="outline" type="button" onClick={() => onNavigate('modules')}>{t('configs.chooseEditable')}</Button>}</span>}
      </div>
    } />
  </section>
}
