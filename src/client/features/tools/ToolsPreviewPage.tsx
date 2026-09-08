import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { IconSearchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import { MenuSelect } from '../../ui/MenuSelect.tsx'
import { ToolSurfaceView } from './ToolSurfaceView.tsx'
import css from './tools.module.css'

/** 参考官方 plugin-inventory 的搜索、分组与详情卡；数据仍是模型工具面。 */
export function ToolsPreviewPage({ api, presetId }: { api: PromptToolHostApi; presetId?: string }): ReactNode {
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
      setError(reason instanceof Error ? reason.message : '预设列表读取失败')
      setLoading(false)
    })
    return () => { active = false }
  }, [api.listAgentPresets, presetId, revision])

  return <section className={css.toolsPreviewPage} aria-label="工具预览">
    <label className={css.toolSearch}>
      <IconSearchOutline16 aria-hidden="true" />
      <input type="search" aria-label="搜索工具" placeholder="搜索工具名或描述" value={query}
        onChange={(event) => setQuery(event.target.value)} />
    </label>
    <ToolSurfaceView sessionId={sessionId ?? ''} label="当前会话工具" query={query} />
    <ToolSurfaceView presetId={selectedId} label="预设工具能力" query={query} headerAction={
      <MenuSelect ariaLabel="预设工具能力来源" value={selectedId} placeholder="选择预设"
        disabled={loading || presets.length === 0} className={css.toolPresetSelect} onChange={setSelectedId}
        options={presets.map((preset) => ({ value: preset.id, label: preset.name ?? preset.id }))} />
    }>
      <div className={css.toolSurfaceControls}>
        <button type="button" className={css.toolRefresh} disabled={loading} onClick={() => setRevision((value) => value + 1)}>刷新预设列表</button>
        {loading && <span className={css.toolSurfaceHint} role="status">正在读取预设…</span>}
        {error && <span className={css.toolSurfaceError} role="alert">{error}</span>}
        {!loading && !error && presets.length === 0 && <span className={css.toolSurfaceHint}>暂无可用预设。</span>}
      </div>
    </ToolSurfaceView>
    <p className={css.toolSurfaceHint}>仅预览模型工具；添加和编辑仍在「主会话」模块配置卡，不提供 MCP／插件安装管理。</p>
  </section>
}
