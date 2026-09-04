import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import { usePromptToolStore, type PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolWorkspaceController } from '../workbench/workspace-controller.ts'
import { CharactersPage } from '../../features/characters/CharactersPage.tsx'
import { PresetsPage } from '../../features/presets/PresetsPage.tsx'
import { SkillsPage } from '../../features/skills/SkillsPage.tsx'
import { MainSessionPage } from './pages/MainSessionPage.tsx'
import { SubagentPage } from './pages/SubagentPage.tsx'
import { WorkspaceFrame } from './WorkspaceFrame.tsx'
import type { WorkspacePage } from './workspace-pages.ts'

export interface PromptWorkspaceProps {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  controller: PromptToolWorkspaceController
  onClose: () => void
}

export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
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
    ? `${store.fields.skillCatalog.length} 技能`
    : page === 'features'
      ? '全局'
      : page === 'presets'
        ? '预设配置'
        : page === 'characters'
          ? `${(store.meta.presets ?? []).filter((preset) => preset.meta?.source === 'sillytavern').length} 角色卡`
          : '子代理'

  const content = page === 'features'
    ? <MainSessionPage store={store} />
    : page === 'subagent'
      ? <SubagentPage store={store} />
      : page === 'skills'
        ? <SkillsPage store={store} api={props.api} />
        : page === 'presets'
          ? <PresetsPage store={store} />
          : <CharactersPage store={store} />

  return (
    <WorkspaceFrame
      store={store}
      page={page}
      pageMeta={pageMeta}
      onPageChange={setPage}
      onClose={props.onClose}
    >
      {content}
    </WorkspaceFrame>
  )
}
