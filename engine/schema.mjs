/**
 * schema — prompt-config-engine 的提示词配置加载、归一化与权威校验。
 * 只负责"配置长什么样";执行语义见 executor.mjs,内容策略见 strategies.mjs。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { bindResolver } from './strategies.mjs'
import { compareConfigSequence } from './order.mjs'
import { SUBJECT_FIELDS } from './condition-facts.mjs'
import { pluginKind, pluginOwner } from './source-kind.mjs'
import { CONTEXT_ACTIVATION_STRATEGY } from './strategy-ids.mjs'

const name = 'rule-engine'

/**
 * 内容模板加载:提示词配置可声明 templateFile,由外部 yml / json / 纯文本模板提供内容,
 * 引擎只负责读取与注入(内容与执行分离)。
 *   - .json:解析为 { text, id?, role?, content?, source? },或纯字符串;
 *   - .yml/.yaml:用 vendored yaml 完整解析(顶层对象取 text 等字段);
 *   - 其他扩展名:整个文件内容作为 text。
 */
function readTextFile(url) {
  return readFileSync(url, 'utf8')
}

function loadTemplate(file, baseUrl = import.meta.url, presetRootUrl) {
  if (typeof file !== 'string' || file.length === 0) return undefined
  // 预设根基准：显式注入优先（引擎由插件包提供、不再位于 <预设根>/.engine/ 时必需），
  // 缺省沿用「引擎文件的上一级目录」这一历史布局推导；加载与边界检查复用同一基准。
  // URL 相对解析要求基准按目录语义以 `/` 结尾，调用方传裸预设根时在此补齐。
  const rootUrl = presetRootUrl === undefined
    ? new URL('../..', baseUrl)
    : new URL(String(presetRootUrl).replace(/\/?$/, '/'))
  const presetRoot = fileURLToPath(rootUrl).replace(/[\\\\/]$/, '')
  // templateFile 只允许 canonical 预设目录（引擎父目录）内：防配置声明任意
  // 本地路径把文件内容带进模型上下文。非 file: 协议（绝对盘符被解析为 scheme）同样拒绝。
  let resolved
  try {
    resolved = fileURLToPath(new URL(file, baseUrl))
  } catch {
    throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} escapes preset root`)
  }
  if (resolved !== presetRoot && !resolved.startsWith(presetRoot + sep)) {
    throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} escapes preset root`)
  }
  let raw
  try {
    raw = readTextFile(new URL(file, baseUrl))
  } catch {
    throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not readable`)
  }
  if (/\.json$/i.test(file)) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid JSON: ${String(error?.message ?? error)}`)
    }
  }
  if (/\.ya?ml$/i.test(file)) {
    try {
      const parsed = parseYaml(raw)
      return typeof parsed === 'string' ? { text: parsed } : parsed
    } catch (error) {
      throw new TypeError(`${name}: templateFile ${JSON.stringify(file)} is not valid YAML: ${String(error?.message ?? error)}`)
    }
  }
  return { text: raw }
}

export const KNOWN_STRATEGIES = new Set(['static', 'placeholder', CONTEXT_ACTIVATION_STRATEGY])
/**
 * 策略 × 层支持矩阵：`config.resolve` 只在 pre-step（executor）与 runtime-context 的
 * placeholder（layers）被消费，其他层声明非 static 策略会绑定 resolver 却无人调用，
 * 表现为「配了没效果、也不报错」。这里把该事实写成校验：不支持的组合挂载期 fail loud。
 * `static: null` 表示全层可用；模板专属策略（strategyDir 懒加载）与内置策略同样受限。
 */
export const STRATEGY_LAYER_SUPPORT = {
  static: null,
  placeholder: ['pre-step', 'runtime-context'],
  [CONTEXT_ACTIVATION_STRATEGY]: ['pre-step'],
}
/** 模板专属策略允许的层：resolver 同样只在 pre-step / runtime-context 被调用。 */
const TEMPLATE_STRATEGY_LAYERS = ['pre-step', 'runtime-context']
export const KNOWN_SLOT_KINDS = new Set(['ordered', 'anchor'])
/**
 * 九个官方注入层的**唯一权威定义**（B5 T1：原 `LAYER_ORDER` / `LAYER_FIELD_POLICIES` /
 * `LAYER_EDITING` / `LAYER_LABELS` 四处事实合一）。
 *
 * 新增或改一层只动这里一处：
 *   - 数组顺序即 `layerOrder`（**产品定义**，改顺序等于改 UI 组织，不要只为排序调整）；
 *   - `channel` / `phase` 是该层 `inject-text` 的**唯一注册点**（缺 `channel` 的层不可注入：
 *     `tool-pipeline` 的工具链裁决改用 `tool-gate` / `append-context` 动作）；
 *   - `fields` 是层能力矩阵（9 项，客户端表单据此动态渲染）；
 *   - `editing` 是字段能力表（content / variables / messageMetadata / params）；
 *   - `label` 是由引擎统一下发给客户端的显示名与说明。
 *
 * 下面所有导出都由本表**派生**，并保持既有名字与形状，外部消费方不受影响。
 */
