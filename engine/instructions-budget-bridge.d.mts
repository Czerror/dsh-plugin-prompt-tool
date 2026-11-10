export function instructionsBudgetStatus(agent?: unknown): { available: boolean; reason: string }
export function registerInstructionsBudgetReader(read: (agent: unknown, modelSelection?: unknown) => number | undefined): () => void
