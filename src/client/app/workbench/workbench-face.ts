import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'

/** 右侧栏工作台 tab 与 settings.plugins.tab 共享的稳定注入面。 */
export interface PromptToolWorkbenchFace {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
}
