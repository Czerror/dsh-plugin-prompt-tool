import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { usePromptToolStore, type PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolWorkspaceController } from '../workbench/workspace-controller.ts'
import { CharactersPage } from '../../features/characters/CharactersPage.tsx'
import { PresetsPage } from '../../features/presets/PresetsPage.tsx'
import { SkillsPage } from '../../features/skills/SkillsPage.tsx'
import { ToolsPreviewPage } from '../../features/tools/ToolsPreviewPage.tsx'
import { MainSessionPage } from './pages/MainSessionPage.tsx'
import { SubagentPage } from './pages/SubagentPage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
import type { WorkspacePage } from './workspace-pages.ts'
import { configPageBrowse, createWorkspaceBrowseState } from './workspace-browse-state.ts'

export interface PromptWorkspaceProps {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** 悬浮入口抽屉的开关。 */
  controller: PromptToolWorkspaceController
  /** 命名空间翻译函数（调用时读当前语言）。 */
  t: PromptToolTranslate
  onClose: () => void
}

export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const { t } = props
  const store = usePromptToolStore(props.api, props.settings)
  const [page, setPage] = useState<WorkspacePage>('features')
  const browse = useRef(createWorkspaceBrowseState()).current
  const [focusPage, setFocusPage] = useState(0)
  const [readyPage, setReadyPage] = useState<WorkspacePage>()
  const changePage = (target: WorkspacePage): void => {
    if (target !== page) setReadyPage(undefined)
    setPage(target)
  }
  const markReady = useCallback(() => setReadyPage(page), [page])
  const navigate = (target: WorkspacePage): void => {
    changePage(target)
    setFocusPage((value) => value + 1)
  }
  const presetId = store.fields.presetTemplate
  const scrollKey = page === 'features' || page === 'subagent' ? `${page}:${presetId}` : page
  const open = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  ).open

  useEffect(() => {
    if (open) void store.load()
  }, [open, store.load])

  const content = page === 'features'
    ? <MainSessionPage key={presetId} store={store} t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
    : page === 'subagent'
      ? <SubagentPage key={presetId} store={store} t={t} browse={configPageBrowse(browse, scrollKey)} onNavigate={navigate} />
      : page === 'tools'
        ? <ToolsPreviewPage api={props.api} presetId={presetId} t={t} browse={browse.tools} onNavigate={navigate} onReady={markReady} />
        : page === 'skills'
          ? <SkillsPage store={store} api={props.api} t={t} browse={browse.skills} />
          : page === 'presets'
            ? <PresetsPage store={store} t={t} />
            : <CharactersPage store={store} t={t} onReady={markReady} />

  return (
    <WorkspaceFrame
      store={store}
      page={page}
      t={t}
      onPageChange={changePage}
      scrollKey={scrollKey}
      scrollPositions={browse.scroll}
      focusPage={focusPage}
      contentReady={page !== 'characters' && page !== 'tools' || readyPage === page}
      onClose={props.onClose}
    >
      {content}
    </WorkspaceFrame>
  )
}
