import { createElement as h, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { WorkbenchSidebarEntry } from './WorkbenchSidebarEntry.tsx'
import type { PromptToolTranslate } from '../../locales.ts'
import { PROMPT_TOOL_NS } from '../../locales.ts'

export const WORKBENCH_ENTRY_ID = PROMPT_TOOL_NS
export const WORKBENCH_VIEW_ID = 'prompt-tool-workbench'
export interface NativeWorkbenchRenderProps { sessionId?: string; visible?: boolean; placement: 'main' | 'sidebar' | 'conversation' }
export interface NativeWorkbenchFace { t: PromptToolTranslate; renderWorkspace: (props: NativeWorkbenchRenderProps) => ReactNode }

/** Registers host-owned surfaces; no overlay or DOM event interception. */
export function registerWorkbenchSlots(ctx: ClientContext, face: NativeWorkbenchFace): () => void {
  const disposers: Array<() => void> = []
  const own = (value: unknown): void => { if (typeof value === 'function') disposers.push(value as () => void) }
  own(ctx.slots.inject('main', () => ctx.slots.register(
    { name: 'main', key: WORKBENCH_ENTRY_ID, locale: PROMPT_TOOL_NS },
    (props: { sessionId?: string }) => face.renderWorkspace({ ...props, placement: 'main', visible: true }),
  )))
  own(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
    { name: 'sidebar.panellist', id: WORKBENCH_ENTRY_ID, order: 60, locale: PROMPT_TOOL_NS, label: () => face.t('app.title') },
    WorkbenchSidebarEntry,
  )))
  own(ctx.slots.inject('conversation.view', () => ctx.slots.register(
    { name: 'conversation.view', id: WORKBENCH_VIEW_ID, order: 20, locale: PROMPT_TOOL_NS, label: () => face.t('app.title') },
    (props: { sessionId?: string }) => face.renderWorkspace({ ...props, placement: 'conversation', visible: true }),
  )))
  const fiber = ctx.inject(['sidebarRightTabs'], (injected) => {
    const tabs = injected.sidebarRightTabs
    const local: Array<() => void> = []
    const keep = (value: unknown): void => { if (typeof value === 'function') local.push(value as () => void) }
    keep(tabs.register({ id: WORKBENCH_ENTRY_ID, kind: WORKBENCH_ENTRY_ID, title: () => face.t('app.title'), guide: [{ id: WORKBENCH_ENTRY_ID, order: 60, title: () => face.t('app.title'), description: () => face.t('app.title'), icon: WorkbenchSidebarEntry }] }))
    keep(injected.slots.inject('sidebar.right.pane.tab', () => injected.slots.register(
      { name: 'sidebar.right.pane.tab', key: WORKBENCH_ENTRY_ID, locale: PROMPT_TOOL_NS },
      (props: PropsRuntime<'sidebar.right.pane.tab'>) => {
        const info = props.useTabInfo()
        return face.renderWorkspace({ sessionId: props.sessionId, placement: 'sidebar', visible: info.tab.visible })
      },
    )))
    keep(injected.slots.inject('sidebar.right.pane.tab.title', () => injected.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: WORKBENCH_ENTRY_ID }, () => h('span', null, face.t('app.title')),
    )))
    return () => { for (const dispose of local.splice(0)) dispose() }
  })
  if (fiber !== undefined) own(() => { (fiber as { dispose?: () => unknown }).dispose?.() })
  return () => { for (const dispose of disposers.splice(0)) dispose() }
}