const LAYER_DEFINITIONS = [
  {
    layer: 'pre-step',
    channel: 'agent/pre-step', phase: 'after-next',
    fields: { position: true, dedupe: true, promotion: true, audience: true, modelScope: true, merge: true, order: true, role: true, placeholder: true },
    editing: { content: 'text', variables: true, messageMetadata: true, params: {} },
    label: { title: '消息批层', detail: '官方默认层：agent/pre-step 消息批。支持 position / dedupe / promotion / audience / mergeMode 与文本插值。' },
  },
  {
    layer: 'system-section',
    channel: 'system-prompt/assemble', phase: 'before-next',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: false, merge: true, order: true, role: false, placeholder: false },
    editing: { content: 'text', variables: true, messageMetadata: false,
      params: { sectionName: { type: 'string' }, complete: { type: 'boolean' }, suppressRuntimeContext: { type: 'boolean' } } },
    label: { title: '系统段层', detail: 'system-section 静态层：注册即全局，由 order 与 params.complete / sectionName 控制。' },
  },
  {
    layer: 'runtime-context',
    channel: 'system-prompt/assemble', phase: 'before-next',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: false, merge: true, order: true, role: false, placeholder: true },
    editing: { content: 'text', variables: true, messageMetadata: false, params: { contextName: { type: 'string' } } },
    label: { title: '运行上下文', detail: 'runtime-context 层：static 按 order 注册，placeholder 单条生效，由 params.contextName 控制。' },
  },
  {
    layer: 'agent-request',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'request', variables: false, messageMetadata: false, params: {} },
    label: { title: '调用配置层', detail: 'agent/request 的请求参数由 request-params 动作修改。' },
  },
  {
    layer: 'llm-stream',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'stream', variables: false, messageMetadata: false, params: {} },
    label: { title: '模型流层', detail: 'llm/stream 的透传与替换由 stream-output 动作处理。' },
  },
  {
    layer: 'tool-pipeline',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'tool-result', variables: false, messageMetadata: false,
      // 该层没有注入通道：旧的四项工具链参数（toolNames / preDecision / denyReason / postAction）
      // 没有任何消费者，已删除；工具链行为由 tool-gate / tool-result 动作承担。
      params: {} },
    label: { title: '工具管线层', detail: '工具链层：只作规则级展示归属（无 inject-text 通道）——工具链的裁决与追加上下文由 tool-gate / tool-result / append-context 动作承担。' },
  },
  {
    layer: 'turn-stop',
    channel: 'agent/turn-stopping', phase: 'before-next',
    fields: { position: false, dedupe: true, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'text', variables: true, messageMetadata: false, params: {} },
    label: { title: '轮次停止层', detail: 'agent/turn-stopping 层：命中条件时强制续跑一步；引擎内置续跑上限，不可用配置关闭。' },
  },
  {
    layer: 'subagent-start',
    channel: 'subagent/start', phase: 'before-next',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'text', variables: true, messageMetadata: false, params: {} },
    label: { title: '子代理启动层', detail: 'subagent/start 层：命中条件时向该子代理注入上下文。' },
  },
  {
    layer: 'subagent-end',
    channel: 'subagent/end', phase: 'before-next',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false },
    editing: { content: 'subagent-result', variables: true, messageMetadata: false,
      params: { action: { type: 'enum', values: ['observe', 'inject-main'] } } },
    label: { title: '子代理结束层', detail: 'subagent/end 层：默认记录；action=inject-main 时向所属主会话注入配置文本，不改写子代理返回结果。' },
  },
]

