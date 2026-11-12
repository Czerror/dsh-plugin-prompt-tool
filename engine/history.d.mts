import type { Agent } from '@deepseek-ai/dsh-agent'
type Session = Agent['session']
type SessionEvent = ReturnType<Session['snapshotEvents']>[number]
export function historyEvents(session: Session): SessionEvent[]
export function currentEvents(session: Session): SessionEvent[]
export function viewRestricted(session: Session, events?: SessionEvent[]): boolean
export const TOOL_INVOCATION_EVENT_TYPES: readonly string[]
export const SURFACE_MESSAGE_TYPES: Set<string>
