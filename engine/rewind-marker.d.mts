export function isRewindMarker(event: any): boolean
export function rewindPlan(session: any, mode?: 'once' | 'round', acceptsNotice?: (source: { senderSessionId: string }, turnSeq: number) => boolean): { session: any; turnSeq: number; observedTurnSeq: number | undefined; lastInputSeq: number; turn: number; inputId: string; inputSeq: number; text: string; refs: number[] }
export function visibleRewindEntries<T extends { event: any }>(entries: readonly T[]): T[]