/** 九个官方注入层的固定顺序：/meta 的 layerOrder、UI 层序与模板菜单共用这一份。 */
export const LAYER_ORDER = LAYER_DEFINITIONS.map((definition) => definition.layer)
export const KNOWN_LAYERS = new Set(LAYER_ORDER)
/**
 * `inject-text` 可绑定的层与注册点（由 {@link LAYER_DEFINITIONS} 的 `channel` 派生，不另写层表）：
 * 没有通道的 `tool-pipeline` 不可注入——工具链的裁决与结果处理走 `tool-gate` / `tool-result` / `append-context` 动作。
 * `LAYER_ORDER` 九层供展示；六个注入层供 `config.layer`，其余由独立动作承担。
 */
const INJECTION_DEFINITIONS = LAYER_DEFINITIONS.filter((definition) => definition.channel !== undefined)
export const INJECTION_LAYERS = INJECTION_DEFINITIONS.map((definition) => definition.layer)
export const INJECTION_CHANNELS = Object.fromEntries(
  INJECTION_DEFINITIONS.map((definition) => [definition.layer, { channel: definition.channel, phase: definition.phase }]),
)
/**
 * live 规则条件的匹配对象（if.text.subject / if.anchor.subject）：
 * 由 condition-facts 的 SUBJECT_FIELDS 派生，单一来源；不再用于旧 config.subject。
 */
export const KNOWN_SUBJECTS = new Set(Object.keys(SUBJECT_FIELDS))
export const KNOWN_POSITIONS = new Set(['after-user', 'before-all', 'after-all'])
export const KNOWN_DEDUPES = new Set(['session', 'batch', 'none'])
export const KNOWN_PROMOTIONS = new Set(['none', 'main', 'include-subagents'])
/** audience 专用标记：缺省（null/省略）= 公用（主会话+子代理通用）；main=仅主会话；subagent=仅子代理。 */
export const KNOWN_AUDIENCES = new Set(['main', 'subagent'])
export const KNOWN_MERGE_MODES = new Set(['separate', 'merged'])
export const KNOWN_MODEL_SCOPES = new Set(['all', 'pro', 'flash'])
/**
 * pre-step 批次写成宿主 `user/message` 事件，配置只接受 user。
 * 自定义策略或模板 patch 的角色仍由 executor 在出口校验，避免写出非法事件。
 */
export const KNOWN_ROLES = new Set(['user'])
export const KNOWN_FILLS = new Set(['instruction-hint', 'env-facts', 'skill-catalog', 'tool-catalog'])

/** 层能力矩阵：每个字段只在对应注入层生效。客户端表单据此动态渲染。 */
export const LAYER_FIELD_POLICIES = Object.fromEntries(
  LAYER_DEFINITIONS.map((definition) => [definition.layer, definition.fields]),
)

/** 局部参数只登记真实消费字段；未知扩展键仍保留，策略参数由各策略消费。 */
const LAYER_EDITING = Object.fromEntries(
  LAYER_DEFINITIONS.map((definition) => [definition.layer, definition.editing]),
)

export const LAYER_CONTRACTS = Object.fromEntries(LAYER_ORDER.map(layer => [layer, {
  strategies: [...KNOWN_STRATEGIES].filter(strategy => STRATEGY_LAYER_SUPPORT[strategy] === null || STRATEGY_LAYER_SUPPORT[strategy].includes(layer)),
  ...LAYER_EDITING[layer],
}]))

/** 层显示名与说明：由引擎统一下发，客户端不再各自维护。 */
export const LAYER_LABELS = Object.fromEntries(
  LAYER_DEFINITIONS.map((definition) => [definition.layer, definition.label]),
)

/** 引擎能力矩阵：作为 /meta 的唯一数据源，客户端表单据此动态渲染。 */
export function getEngineMeta() {
  return {
    // layerOrder = 固定九层顺序（UI 组织用）；layers = 合法层集合（校验与旧消费方用）；
    // injectionLayers 只含实际文本注入层；请求、流与工具管线使用独立动作。
    layerOrder: [...LAYER_ORDER],
    layers: [...KNOWN_LAYERS].sort(),
    injectionLayers: [...INJECTION_LAYERS],
    strategies: [...KNOWN_STRATEGIES].sort(),
    slotKinds: [...KNOWN_SLOT_KINDS].sort(),
    positions: [...KNOWN_POSITIONS].sort(),
    dedupes: [...KNOWN_DEDUPES].sort(),
    promotions: [...KNOWN_PROMOTIONS].sort(),
  audienceModes: [...KNOWN_AUDIENCES].sort(),
    modelScopes: [...KNOWN_MODEL_SCOPES].sort(),
    roles: [...KNOWN_ROLES].sort(),
    mergeModes: [...KNOWN_MERGE_MODES].sort(),
    fills: [...KNOWN_FILLS].sort(),
    subjects: [...KNOWN_SUBJECTS].sort(),
    layerFieldPolicies: LAYER_FIELD_POLICIES,
    layerLabels: LAYER_LABELS,
    layerContracts: structuredClone(LAYER_CONTRACTS),
  }
}

