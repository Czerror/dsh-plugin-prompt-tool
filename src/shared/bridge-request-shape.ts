/**
 * Bridge 请求体的运行期接受面：与 `BridgeRequestMap` 并列的唯一字段表。
 *
 * 每个端点两态之一：
 * - `{ body: 'none' }`：不解析请求体；
 * - `{ fields }`：由 `assertBridgeRequest` 在 handler 前统一 400。
 *
 * 覆盖是双向的：fields 态的键集必须与 `BridgeRequestMap` 的字段互为子集；none 态要求
 * 类型为 `undefined`。漏改任一侧在 typecheck 失败，不会有「表漏登记、运行期才 400」。
 * handler 只保留类型/枚举/互斥/身份/版本/读写组合等语义校验，不再手抄字段名单。
 */
import {
  BRIDGE_ENDPOINTS,
  type BridgeEndpointKey,
  type BridgeRequestMap,
} from './bridge-contract.ts'
import { ASSET_IMPORT_FIELD_KEYS } from './asset-transfer.ts'

type RequestFieldRule =
  | { body: 'none' }
  | { fields: readonly string[] }

export const BRIDGE_REQUEST_FIELDS = {
  meta: { body: 'none' },
  bootstrap: { fields: ['sessionId'] },
  describe: { body: 'none' },
  models: { fields: ['refresh'] },
  modelReasoning: { fields: ['provider', 'model'] },
  mutate: { fields: ['ops', 'expectedRevision'] },
  skillsList: { fields: ['sessionId'] },
  skillPolicy: { fields: ['name', 'path', 'sessionId', 'side', 'enabled', 'scope'] },
  skillRead: { fields: ['name', 'path', 'sessionId'] },
  skillWrite: { fields: ['name', 'path', 'sessionId', 'content', 'description', 'expectedRevision'] },
  skillsFolders: { fields: ['folders', 'sessionId'] },
  skillsImport: { fields: ['files', 'overwrite'] },
  skillsImportDirectory: { fields: ['path', 'overwrite'] },
  skillCreate: { fields: ['name', 'description', 'content'] },
  skillDelete: { fields: ['name', 'path', 'sessionId'] },
  templates: { body: 'none' },
  promptConfigs: { fields: ['sessionId'] },
  agentsFile: { fields: ['sessionId', 'contextId', 'fileId', 'expectedRevision', 'content'] },
  instructionsPolicy: { fields: ['policy', 'expectedRevision'] },
  paramOverrides: { fields: ['overrides', 'promptConfigs', 'rebuild', 'expectedModuleId', 'refreshOnly'] },
  // 退役端点（410）：请求类型已改为 undefined，这里只有「无 body」这一事实。
  triggers: { body: 'none' },
  rules: { fields: ['expectedModuleId', 'expectedRevisions', 'expectedRulesAbsent', 'createRule', 'edits', 'activateRuleId', 'validateOnly', 'refreshOnly'] },
  persona: { fields: ['persona', 'expectedModuleId', 'expectedRevision', 'refreshOnly'] },
  personaSources: { fields: ['sources', 'expectedRevision', 'refreshOnly'] },
  moduleVariables: { fields: ['scope', 'variables', 'enabled', 'expectedModuleId', 'expectedRevisions', 'refreshOnly'] },
  customTools: { fields: ['customTools', 'expectedModuleId', 'refreshOnly'] },
  importModulePackage: { fields: [...ASSET_IMPORT_FIELD_KEYS, 'refreshOnly'] },
  assetUpload: { body: 'none' },
  assetRelease: { fields: ['sourceId'] },
  exportModule: { fields: ['id', 'mode', 'preview', 'expectedRevision', 'memoryChoices'] },
  moduleDelete: { fields: ['id', 'refreshOnly'] },
  moduleClone: { fields: ['id', 'autoSuffix', 'refreshOnly'] },
  moduleDuplicate: { fields: ['id', 'refreshOnly'] },
  moduleOpen: { fields: ['id'] },
  moduleName: { fields: ['name', 'expectedRevision', 'expectedModuleId', 'refreshOnly'] },
  moduleEnable: { fields: ['id', 'enabled', 'refreshOnly'] },
  moduleConfigOrder: { fields: ['moduleId', 'entries', 'expectedRevision', 'refreshOnly'] },
  toolSurface: { fields: ['sessionId', 'presetId'] },
  moduleCapability: { fields: ['action', 'capabilityId', 'recipeId', 'expectedModuleId', 'refreshOnly'] },
  contextActivationDiagnostics: { fields: ['sessionId'] },
  ruleDiagnostics: { fields: [] },
} as const satisfies Record<BridgeEndpointKey, RequestFieldRule>

type FieldRuleOf<K extends BridgeEndpointKey> = (typeof BRIDGE_REQUEST_FIELDS)[K]
/** 请求类型去掉 undefined 的键集；undefined 端点没有请求字段。 */
type RequestKeysOf<T> = T extends undefined ? never : keyof NonNullable<T>

/** 失败用 `false` 而不是 `never`：`never extends true` 为真，会吞掉断言。 */
type NoneCoverage<K extends BridgeEndpointKey> = FieldRuleOf<K> extends { body: 'none' }
  ? [BridgeRequestMap[K]] extends [undefined] ? true : false
  : true

/** 双向：表键集与请求类型的字段互为子集。 */
type FieldsCoverage<K extends BridgeEndpointKey> = FieldRuleOf<K> extends { fields: readonly (infer F)[] }
  ? [Exclude<F, RequestKeysOf<BridgeRequestMap[K]>>] extends [never]
    ? [Exclude<RequestKeysOf<BridgeRequestMap[K]>, F>] extends [never] ? true : false
    : false
  : true

type CoverageOf<K extends BridgeEndpointKey> = [NoneCoverage<K>] extends [true] ? FieldsCoverage<K> : false
type CoverageMap = { [K in BridgeEndpointKey]: CoverageOf<K> }
type BadCoverage = Exclude<CoverageMap[BridgeEndpointKey], true>

/** 编译期断言：任一端点的类型与表不一致时，这里的赋值失败。 */
const _requestShapeCoverage: BadCoverage extends never ? true : false = true
void _requestShapeCoverage

const RULES_BY_PATH = new Map<string, RequestFieldRule>(
  (Object.entries(BRIDGE_REQUEST_FIELDS) as Array<[BridgeEndpointKey, RequestFieldRule]>)
    .map(([key, rule]) => [BRIDGE_ENDPOINTS[key], rule]),
)

/** 断言一次请求只带该端点的顶层字段；body:none 端点不在这里拒绝。 */
export function assertBridgeRequest(endpoint: string, record: Record<string, unknown>): void {
  const rule = RULES_BY_PATH.get(endpoint)
  if (rule === undefined) throw new Error('未登记请求字段：' + endpoint)
  if ('body' in rule) return
  const unknown = Object.keys(record).filter((key) => !rule.fields.includes(key))
  if (unknown.length > 0) throw new TypeError('未知请求字段：' + unknown.join(', '))
}
