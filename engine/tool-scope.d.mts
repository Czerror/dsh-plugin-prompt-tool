import type { ToolActivationContext, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
export interface ToolStep {
  status: 'pending' | 'sealed' | 'closed'
  modelSelection: ToolActivationContext['modelSelection'] | undefined
  allowed?: ReadonlySet<string>
  toolSet: ResolvedToolSet
}
export function toolStepOf(toolSet: unknown, agent: unknown): ToolStep | undefined
export function hasToolStep(toolSet: unknown): boolean
export function associateToolStep(original: ResolvedToolSet, wrapped: ResolvedToolSet, agent: object, step: ToolStep): void
/** null 表示同一 selection 对同 Agent 存在歧义；不得改读最新步骤。 */
export function toolStepFor(context: unknown, agent?: unknown): ToolStep | null | undefined
export function associateToolSelection(selection: unknown, agent: object, step: ToolStep): void
export function toolStepContext<T>(context: T): T
export function associateToolAssembly(assembly: PromptAssembly, agent: object, step: ToolStep): void
export function toolAssemblyContext(assembly: PromptAssembly, context: AssembleContext): AssembleContext | undefined
export function beginToolCatalog(context: AssembleContext): void
export function deferToolCatalog(context: AssembleContext, render: (assembly: PromptAssembly) => Promise<void>): boolean
export function settleToolCatalog(assembly: PromptAssembly, context: AssembleContext): Promise<void>
export function toolCatalogNames(context: unknown): ReadonlySet<string> | null | undefined