/**
 * 官方 `LlmCallConfig` 允许被改写的键：不能把消息、工具或 system 塞进请求配置。
 * `request-params` 动作的 `patch`/`unset` 共用这一份。
 *
 * 核对到 `@deepseek-ai/dsh-llm@0.2.1-alpha.2`（上游 `packages/llm/llm/src/call-config.ts`）：
 * `provider`/`model` 属 `LlmCallConfig`，其余四个自 0.2.1 起拆在 `LlmCallControls`，字段集未变。
 * 上游同处留了 `TODO(call-config-shape)`（讨论 epoch 级字段与 provider 专属选项的归属），
 * 所以这张表将来可能扩——它漂了本项目不会变红，升级 `dsh-llm` 时要手动再对一次。
 */
const LLM_CALL_FIELDS = new Set(['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'])

/**
 * 校验请求配置补丁的子键与值；拼错的键与非法值在保存/挂载前拒绝。
 * @param label 已拼好的报错前缀（`<config label>.params.patch` 或 `action <id>.patch`）
 */
export function assertLlmCallPatch(patch, label) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TypeError(`${label} must be an object`)
  for (const [key, value] of Object.entries(patch)) {
    if (!LLM_CALL_FIELDS.has(key)) throw new TypeError(`${label}.${key} is not a LlmCallConfig field`)
    const valid = key === 'temperature' ? typeof value === 'number' && Number.isFinite(value)
      : key === 'maxTokens' ? Number.isSafeInteger(value) && value > 0
        : key === 'stop' ? Array.isArray(value) && value.every(item => typeof item === 'string')
          : typeof value === 'string' && value.trim().length > 0
    if (!valid) throw new TypeError(`${label}.${key} has an invalid value`)
  }
}

/**
 * `replace=true` 的不变量：整体替换会丢掉下游 provider/model，缺一即不可用。
 * 由 request-params 动作消费；报错前缀由 label 承载。
 * @param label 已拼好的报错前缀（`<config label>.params.patch` 或 `action <id>.patch`）
 */
export function assertReplacePatch(patch, replace, label) {
  if (replace === true && (!patch?.provider || !patch?.model)) {
    throw new TypeError(`${label} requires provider and model when replace=true`)
  }
}

