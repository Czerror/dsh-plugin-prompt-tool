export type RewindMode = 'once' | 'round'
export interface RewindRequest {
  phase: 'preview' | 'commit' | 'retry'
  sessionId: string
  mode: RewindMode
  requestId: string
  credential: string
  boundary?: string
}
export interface RewindTargetResult {
  sessionId: string
  status: 'committed' | 'unchanged' | 'failed'
  message?: string
  markerId?: string
  sourceEventSeqs?: number[]
  text?: string
}
export interface RewindResult {
  sessionId: string
  boundary: string
  targets: RewindTargetResult[]
}
