import type { ToolActivationContext, ResolvedToolSet } from '@deepseek-ai/dsh-tools'
export interface ToolStep {
  status: 'pending' | 'sealed' | 'closed'
  modelSelection: ToolActivationContext['modelSelection'] | undefined
  allowed?: ReadonlySet<string>
}
export function toolStepOf(toolSet: unknown, agent: unknown): ToolStep | undefined
export function hasToolStep(toolSet: unknown): boolean
export function associateToolStep(original: ResolvedToolSet, wrapped: ResolvedToolSet, agent: object, step: ToolStep): void