function normalizeLayerParams(raw, layer, label) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${label}.params must be an object`)
  const params = raw
  for (const [key, rule] of Object.entries(LAYER_CONTRACTS[layer].params)) {
    const value = params[key]
    if (value === undefined) continue
    const valid = rule.type === 'enum' ? rule.values.includes(value)
      : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : typeof value === rule.type
    if (!valid) throw new TypeError(`${label}.params.${key} must be ${rule.type === 'enum' ? rule.values.join(' | ') : rule.type}`)
  }
  return params
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0

/**
 * promptConfig 标量字段的校验与归一声明（B5 T2）。
 *
 * 原来 `createPromptConfigs` 里同一个模式手写了 15 遍（`const X = spec.X ?? D` 紧跟
 * `if (!KNOWN_X.has(X)) throw …`）。这里把「枚举 / 缺省 / 形态」收进一份表，遍历一次完成。
 *
 * 三个旋钮覆盖现状里**逐字段不同**的三种 null 处置，必须逐条保留：
 *   - `known` + `default`：`null`/`undefined` 取缺省，其余必须是枚举成员（原 `spec.X ?? D`）；
 *   - `keepNull`：显式 `null` 合法且**原样保留**（audience 专用：null = 公用，与缺省的
 *     undefined 不是同一档）；
 *   - `optional`：缺失即不设置；一旦存在（**含 null**）就按 `validate` 校验形态。
 *
 * 表里需要额外上下文的项用 `resolve`。**表顺序 = 报错顺序**：与手写版逐个检查的先后完全一致，
 * 同一组非法输入必须先报同一处。
 *
 * 不在此表（各自领域的权威，留在原处）：`params`（`normalizeLayerParams`）、
 * `text`/`texts`（多来源合并）、`strategy`/`configKind`/`layer`（各自带额外上下文校验）。
 */
export const CONFIG_FIELDS = [
  { field: 'position', known: KNOWN_POSITIONS, default: 'after-user' },
  { field: 'dedupe', known: KNOWN_DEDUPES, default: 'none' },
  { field: 'promotion', known: KNOWN_PROMOTIONS, default: 'none' },
  { field: 'audience', known: KNOWN_AUDIENCES, keepNull: true, keepMissing: true },
  { field: 'modelScope', known: KNOWN_MODEL_SCOPES, default: 'all' },
  { field: 'role', known: KNOWN_ROLES, default: 'user' },
  {
    field: 'identity',
    resolve: (spec, { label }) => {
      // identity 仅支持 plugin 命名空间（kind 模式与 sourceKind 重复，已归一）。
      const identity = spec.identity ?? { field: 'plugin', value: spec.id }
      if (identity === null || typeof identity !== 'object' || Array.isArray(identity)
        || identity.field !== 'plugin' || typeof identity.value !== 'string' || identity.value.length === 0) {
        throw new TypeError(`${name}: ${label}.identity must be { field: 'plugin', value: string }`)
      }
      return identity
    },
  },
  { field: 'order', default: 0, validate: isFiniteNumber, problem: 'must be a finite number' },
  { field: 'group', optional: true, validate: isNonEmptyString, problem: 'must be a non-empty string when present' },
  { field: 'exclusive', optional: true, validate: (value) => typeof value === 'boolean', problem: 'must be a boolean when present' },
  { field: 'name', optional: true, validate: isNonEmptyString, problem: 'must be a non-empty string when present' },
  {
    field: 'variables',
    resolve: (spec, { label }) => {
      if (spec.variables !== undefined && (spec.variables === null || typeof spec.variables !== 'object' || Array.isArray(spec.variables))) {
        throw new TypeError(`${name}: ${label}.variables must be an object when present`)
      }
      return spec.variables
    },
  },
  {
    field: 'texts',
    resolve: (spec, { label }) => {
      if (spec.texts !== undefined && (!Array.isArray(spec.texts) || spec.texts.some((item) => typeof item !== 'string'))) {
        throw new TypeError(`${name}: ${label}.texts must be an array of strings when present`)
      }
      return spec.texts
    },
  },
  { field: 'mergeMode', known: KNOWN_MERGE_MODES, default: 'separate' },
]

/**
 * 「本模块停用了模板变量」的引擎内部标记：`rule-spec.mjs#compileRules` 在配置**通过校验之后**打上它，
 * 执行期据此跳过会话变量合并（见 `executor.mjs#runPromptConfigBatch`）。它**不在**
 * {@link INJECT_CONFIG_FIELDS} 里——作者写同名键会按未知键 fail loud，键名只在这里定义一次。
 */
export const SESSION_VARIABLES_DISABLED = 'variablesDisabled'

/**
 * `inject-text.config` 的允许键：{@link CONFIG_FIELDS} 的声明键 + {@link createPromptConfigs}
 * 直读键。规则动作的配置是同一份提示词配置，因此白名单只能从这里派生——另写一份会漂移。
 * `enabled` 不在表里（`group`/`exclusive` 由 CONFIG_FIELDS 带进来）：这三个键在
 * `rule-spec.mjs#normalizeActionGates` 一律点名拒绝，它们属于规则层，运行期
 * `rule-runtime.mjs` 会覆盖它们。
 */
export const INJECT_CONFIG_FIELDS = new Set([
  ...CONFIG_FIELDS.map((rule) => rule.field),
  'id', 'layer', 'strategy', 'configKind', 'text', 'templateFile', 'fill',
  'sourceKind', 'form', 'summary', 'params',
])

/** 按 {@link CONFIG_FIELDS} 遍历一次，产出全部标量字段的归一值（或按表顺序 fail loud）。 */
function resolveConfigFields(spec, label, layer) {
  const resolved = {}
  for (const rule of CONFIG_FIELDS) {
    if (typeof rule.resolve === 'function') {
      resolved[rule.field] = rule.resolve(spec, { label, layer })
      continue
    }
    const raw = spec[rule.field]
    if (raw === undefined && (rule.optional === true || rule.keepMissing === true)) {
      if (rule.keepMissing === true) resolved[rule.field] = undefined
      continue
    }
    if (raw === null && rule.keepNull === true) {
      resolved[rule.field] = null
      continue
    }
    if (raw == null && rule.default !== undefined) {
      resolved[rule.field] = rule.default
      continue
    }
    if (rule.known !== undefined && !rule.known.has(raw)) {
      throw new TypeError(`${name}: ${label} unknown ${rule.field} ${JSON.stringify(raw)}`)
    }
    if (rule.validate !== undefined && rule.validate(raw) !== true) {
      throw new TypeError(`${name}: ${label}.${rule.field} ${rule.problem}`)
    }
    resolved[rule.field] = raw
  }
  return resolved
}

