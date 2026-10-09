import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { WorkbenchOverlay } from './WorkbenchOverlay.tsx'
import type { PromptToolWorkbenchFace } from './workbench-face.ts'
import { PROMPT_TOOL_NS } from '../../locales.ts'

/**
 * 注册官方槽位：shell.overlay 可拖动悬浮入口（触发器 + body portal 抽屉）。
 *
 * 入口位置由插件自己的位置偏好与视口夹取决定；不再占用官方侧栏 footer 槽位做
 * 几何探针——那需要读宿主布局树，随上游改版即失效。
 */
export function registerWorkbenchSlots(ctx: ClientContext, face: PromptToolWorkbenchFace): () => void {
  const disposeOverlay = ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'prompt-tool-workbench', order: 50,
    locale: PROMPT_TOOL_NS,
    inject: () => face,
  }, WorkbenchOverlay))
  return disposeOverlay
}
