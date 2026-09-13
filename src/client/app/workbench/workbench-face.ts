import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'

/** 悬浮入口（shell.overlay）、右侧栏 tab 与 settings.plugins.tab 共享的稳定注入面。 */
export interface PromptToolWorkbenchFace {
  /** 悬浮入口抽屉的开关；右侧栏 tab 入口不使用。 */
  controller: PromptToolWorkspaceController
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** 命名空间翻译函数：调用时读当前语言（引用稳定，可安全进 props）。 */
  t: PromptToolTranslate
}
