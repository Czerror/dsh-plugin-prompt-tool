import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
export function installToolStepAssembly(ctx: Context, options: {
  knows(agent: Agent): boolean
  ensureFresh(agent: Agent): Promise<void>
  assemble(context: AssembleContext, invoke: () => Promise<PromptAssembly>): Promise<PromptAssembly>
  settle(assembly: PromptAssembly, context: AssembleContext): Promise<PromptAssembly>
}): () => void
