import { useLayoutEffect, type ReactNode } from 'react'
import type { PromptToolHostApi } from './host-api.ts'
import { usePromptToolStore, type PromptToolSettingsTransport } from './use-prompt-tool-store.ts'
import type { WorkspaceStoreHolder } from './workspace-state.ts'

export function WorkspaceStoreOwner(props: {
  api: PromptToolHostApi
  settings: PromptToolSettingsTransport
  holder: WorkspaceStoreHolder
  active?: boolean
}): ReactNode {
  const store = usePromptToolStore(props.api, props.settings, props.active ?? true)
  useLayoutEffect(() => {
    props.holder.publish(store)
  }, [props.holder, store])
  return null
}
