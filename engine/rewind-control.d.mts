export function isRewindAction(action: unknown): boolean
export function validateRewindAction(action: unknown): void
export function registerRewindControl(agent: object, enabled: (capability: string) => boolean): () => void
export function rewindEnabled(agent: object, capability?: string): boolean