const ACTIVATION_FIELDS = new Set(['scan', 'scanDepth', 'scanVariables', 'selective', 'probability', 'useProbability', 'selectionGroup', 'groupOverride', 'groupWeight', 'useGroupScoring', 'sticky', 'cooldown', 'delay', 'excludeRecursion', 'preventRecursion', 'delayUntilRecursion'])
const ACTIVATION_LOGIC = new Set(['AND_ANY', 'NOT_ALL', 'NOT_ANY', 'AND_ALL'])
function validateActivation(params, strategy, label) {
  for (const key of ['stWorldBook', 'stMacros', 'stSource', 'stWords']) {
    if (Object.hasOwn(params, key)) throw new TypeError(`${label}.params.${key} is retired; reimport or explicitly convert to native context/template fields`)
  }
  if (params.templateEvaluation !== undefined && typeof params.templateEvaluation !== 'boolean') throw new TypeError(`${label}.params.templateEvaluation must be boolean`)
  if (strategy !== CONTEXT_ACTIVATION_STRATEGY) {
    if (params.activation !== undefined) throw new TypeError(`${label}.params.activation requires strategy ${CONTEXT_ACTIVATION_STRATEGY}`)
    return
  }
  const activation = params.activation
  if (activation === null || typeof activation !== 'object' || Array.isArray(activation)) throw new TypeError(`${label}.params.activation must be an object`)
  const invalid = Object.keys(activation).filter(key => !ACTIVATION_FIELDS.has(key))
  if (invalid.length) throw new TypeError(`${label}.params.activation unknown fields: ${invalid.join(', ')}`)
  if (!['batch', 'history'].includes(activation.scan)) throw new TypeError(`${label}.params.activation.scan must be batch or history`)
  for (const key of ['scanDepth', 'sticky', 'cooldown', 'delay']) {
    if (activation[key] !== undefined && (!Number.isSafeInteger(activation[key]) || activation[key] < 0)) throw new TypeError(`${label}.params.activation.${key} must be a non-negative integer`)
  }
  if (activation.delayUntilRecursion !== undefined && typeof activation.delayUntilRecursion !== 'boolean'
    && (!Number.isSafeInteger(activation.delayUntilRecursion) || activation.delayUntilRecursion < 0)) throw new TypeError(`${label}.params.activation.delayUntilRecursion must be boolean or a non-negative integer`)
  for (const key of ['selective', 'useProbability', 'groupOverride', 'useGroupScoring', 'excludeRecursion', 'preventRecursion']) {
    if (activation[key] !== undefined && typeof activation[key] !== 'boolean') throw new TypeError(`${label}.params.activation.${key} must be boolean`)
  }
  for (const key of ['probability', 'groupWeight']) {
    if (activation[key] !== undefined && (!Number.isFinite(activation[key]) || activation[key] < 0 || (key === 'probability' && activation[key] > 100))) throw new TypeError(`${label}.params.activation.${key} is out of range`)
  }
  if (activation.selectionGroup !== undefined && typeof activation.selectionGroup !== 'string') throw new TypeError(`${label}.params.activation.selectionGroup must be string`)
  if (activation.scanVariables !== undefined && (!Array.isArray(activation.scanVariables) || activation.scanVariables.some(key => typeof key !== 'string' || key.length === 0))) throw new TypeError(`${label}.params.activation.scanVariables must contain variable names`)
  for (const key of ['keys', 'secondaryKeys']) {
    if (params[key] !== undefined && (!Array.isArray(params[key]) || params[key].some(value => typeof value !== 'string'))) throw new TypeError(`${label}.params.${key} must contain strings`)
  }
  for (const key of ['constant', 'caseSensitive', 'wholeWords', 'useRegex']) {
    if (params[key] !== undefined && typeof params[key] !== 'boolean') throw new TypeError(`${label}.params.${key} must be boolean`)
  }
  if (params.selectiveLogic !== undefined && !ACTIVATION_LOGIC.has(params.selectiveLogic)) throw new TypeError(`${label}.params.selectiveLogic must use a named logic`)
  if (params.wordBoundary !== undefined && !['ascii-token', 'unicode'].includes(params.wordBoundary)) throw new TypeError(`${label}.params.wordBoundary must be ascii-token or unicode`)
}

