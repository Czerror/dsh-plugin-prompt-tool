/**
 * Bridge 请求体的运行期接受面：与 `BridgeRequestMap` 并列的唯一字段表。
 *
 * `BridgeRequestMap` 是 type，运行期读不到；本表把每个端点的**顶层**字段收敛到一处。
 * - `null`：`body:'none'`，不解析请求体；
 * - `BRIDGE_REQUEST_HANDLER_CHECKED`：handler 已自带更具体的未知字段错误码/消息，保留域内拒绝；
 * - 其余端点由 `assertBridgeRequest` 在 handler 前统一 400。
 *
 * 嵌套对象仍由域内校验；本表只回答「这个顶层键是否属于该端点」。
 */
import {
  BRIDGE_ENDPOINTS,
  type BridgeEndpoint,
  type BridgeEndpointKey,
  type BridgeRequestMap,
} from './bridge-contract.ts'
import { ASSET_IMPORT_FIELD_KEYS } from './asset-transfer.ts'

export const BRIDGE_REQUEST_FIELDS = {
  meta: null,
  bootstrap: ['sessionId'],
  describe: null,
  models: ['refresh'],
  modelReasoning: ['provider', 'model'],
  mutate: ['ops', 'expectedRevision'],
  skillsList: ['sessionId'],
  skillPolicy: ['name', 'path', 'sessionId', 'side', 'enabled', 'scope'],
  skillRead: ['name', 'path', 'sessionId'],
  skillWrite: ['name', 'path', 'sessionId', 'content', 'description', 'expectedRevision'],
  skillsFolders: ['folders', 'sessionId'],
  skillsImport: ['files', 'overwrite'],
  skillsImportDirectory: ['path', 'overwrite'],
  skillCreate: ['name', 'description', 'content'],
  skillDelete: ['name', 'path', 'sessionId'],
  templates: null,
  promptConfigs: ['sessionId'],
  agentsFile: ['sessionId', 'contextId', 'fileId', 'expectedRevision', 'content'],
  instructionsPolicy: ['policy', 'expectedRevision'],
  paramOverrides: ['overrides', 'promptConfigs', 'rebuild', 'expectedModuleId'],
  triggers: null,
  rules: ['expectedModuleId', 'expectedRevisions', 'expectedRulesAbsent', 'createRule', 'edits', 'activateRuleId', 'validateOnly', 'refreshOnly'],
  persona: ['persona', 'expectedModuleId', 'expectedRevision', 'refreshOnly'],
  personaSources: ['sources', 'expectedRevision', 'refreshOnly'],
  moduleVariables: ['scope', 'variables', 'enabled', 'expectedModuleId', 'expectedRevisions', 'refreshOnly'],
  customTools: ['customTools', 'expectedModuleId'],
  importModulePackage: ASSET_IMPORT_FIELD_KEYS,
  assetUpload: null,
  assetRelease: ['sourceId'],
  exportModule: ['id', 'mode', 'preview', 'expectedRevision', 'memoryChoices'],
  moduleDelete: ['id'],
  moduleClone: ['id', 'autoSuffix'],
  moduleDuplicate: ['id'],
  moduleOpen: ['id'],
  moduleName: ['name', 'expectedRevision', 'expectedModuleId'],
  moduleEnable: ['id', 'enabled'],
  moduleConfigOrder: ['moduleId', 'entries', 'expectedRevision'],
  charactersImport: ASSET_IMPORT_FIELD_KEYS,
  charactersImportStream: null,
  moduleMerge: ['id'],
  moduleUnmerge: ['id'],
  toolSurface: ['sessionId', 'presetId'],
  moduleCapability: ['action', 'capabilityId', 'recipeId', 'expectedModuleId'],
  contextActivationDiagnostics: ['sessionId'],
  ruleDiagnostics: [],
} as const satisfies Record<BridgeEndpointKey, readonly string[] | null>

type RequestFieldKeys<T> = T extends unknown ? keyof NonNullable<T> : never
type RequestFieldCheck = {
  [K in BridgeEndpointKey]: (typeof BRIDGE_REQUEST_FIELDS)[K] extends null
    ? null
    : ReadonlyArray<Extract<RequestFieldKeys<BridgeRequestMap[K]>, string>>
}
const requestFieldCheck: RequestFieldCheck = BRIDGE_REQUEST_FIELDS
void requestFieldCheck

/** handler 已拒绝未知字段的端点：保留它们的错误码/消息，统一断言不重复拦截。 */
export const BRIDGE_REQUEST_HANDLER_CHECKED = new Set<BridgeEndpoint>([
  BRIDGE_ENDPOINTS.assetRelease,
  BRIDGE_ENDPOINTS.exportModule,
  BRIDGE_ENDPOINTS.moduleVariables,
  BRIDGE_ENDPOINTS.moduleName,
  BRIDGE_ENDPOINTS.moduleConfigOrder,
  BRIDGE_ENDPOINTS.rules,
  BRIDGE_ENDPOINTS.persona,
  BRIDGE_ENDPOINTS.personaSources,
  BRIDGE_ENDPOINTS.importModulePackage,
  BRIDGE_ENDPOINTS.charactersImport,
])

const FIELDS_BY_PATH = new Map<string, readonly string[] | null>(
  (Object.entries(BRIDGE_REQUEST_FIELDS) as Array<[BridgeEndpointKey, readonly string[] | null]>)
    .map(([key, fields]) => [BRIDGE_ENDPOINTS[key], fields]),
)

/** 断言一次请求只带该端点的顶层字段；handler-owned 与 body:none 端点不在这里拒绝。 */
export function assertBridgeRequest(endpoint: string, record: Record<string, unknown>): void {
  if (BRIDGE_REQUEST_HANDLER_CHECKED.has(endpoint as BridgeEndpoint)) return
  const fields = FIELDS_BY_PATH.get(endpoint)
  if (fields === undefined) throw new Error('未登记请求字段：' + endpoint)
  if (fields === null) return
  const unknown = Object.keys(record).filter(key => !fields.includes(key))
  if (unknown.length > 0) throw new TypeError('未知请求字段：' + unknown.join(', '))
}
