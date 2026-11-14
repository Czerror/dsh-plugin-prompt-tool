import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import type { PromptToolHostApi } from '../../data/host-api.ts'
import type { PromptToolSettingsTransport } from '../../data/use-prompt-tool-store.ts'
import type { WorkspaceStoreHolder } from '../../data/workspace-state.ts'
import { WorkspaceStoreOwner } from '../../data/WorkspaceStoreOwner.tsx'
import type { RuleDiagnosticsSession } from '../../data/rule-diagnostics-session.ts'
import type { PromptToolTranslate } from '../../locales.ts'
import { PromptWorkspace } from '../workspace/PromptWorkspace.tsx'
import type { NativeWorkspaceState } from './native-workspace-state.ts'
import type { NativeWorkbenchRenderProps } from './register-workbench.tsx'

export interface NativeWorkspaceOwner {
  state: NativeWorkspaceState
  holder: WorkspaceStoreHolder
  diagnostics: RuleDiagnosticsSession
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  t: PromptToolTranslate
  mainSession(): string | undefined
  subscribeMainSession(listener: () => void): () => void
}

/** 唯一常驻节点只持有数据，不产生 DOM、入口或诊断请求。 */
export function NativeWorkspaceData({ owner }: { owner: NativeWorkspaceOwner }): ReactNode {
  const activity = useSyncExternalStore(owner.state.subscribe, owner.state.getSnapshot, owner.state.getSnapshot)
  return <WorkspaceStoreOwner api={owner.api} settings={owner.settings} holder={owner.holder} active={activity.active} />
}

const documentVisible = (): boolean => typeof document === 'undefined' || document.visibilityState === 'visible'
const subscribeVisibility = (listener: () => void): (() => void) => {
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

export function NativeWorkspace(props: NativeWorkbenchRenderProps & { owner: NativeWorkspaceOwner }): ReactNode {
  const { owner } = props
  const selectedSession = useSyncExternalStore(owner.subscribeMainSession, owner.mainSession, owner.mainSession)
  const sessionId = props.placement === 'main' ? selectedSession : props.sessionId
  const id = useRef(Symbol('workspace')).current
  const foreground = useSyncExternalStore(subscribeVisibility, documentVisible, () => true)
  const visible = props.visible === true && foreground
  const store = useSyncExternalStore(owner.holder.subscribe, owner.holder.getSnapshot, owner.holder.getSnapshot)
  const activity = useSyncExternalStore(owner.state.subscribe, owner.state.getSnapshot, owner.state.getSnapshot)
  useEffect(() => {
    if (visible) return owner.state.mount(id, sessionId)
  }, [owner.state, id, sessionId, visible])
  if (!visible || !activity.active || activity.sessionId !== sessionId) return null
  if (store === undefined) return <p role="status">{owner.t('app.loading')}</p>
  return <PromptWorkspace
    store={store} sessionId={sessionId} view={owner.state.view(sessionId)}
    diagnostics={owner.diagnostics} t={owner.t}
  />
}
