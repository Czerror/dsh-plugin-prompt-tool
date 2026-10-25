import type { PublicationFields } from './publication.ts'

/** 持久变量的两级值与模块求值开关；所有调用方共用版本域。 */
export type ModuleVariableScope = 'global' | 'module'

export interface ModuleVariableRevisions {
  global: string | null
  module: string
  settings: string
}

export interface ModuleVariablesSnapshot extends PublicationFields {
  global: Record<string, string>
  module: Record<string, string>
  effective: Record<string, string>
  revisions: ModuleVariableRevisions
  enabled: boolean
}

export interface ModuleVariablesRequest {
  scope: ModuleVariableScope
  variables?: Record<string, string>
  enabled?: boolean
  expectedModuleId?: string
  expectedRevisions?: Partial<ModuleVariableRevisions>
  refreshOnly?: boolean
}
