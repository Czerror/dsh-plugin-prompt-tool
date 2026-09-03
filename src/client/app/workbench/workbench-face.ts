import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'

/** shell.overlay 与 settings.plugins.tab 共享的稳定注入面。 */
export interface PromptToolWorkbenchFace {
  controller: PromptToolWorkspaceController
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
}
