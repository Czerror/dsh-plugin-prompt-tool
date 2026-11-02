import type { TemplateSnapshot } from './template-evaluation.mjs'
export interface TemplateVariableStore {
  read(moduleId: string, context?: { agent?: unknown; signal?: AbortSignal }): { module: Record<string, string>; global: Record<string, string>; session?: Record<string, string>; effective?: Record<string, string>; enabled?: boolean; revisions: { module: string; global: string | null; session?: string | null; settings?: string }; assertCurrent?: (context: { agent?: unknown; signal?: AbortSignal }) => void }
  readRuntime?(moduleId: string, key: string, context?: { agent?: unknown; signal?: AbortSignal }): string | undefined
  commit(moduleId: string, request: { scope: 'global' | 'module' | 'session'; changes: Record<string, string>; expectedRevisions: { module?: string; global?: string | null; session?: string | null; settings?: string } }, context?: { agent?: unknown; signal?: AbortSignal }): { persisted?: boolean; publicationPending?: boolean } | Promise<{ persisted?: boolean; publicationPending?: boolean }>
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
/** preview 仅供挂载预检：副本求值，不提交变量或消费执行凭据；session 赋值仍拒绝。 */
export function renderTemplate(config: TemplateConfig, context?: { agent?: unknown; signal?: AbortSignal }, options?: { variableStore?: TemplateVariableStore; enabled?: boolean; warn?: (message: string) => void; preview?: boolean }): string
export function renderTemplateAsync(config: TemplateConfig, context?: { agent?: unknown; signal?: AbortSignal }, options?: { variableStore?: TemplateVariableStore; enabled?: boolean; warn?: (message: string) => void }): Promise<string>
