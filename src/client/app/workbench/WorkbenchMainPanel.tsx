import { useEffect, useRef, type ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import { PromptWorkspace } from '../workspace/PromptWorkspace.tsx'
import { PromptToolWorkspaceController } from './workspace-controller.ts'
import css from './Workbench.module.css'

/** Face the sidebar-entry panel needs from the workbench wiring; the translation comes from the slot locale. */
export interface WorkbenchMainPanelFace {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** Close the main panel and return to the Conversation. */
  closePanel: () => void
}

type WorkbenchMainPanelProps = PropsRuntime<'main'> & InjectFace<WorkbenchMainPanelFace> & PropsLocale<'prompt-tool'>

/**
 * Main-column workbench page: the left sidebar's global panel entry selects this
 * key, so it reuses the drawer's workspace instead of a second implementation.
 * The drawer and this page keep separate controllers — a shared one would open
 * the drawer too — while the page's controller stays open for the store load.
 */
export function WorkbenchMainPanel({ api, settings, closePanel, t }: WorkbenchMainPanelProps): ReactNode {
  const controller = useRef(new PromptToolWorkspaceController()).current
  useEffect(() => {
    controller.open()
    return () => controller.close()
  }, [controller])
  return (
    <div className={css.mainPanel} data-dsh-plugin="prompt-tool" data-dsh-part="main-panel">
      <div className={css.windowDragBand} data-window-drag aria-hidden="true" />
      <PromptWorkspace api={api} settings={settings} controller={controller} t={t} onClose={closePanel} />
    </div>
  )
}
