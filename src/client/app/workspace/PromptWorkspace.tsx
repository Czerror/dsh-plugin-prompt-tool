import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
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
  const open = useSyncExternalStore(
    props.controller.subscribe,
    props.controller.getSnapshot,
    props.controller.getSnapshot,
  ).open

  useEffect(() => {
    if (open) void store.load()
  }, [open, store.load])

  const pageMeta = page === 'skills'
    ? t('meta.skills', { count: store.fields.skillCatalog.length })
    : page === 'features'
      ? t('meta.features')
      : page === 'presets'
        ? t('meta.presets')
        : page === 'characters'
          ? t('meta.characters', { count: (store.meta.presets ?? []).filter((preset) => preset.meta?.source === 'sillytavern').length })
          : page === 'tools' ? t('meta.tools') : t('meta.subagent')

  const content = page === 'features'
    ? <MainSessionPage store={store} t={t} />
    : page === 'subagent'
      ? <SubagentPage store={store} t={t} />
      : page === 'tools'
        ? <ToolsPreviewPage api={props.api} presetId={store.fields.presetTemplate} t={t} />
        : page === 'skills'
          ? <SkillsPage store={store} api={props.api} t={t} />
          : page === 'presets'
            ? <PresetsPage store={store} t={t} />
            : <CharactersPage store={store} t={t} />

  return (
    <WorkspaceFrame
      store={store}
      page={page}
      pageMeta={pageMeta}
      t={t}
      onPageChange={setPage}
      onClose={props.onClose}
    >
      {content}
    </WorkspaceFrame>
  )
}
