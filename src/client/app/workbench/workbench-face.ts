import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import type { PromptToolWorkspaceController } from './workspace-controller.ts'

/** 悬浮入口、左侧栏重定向入口与抽屉共享的稳定注入面。 */
export interface PromptToolWorkbenchFace {
  /** 常驻抽屉的开关：两个入口都打开同一个工作台实例。 */
  controller: PromptToolWorkspaceController
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  /** 命名空间翻译函数：调用时读当前语言（引用稳定，可安全进 props）。 */
  t: PromptToolTranslate
}
