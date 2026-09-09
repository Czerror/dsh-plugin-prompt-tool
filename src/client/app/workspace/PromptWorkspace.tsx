import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolHostApi } from '../../data/host-api.ts'
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
  /** 悬浮入口抽屉的开关；右侧栏 tab 入口不传，视为常开。 */
  controller?: PromptToolWorkspaceController
  onClose: () => void
}

/** 无 controller（右侧栏 tab 入口）时的稳定快照：工作台始终视为打开。 */
const ALWAYS_OPEN = { open: true } as const

export function PromptWorkspace(props: PromptWorkspaceProps): ReactNode {
  const store = usePromptToolStore(props.api, props.settings)
  const [page, setPage] = useState<WorkspacePage>('features')
  const controller = props.controller
  const subscribe = useCallback((listener: () => void) => controller?.subscribe(listener) ?? (() => {}), [controller])
  const getSnapshot = useCallback(() => controller?.getSnapshot() ?? ALWAYS_OPEN, [controller])
  const open = useSyncExternalStore(subscribe, getSnapshot, getSnapshot).open

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
          : page === 'tools' ? '只读' : '子代理'

  const content = page === 'features'
    ? <MainSessionPage store={store} />
    : page === 'subagent'
      ? <SubagentPage store={store} />
      : page === 'tools'
        ? <ToolsPreviewPage api={props.api} presetId={store.fields.presetTemplate} />
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
