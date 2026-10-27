export type RetrievalEvent = { readonly seq: number; readonly type: string }
export type SessionReference = { kind: 'session'; moduleId: string; sessionId: string; seqs: number[]; revision: string; start: number; end: number }
export const MAX_REFERENCE_CHARS: number
export function sessionReferenceText(events: readonly RetrievalEvent[], seqs: readonly number[]): string
export function makeSessionReference(moduleId: string, sessionId: string, events: readonly RetrievalEvent[], seqs: readonly number[], range?: { start?: number; end?: number }): SessionReference