/** 从 YAML 提示词配置描述构造运行时提示词配置。配置错误必须在挂载时暴露(fail loud)。 */
export function createPromptConfigs(specs, options = {}) {
  if (options.templateModuleRoot !== undefined && options.templatePresetRoot !== undefined
    && String(options.templateModuleRoot) !== String(options.templatePresetRoot)) throw new TypeError('templateModuleRoot and templatePresetRoot conflict')
  const templateModuleRoot = options.templateModuleRoot ?? options.templatePresetRoot
  if (specs === undefined) return []
  if (!Array.isArray(specs)) throw new TypeError(`${name}: config.configs must be an array`)
  // 重复 ID 拒绝：后者覆盖前者会静默丢卡，挂载前 fail loud。
  const seenIds = new Set()
  for (const spec of specs) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue
    const id = spec.id
    if (typeof id === 'string' && id.length > 0 && seenIds.has(id)) {
      throw new TypeError(`${name}: duplicate prompt config id ${JSON.stringify(id)}`)
    }
    if (typeof id === 'string' && id.length > 0) seenIds.add(id)
  }
  const configs = specs.map((spec, index) => {
    const label = `configs[${index}]`
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new TypeError(`${name}: ${label} must be an object`)
    }
    if (typeof spec.id !== 'string' || spec.id.length === 0) {
      throw new TypeError(`${name}: ${label}.id must be a non-empty string`)
    }
    const rawStrategy = spec.strategy ?? 'static'
    const strategy = rawStrategy
    if (strategy === 'world-book') throw new TypeError(`${name}: world-book is retired; reimport or explicitly convert to context-activation`)
    if (['custom-fallback', 'first-turn-anchor', 'anchor-notice', 'guide-auto'].includes(strategy)) throw new TypeError(`${name}: retired strategy ${strategy}; use rule conditions and static content`)
    if (!KNOWN_STRATEGIES.has(strategy)) {
      // 模板专属策略:声明了 strategyDir 时由 strategies.bindResolver 懒加载,
      // 否则视为未知策略 fail loud。
      if (typeof options.strategyDir !== 'string' || options.strategyDir.length === 0) {
        throw new TypeError(`${name}: ${label} unknown strategy ${JSON.stringify(strategy)}`)
      }
    }
    const configKind = spec.configKind ?? 'ordered'
    if (!KNOWN_SLOT_KINDS.has(configKind)) {
      throw new TypeError(`${name}: ${label} unknown configKind ${JSON.stringify(configKind)}`)
    }
    const layer = spec.layer ?? 'pre-step'
    if (layer === 'agent-request' || layer === 'llm-stream') throw new TypeError(`${name}: layer ${layer} is not an inject-text channel; use ${layer === 'agent-request' ? 'request-params' : 'stream-output'} action`)
    if (!KNOWN_LAYERS.has(layer)) {
      throw new TypeError(`${name}: ${label} unknown layer ${JSON.stringify(layer)} — known layers: ${[...KNOWN_LAYERS].sort().join(', ')}`)
    }
    // 策略只在消费它的层生效：不支持的组合必须报错，不能静默变成"配了没效果"。
    const strategyLayers = KNOWN_STRATEGIES.has(strategy) ? STRATEGY_LAYER_SUPPORT[strategy] : TEMPLATE_STRATEGY_LAYERS
    if (strategyLayers !== null && !strategyLayers.includes(layer)) {
      throw new TypeError(`${name}: ${label} strategy ${JSON.stringify(strategy)} only takes effect on layer(s) ${strategyLayers.join(', ')} — got layer ${JSON.stringify(layer)}`)
    }
    // 层能力矩阵同时是引擎校验源：矩阵标记 false 的字段在对应层不生效，
    // 显式提供时 fail loud（UI 表单已按矩阵隐藏，此处兜底手写配置）。
    const restricted = ['position', 'dedupe', 'promotion', 'audience', 'modelScope', 'merge', 'role']
      .filter((field) => LAYER_FIELD_POLICIES[layer][field] === false && spec[field === 'merge' ? 'mergeMode' : field] != null)
    if (restricted.length > 0) {
      throw new TypeError(`${name}: ${label} layer ${JSON.stringify(layer)} does not support field(s): ${restricted.join(', ')}`)
    }
    // 标量字段统一校验与归一（B5 T2：原 15 段同型校验收敛为一次遍历，表顺序即报错顺序）。
    // 传**裸 label**：前缀 `${name}: ` 由 resolveConfigFields 与各 resolve 自行补齐。
    const fields = resolveConfigFields(spec, label, layer)
    // placeholder 的层限制由上面的 STRATEGY_LAYER_SUPPORT 统一校验（此处不再重复）。
    let fill
    if (strategy === 'placeholder') {
      fill = typeof spec.fill === 'string' && spec.fill.length > 0 ? spec.fill : undefined
      if (fill === undefined || !KNOWN_FILLS.has(fill)) {
        throw new TypeError(`${name}: ${label} strategy=placeholder requires fill in [${[...KNOWN_FILLS].sort().join(', ')}]`)
      }
    }
    // 安装预检可把文件读取定向到尚未提交的候选目录，默认运行期仍走原解析器。
    const template = (options.loadTemplate ?? loadTemplate)(spec.templateFile, options.templateBaseUrl, templateModuleRoot)
    const templatePatch = template !== null && typeof template === 'object'
      ? { id: template.id, role: template.role, content: template.content, source: template.source }
      : undefined
    // 内容和层参数保留各自验证，条件只由规则树负责。
    const params = normalizeLayerParams(spec.params, layer, `${name}: ${label}`)
    validateActivation(params, strategy, `${name}: ${label}`)
    const config = {
      id: spec.id,
      name: fields.name ?? spec.id,
      enabled: spec.enabled !== false,
      strategy,
      configKind,
      layer,
      group: fields.group,
      exclusive: fields.exclusive === true,
      order: fields.order,
      role: fields.role,
      fill,
      position: fields.position,
      dedupe: fields.dedupe,
      promotion: fields.promotion,
      audience: fields.audience,
      modelScope: fields.modelScope,
      // sourceKind 进的是消息 source.kind，必须是 **v4 的生产者身份**（`plugin:<owner>`）：
      // 裸规则 id 会被 `userMessagesText` 的注入过滤漏掉（它只认 `source.plugin` 与
      // `plugin:` 前缀），于是本引擎注入过的规则正文会回来参与下一轮 when 判定——实测
      // 后果是只读档正文里的「只读」二字让写档的 notAny 在第二轮翻转，同一子代理两档并注。
      sourceKind: (() => {
        const declared = typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 ? spec.sourceKind : spec.id
        return pluginOwner(declared) !== undefined ? declared : pluginKind(declared)
      })(),
      form: typeof spec.form === 'string' ? spec.form : 'notice',
      summary: typeof spec.summary === 'string' ? spec.summary : '',
      identity: fields.identity,
      // text/texts 统一：text 为单块便捷写法，运行时与渲染只消费 texts。
      texts: (() => {
        const specText = typeof spec.text === 'string' && spec.text.length > 0 ? spec.text : undefined
        const specTexts = Array.isArray(spec.texts) ? spec.texts.filter((item) => typeof item === 'string' && item.length > 0) : []
        const templateText = typeof template?.text === 'string' ? template.text : ''
        return specText !== undefined || specTexts.length > 0
          ? [...(specText !== undefined ? [specText] : []), ...specTexts]
          : (templateText.length > 0 ? [templateText] : [])
      })(),
      mergeMode: fields.mergeMode,
      variables: fields.variables ?? {},
      templatePatch,
      params,
    }
    const sequence = (Object.hasOwn(options.configOrder ?? {}, spec.id) ? options.configOrder[spec.id] : undefined)
      ?? (typeof options.sourceModuleId === 'string' ? index * 10 : undefined)
    if (sequence !== undefined) config.sequence = sequence
    if (typeof options.sourceModuleId === 'string') config.sourceModuleId = options.sourceModuleId
    config.resolve = bindResolver(config, options.strategyDir)
    return config
  })
  // 模块/物化来源按持久序号；没有文件来源的独立数组继续采用 anchor + order 契约。
  return configs
    .map((config, fileOrder) => ({ config, fileOrder }))
    .sort((a, b) => {
      if (a.config.sequence !== undefined || b.config.sequence !== undefined) {
        return compareConfigSequence(a.config, b.config) || a.fileOrder - b.fileOrder
      }
      const aAnchor = a.config.configKind === 'anchor' ? 0 : 1
      const bAnchor = b.config.configKind === 'anchor' ? 0 : 1
      if (aAnchor !== bAnchor) return aAnchor - bAnchor
      if (aAnchor === 1 && a.config.order !== b.config.order) return a.config.order - b.config.order
      return a.fileOrder - b.fileOrder
    })
    .map(({ config }) => config)
}
