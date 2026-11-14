import type { BridgeEndpointKey } from '../../shared/bridge-contract.ts'

const listeners = new Set<() => void>()

export function subscribeConfigurationChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function configurationChanged(endpoint: BridgeEndpointKey, body: unknown): void {
  const request = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  const mutations: Partial<Record<BridgeEndpointKey, () => boolean>> = {
    mutate: () => Array.isArray(request.ops) && request.ops.length > 0,
    agentsFile: () => typeof request.content === 'string',
    instructionsPolicy: () => request.policy !== undefined,
    paramOverrides: () => request.overrides !== undefined || request.promptConfigs !== undefined,
    rules: () => request.validateOnly !== true && (request.createRule !== undefined || request.edits !== undefined || request.activateRuleId !== undefined),
    moduleVariables: () => request.variables !== undefined || request.enabled !== undefined,
    customTools: () => request.customTools !== undefined,
    importModulePackage: () => request.preview !== true,
    moduleDelete: () => true,
    moduleClone: () => true,
    moduleDuplicate: () => true,
    moduleName: () => typeof request.name === 'string',
    moduleEnable: () => true,
    moduleConfigOrder: () => Array.isArray(request.entries),
    moduleCapability: () => typeof request.action === 'string',
  }
  const writes = mutations[endpoint] !== undefined && (request.refreshOnly === true || mutations[endpoint]?.() === true)
  if (writes) for (const listener of listeners) listener()
}
