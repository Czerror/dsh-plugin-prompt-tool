import type { TemplateSnapshot } from './template-evaluation.mjs'
export interface TemplateVariableStore {
  read(moduleId: string): { module: Record<string, string>; global: Record<string, string>; enabled?: boolean; revisions: { module: string; global: string | null; settings?: string } }
  commit(moduleId: string, request: { scope: 'global' | 'module'; changes: Record<string, string>; expectedRevisions: { module?: string; global?: string | null; settings?: string } }): { publicationPending?: boolean }
  publish(moduleId: string): void
}
export interface TemplateConfig {
  sourceModuleId: string
  ruleId?: string
  id: string
  texts: string[]
  variables?: TemplateSnapshot['module']
  variableStore?: TemplateVariableStore
}
export function templateExecutionKey(agent: unknown, signal?: AbortSignal): string | undefined
export function renderTemplate(config: TemplateConfig, context?: { agent?: unknown; signal?: AbortSignal }, options?: { variableStore?: TemplateVariableStore; enabled?: boolean; warn?: (message: string) => void }): string
