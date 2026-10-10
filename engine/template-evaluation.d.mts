export interface TemplateSnapshot {
  module?: Readonly<Record<string, string>>
  global?: Readonly<Record<string, string>>
  session?: unknown
  sourceId?: string
  readOnly?: boolean
  samples?: Map<string, string>
}
export interface TemplateResult {
  text: string
  reads: Array<'global' | 'module'>
  changes?: { scope: 'global' | 'module'; values: Record<string, string> }
}
export function evaluateTemplate(text: string, options?: TemplateSnapshot): TemplateResult
export function transformTemplate(text: string, macro: (body: string, expand: (value: string) => string, occurrence: number) => string): string
export function splitTemplateArgument(text: string): [string, string | undefined]
