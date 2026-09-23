/**
 * schema — prompt-config-engine 的提示词配置加载、归一化与权威校验。
 * 只负责"配置长什么样";执行语义见 executor.mjs,内容策略见 strategies.mjs。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sep } from 'node:path'
import { parse as parseYaml } from './vendor/yaml/index.js'
import { bindResolver } from './strategies.mjs'
import { attachStRenderers } from './st-render.mjs'
import { MATCH_LOGIC, createAnchorMatcher } from './anchor-match.mjs'

const name = 'prompt-config-engine'

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

/**
 * 完整 YAML 解析(vendored yaml 包):提示词配置文件直接使用标准 YAML。
 * 支持缩进 map、列表、block scalar、行尾注释、引号转义等全部语法。
 */
export function parsePromptConfigYaml(raw) {
  const parsed = parseYaml(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${name}: prompt config yaml must contain a single object`)
  }
  return parsed
}

/**
 * 枚举提示词配置候选文件：**两条加载路径共用同一份枚举规则**。
 *
 * 扩展名、排序与跳过名单必须两侧一致——否则 host（编辑/列举）与引擎（注入）会看到不同的
 * 文件集：host 让人编辑 A 文件、引擎却加载 B 文件。`variables.yml` 是模板变量源而非配置，
 * 两侧都跳过（引擎另行读取它做合并，见 `loadPromptConfigFiles`）。
 *
 * 只共享**枚举**这一层：解析、结构校验、错误类型与包装都留在各自边界——两边的入参类型
 * （URL vs 字符串路径）、空路径短路与异常消息本来就不同，强行合并会改变其中一侧的行为。
 *
 * @param entries `readdirSync(dir, { withFileTypes: true })` 的结果
 * @returns 按名排序的文件名（含扩展名），已剔除 `variables.yml`
 */
export function promptConfigFileNames(entries) {
  return entries
    .filter((entry) => entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => entry.name)
    .filter((fileName) => fileName !== 'variables.yml')
}

/**
 * 从提示词配置模块目录加载全部提示词配置描述:按文件名排序扫描 *.yml / *.yaml / *.json。
 * 文件名用数字前缀表达引擎执行顺序(00-…、10-…)。
 */
export function loadPromptConfigFiles(dirUrl) {
  let entries
  try {
    entries = readdirSync(dirUrl, { withFileTypes: true })
  } catch (error) {
    throw new TypeError(`${name}: configsDir ${String(dirUrl)} is not readable: ${String(error?.message ?? error)}`)
  }
  // 预设级模板变量（writePreset 生成 variables.yml）：读入后合并进每条配置
  // variables（配置自身优先）；variables.yml 本身不当作配置解析。缺失或损坏
  // 时为空变量源，不阻断加载。
  let presetVariables = {}
  try {
    const parsed = parseYaml(readFileSync(new URL('variables.yml', dirUrl), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) presetVariables = parsed
  } catch {
    // 无 variables.yml（旧产物/手写目录）或解析失败：保持空变量源。
  }
  const specs = []
  for (const fileName of promptConfigFileNames(entries)) {
    const raw = readFileSync(new URL(fileName, dirUrl), 'utf8')
    if (/\.json$/i.test(fileName)) {
      specs.push(JSON.parse(raw))
    } else {
      specs.push(parsePromptConfigYaml(raw))
    }
  }
  for (const spec of specs) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue
    const own = spec.variables !== null && typeof spec.variables === 'object' && !Array.isArray(spec.variables)
      ? spec.variables
      : {}
    spec.variables = { ...presetVariables, ...own }
  }
  return specs
}

export const KNOWN_STRATEGIES = new Set(['static', 'placeholder', 'first-turn-anchor', 'guide-auto', 'custom-fallback', 'world-book'])
/**
 * 策略 × 层支持矩阵：`config.resolve` 只在 pre-step（executor）与 runtime-context 的
 * placeholder（layers）被消费，其他层声明非 static 策略会绑定 resolver 却无人调用，
 * 表现为「配了没效果、也不报错」。这里把该事实写成校验：不支持的组合挂载期 fail loud。
 * `static: null` 表示全层可用；模板专属策略（strategyDir 懒加载）与内置策略同样受限。
 */
export const STRATEGY_LAYER_SUPPORT = {
  static: null,
  placeholder: ['pre-step', 'runtime-context'],
  'first-turn-anchor': ['pre-step'],
  'guide-auto': ['pre-step'],
  'custom-fallback': ['pre-step'],
  'world-book': ['pre-step'],
}
/** 模板专属策略允许的层：resolver 同样只在 pre-step / runtime-context 被调用。 */
const TEMPLATE_STRATEGY_LAYERS = ['pre-step', 'runtime-context']
export const KNOWN_SLOT_KINDS = new Set(['ordered', 'anchor'])
/**
 * 九个官方注入层的**唯一权威定义**（B5 T1：原 `LAYER_ORDER` / `LAYER_FIELD_POLICIES` /
 * `LAYER_EDITING` / `LAYER_LABELS` / `LAYER_DEFAULT_SUBJECT` 五处事实合一）。
 *
 * 新增或改一层只动这里一处：
 *   - 数组顺序即 `layerOrder`（**产品定义**，改顺序等于改 UI 组织，不要只为排序调整）；
 *   - `fields` 是层能力矩阵（11 项，客户端表单据此动态渲染）；
 *   - `editing` 是字段能力表（subjects / content / variables / messageMetadata / params）；
 *   - `label` 是由引擎统一下发给客户端的显示名与说明；
 *   - `defaultSubject` 是该条件层的缺省匹配对象（不声明 = 该层没有匹配对象）。
 *
 * 下面所有导出都由本表**派生**，并保持既有名字与形状，外部消费方不受影响。
 * `defaultSubject` 必须落在本层 `editing.subjects` 内——就近声明 + 加载期断言，
 * 避免「缺省值不在允许集合里」这种只能靠运行期才发现的错配。
 */
const LAYER_DEFINITIONS = [
  {
    layer: 'pre-step',
    fields: { position: true, dedupe: true, promotion: true, audience: true, modelScope: true, merge: true, order: true, role: true, placeholder: true, subject: true, match: true },
    editing: { subjects: ['userMessage'], content: 'text', variables: true, messageMetadata: true, params: {} },
    label: { title: '消息批层', detail: '官方默认层：agent/pre-step 消息批。支持 position / dedupe / promotion / audience / mergeMode 与文本插值。' },
    defaultSubject: 'userMessage',
  },
  {
    layer: 'system-section',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: false, merge: true, order: true, role: false, placeholder: false, subject: false, match: false },
    editing: { subjects: [], content: 'text', variables: true, messageMetadata: false,
      params: { sectionName: { type: 'string' }, complete: { type: 'boolean' }, suppressRuntimeContext: { type: 'boolean' } } },
    label: { title: '系统段层', detail: 'system-section 静态层：注册即全局，由 order 与 params.complete / sectionName 控制。' },
  },
  {
    layer: 'runtime-context',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: false, merge: true, order: true, role: false, placeholder: true, subject: false, match: false },
    editing: { subjects: [], content: 'text', variables: true, messageMetadata: false, params: { contextName: { type: 'string' } } },
    label: { title: '运行上下文', detail: 'runtime-context 层：static 按 order 注册，placeholder 单条生效，由 params.contextName 控制。' },
  },
  {
    layer: 'agent-request',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: false, match: false },
    editing: { subjects: [], content: 'request', variables: false, messageMetadata: false,
      params: { patch: { type: 'object' }, replace: { type: 'boolean' } } },
    label: { title: '调用配置层', detail: 'agent-request 层：按 order 注册，params.patch 改写请求配置。' },
  },
  {
    layer: 'llm-stream',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: false, match: false },
    editing: { subjects: [], content: 'stream', variables: false, messageMetadata: false,
      params: { mode: { type: 'enum', values: ['pass', 'replace'] } } },
    label: { title: '模型流层', detail: 'llm/stream 层：按 order 注册，params.mode = pass | replace。' },
  },
  {
    layer: 'tool-pipeline',
    fields: { position: false, dedupe: false, promotion: false, audience: true, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: true, match: true },
    editing: { subjects: ['toolArgs', 'toolResult'], content: 'tool-result', variables: false, messageMetadata: false,
      params: { toolNames: { type: 'string' }, preDecision: { type: 'enum', values: ['allow', 'deny', 'ask'] },
        denyReason: { type: 'string' }, postAction: { type: 'enum', values: ['accept', 'replace', 'block'] } } },
    label: { title: '工具管线层', detail: 'tools/* 层：按 order 注册，params.toolNames 与 preDecision / postAction 控制；subject / match 可选，命中才裁决。' },
    defaultSubject: 'toolArgs',
  },
  {
    layer: 'turn-stop',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: true, match: true },
    editing: { subjects: ['assistantText'], content: 'text', variables: true, messageMetadata: false, params: {} },
    label: { title: '轮次停止层', detail: 'agent/turn-stopping 层：命中条件时强制续跑一步；引擎内置续跑上限，不可用配置关闭。' },
    defaultSubject: 'assistantText',
  },
  {
    layer: 'subagent-start',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: true, match: true },
    editing: { subjects: ['subagentInfo'], content: 'text', variables: true, messageMetadata: false, params: {} },
    label: { title: '子代理启动层', detail: 'subagent/start 层：命中条件时向该子代理注入上下文。' },
    defaultSubject: 'subagentInfo',
  },
  {
    layer: 'subagent-end',
    fields: { position: false, dedupe: false, promotion: false, audience: false, modelScope: true, merge: false, order: true, role: false, placeholder: false, subject: true, match: true },
    editing: { subjects: ['subagentInfo'], content: 'subagent-result', variables: true, messageMetadata: false,
      params: { action: { type: 'enum', values: ['observe', 'inject-main'] } } },
    label: { title: '子代理结束层', detail: 'subagent/end 层：默认记录；action=inject-main 时向所属主会话注入配置文本，不改写子代理返回结果。' },
    defaultSubject: 'subagentInfo',
  },
]

/** 就近断言：缺省匹配对象必须在本层允许的 subjects 内（新增层时最先撞到这里）。 */
for (const definition of LAYER_DEFINITIONS) {
  if (definition.defaultSubject === undefined) continue
  if (!definition.editing.subjects.includes(definition.defaultSubject)) {
    throw new TypeError(
      `schema: layer ${definition.layer} defaultSubject ${definition.defaultSubject} must be one of its subjects`,
    )
  }
}

/** 九个官方注入层的固定顺序：/meta 的 layerOrder、UI 层序与模板菜单共用这一份。 */
export const LAYER_ORDER = LAYER_DEFINITIONS.map((definition) => definition.layer)
export const KNOWN_LAYERS = new Set(LAYER_ORDER)
/**
 * 条件判定的匹配对象：决定把哪段文本交给 anchor-match 匹配器。
 * 取值与 DSH 扩展点一一对应，各层缺省值见 LAYER_DEFAULT_SUBJECT。
 */
export const KNOWN_SUBJECTS = new Set(['toolArgs', 'toolResult', 'userMessage', 'assistantText', 'subagentInfo'])
/** 各条件层的缺省匹配对象；不在此表的层没有匹配对象。 */
export const LAYER_DEFAULT_SUBJECT = Object.fromEntries(
  LAYER_DEFINITIONS
    .filter((definition) => definition.defaultSubject !== undefined)
    .map((definition) => [definition.layer, definition.defaultSubject]),
)
/** 支持 subject / match 的层；其余层声明这两个字段即 fail loud（避免误以为是门）。 */
export const CONDITIONAL_LAYERS = new Set(Object.keys(LAYER_DEFAULT_SUBJECT))
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
export const KNOWN_FILLS = new Set(['instruction-hint', 'env-facts', 'skill-catalog'])

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
    // layerOrder = 固定九层顺序（UI 组织用）；layers = 合法层集合（校验与旧消费方用）。
    layerOrder: [...LAYER_ORDER],
    layers: [...KNOWN_LAYERS].sort(),
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
    layerDefaultSubjects: { ...LAYER_DEFAULT_SUBJECT },
    layerFieldPolicies: LAYER_FIELD_POLICIES,
    layerLabels: LAYER_LABELS,
    layerContracts: structuredClone(LAYER_CONTRACTS),
  }
}

/**
 * 归一化并预编译条件判定的 match 段：键集合直接交给 anchor-match 的匹配器，
 * 非法 logic、非法正则与空键集合都在挂载期 fail loud——运行时静默不命中会让
 * "配了门却没拦住"变成不可见的失效。
 * @returns 归一化后的匹配参数；未声明 match 时返回 undefined（= 无条件）。
 */
function normalizeMatch(raw, label) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${label}.match must be an object when present`)
  }
  const stringList = (value, field) => {
    if (value === undefined || value === null) return []
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError(`${label}.match.${field} must be an array of strings when present`)
    }
    return value.map((item) => item.trim()).filter((item) => item.length > 0)
  }
  const keys = stringList(raw.keys, 'keys')
  const secondaryKeys = stringList(raw.secondaryKeys, 'secondaryKeys')
  if (keys.length === 0 && secondaryKeys.length === 0) {
    throw new TypeError(`${label}.match needs at least one non-empty key`)
  }
  const logic = raw.logic ?? MATCH_LOGIC.ANY
  if (!Object.values(MATCH_LOGIC).includes(logic)) {
    throw new TypeError(`${label}.match.logic must be one of ${Object.values(MATCH_LOGIC).join(', ')}`)
  }
  for (const field of ['caseSensitive', 'wholeWords', 'useRegex']) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      throw new TypeError(`${label}.match.${field} must be a boolean when present`)
    }
  }
  const match = {
    keys,
    secondaryKeys,
    logic,
    caseSensitive: raw.caseSensitive === true,
    wholeWords: raw.wholeWords === true,
    useRegex: raw.useRegex,
  }
  // 预编译：useRegex、/pattern/flags 形态与整词包装里的正则错误在此暴露。
  try {
    createAnchorMatcher(match)
  } catch (error) {
    throw new TypeError(`${label}.match is not compilable: ${error instanceof Error ? error.message : String(error)}`)
  }
  return match
}

function normalizeLayerParams(raw, layer, label) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError(`${label}.params must be an object`)
  let params = raw
  if (layer === 'tool-pipeline' && Array.isArray(raw.toolNames)) {
    if (raw.toolNames.some(item => typeof item !== 'string')) throw new TypeError(`${label}.params.toolNames must contain only strings`)
    params = { ...raw, toolNames: raw.toolNames.join(',') }
  }
  for (const [key, rule] of Object.entries(LAYER_CONTRACTS[layer].params)) {
    const value = params[key]
    if (value === undefined) continue
    const valid = rule.type === 'enum' ? rule.values.includes(value)
      : rule.type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
        : typeof value === rule.type
    if (!valid) throw new TypeError(`${label}.params.${key} must be ${rule.type === 'enum' ? rule.values.join(' | ') : rule.type}`)
  }
  if (layer === 'agent-request') {
    const patch = params.patch ?? {}
    // 官方 0.1.6 LlmCallConfig；不能把消息、工具或 system 塞进请求配置。
    const keys = new Set(['provider', 'model', 'reasoningEffort', 'temperature', 'maxTokens', 'stop'])
    for (const [key, value] of Object.entries(patch)) {
      if (!keys.has(key)) throw new TypeError(`${label}.params.patch.${key} is not a LlmCallConfig field`)
      const valid = key === 'temperature' ? typeof value === 'number' && Number.isFinite(value)
        : key === 'maxTokens' ? Number.isSafeInteger(value) && value > 0
          : key === 'stop' ? Array.isArray(value) && value.every(item => typeof item === 'string')
            : typeof value === 'string' && value.trim().length > 0
      if (!valid) throw new TypeError(`${label}.params.patch.${key} has an invalid value`)
    }
    if (params.replace === true && (!patch.provider || !patch.model)) {
      throw new TypeError(`${label}.params.patch requires provider and model when replace=true`)
    }
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
 * 表里需要额外上下文的项用 `resolve`（subject 有「全局集合 + 层内允许集」两条语义与层缺省
 * 回退）。**表顺序 = 报错顺序**：与手写版逐个检查的先后完全一致，同一组非法输入必须先报同一处。
 *
 * 不在此表（各自领域的权威，留在原处）：`params`（`normalizeLayerParams`）、`match`
 * （`normalizeMatch`）、`text`/`texts`（多来源合并）、`strategy`/`configKind`/`layer`
 * （各自带额外上下文校验）。
 */
export const CONFIG_FIELDS = [
  { field: 'position', known: KNOWN_POSITIONS, default: 'after-user' },
  { field: 'dedupe', known: KNOWN_DEDUPES, default: 'none' },
  { field: 'promotion', known: KNOWN_PROMOTIONS, default: 'none' },
  { field: 'audience', known: KNOWN_AUDIENCES, keepNull: true, keepMissing: true },
  { field: 'modelScope', known: KNOWN_MODEL_SCOPES, default: 'all' },
  { field: 'role', known: KNOWN_ROLES, default: 'user' },
  {
    field: 'subject',
    resolve: (spec, { label, layer }) => {
      // 条件判定：subject 决定把哪段文本交给匹配器（缺省由层决定），match 缺省 = 无条件。
      if (spec.subject !== undefined && !KNOWN_SUBJECTS.has(spec.subject)) {
        throw new TypeError(`${name}: ${label} unknown subject ${JSON.stringify(spec.subject)} — known subjects: ${[...KNOWN_SUBJECTS].sort().join(', ')}`)
      }
      if (spec.subject !== undefined && !LAYER_CONTRACTS[layer].subjects.includes(spec.subject)) {
        throw new TypeError(`${name}: ${label}.subject ${JSON.stringify(spec.subject)} is unavailable on layer ${JSON.stringify(layer)}`)
      }
      return spec.subject ?? LAYER_DEFAULT_SUBJECT[layer]
    },
  },
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

/** 从 YAML 提示词配置描述构造运行时提示词配置。配置错误必须在挂载时暴露(fail loud)。 */
export function createPromptConfigs(specs, options = {}) {
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
    const restricted = ['position', 'dedupe', 'promotion', 'audience', 'modelScope', 'merge', 'role', 'subject', 'match']
      .filter((field) => LAYER_FIELD_POLICIES[layer][field] === false && spec[field === 'merge' ? 'mergeMode' : field] != null)
    if (restricted.length > 0) {
      throw new TypeError(`${name}: ${label} layer ${JSON.stringify(layer)} does not support field(s): ${restricted.join(', ')}`)
    }
    // 标量字段统一校验与归一（B5 T2：原 15 段同型校验收敛为一次遍历，表顺序即报错顺序）。
    // 传**裸 label**：前缀 `${name}: ` 由 resolveConfigFields 与各 resolve 自行补齐。
    const fields = resolveConfigFields(spec, label, layer)
    // subject 已由 fields 归一（含「全局集合 + 层内允许集」两条语义与层缺省回退）。
    const match = normalizeMatch(spec.match, `${name}: ${label}`)
    // placeholder 的层限制由上面的 STRATEGY_LAYER_SUPPORT 统一校验（此处不再重复）。
    let fill
    if (strategy === 'placeholder') {
      fill = typeof spec.fill === 'string' && spec.fill.length > 0 ? spec.fill : undefined
      if (fill === undefined || !KNOWN_FILLS.has(fill)) {
        throw new TypeError(`${name}: ${label} strategy=placeholder requires fill in [${[...KNOWN_FILLS].sort().join(', ')}]`)
      }
    }
    // 安装预检可把文件读取定向到尚未提交的候选目录，默认运行期仍走原解析器。
    const template = (options.loadTemplate ?? loadTemplate)(spec.templateFile, options.templateBaseUrl, options.templatePresetRoot)
    const templatePatch = template !== null && typeof template === 'object'
      ? { id: template.id, role: template.role, content: template.content, source: template.source }
      : undefined
    // tool-pipeline 的 toolNames 是逗号分隔字符串（parseToolNames 只认字符串）：
    // 数组写法会被静默解析为空 = 匹配所有工具，把一条定向门扩大成全工具门，
    // 与条件判定叠加后危害更大，这里归一化而不是留给运行时。
    const params = normalizeLayerParams(spec.params, layer, `${name}: ${label}`)
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
      subject: fields.subject,
      match,
      sourceKind: typeof spec.sourceKind === 'string' && spec.sourceKind.length > 0 ? spec.sourceKind : spec.id,
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
    // 条件判定的匹配器在挂载期编译一次，执行侧（condition.mjs）直接复用：
    // normalizeMatch 已用同一份参数试编译过，这里是同源的第二句（失败会抛出）。
    config.matchScan = match === undefined ? undefined : createAnchorMatcher(match).scan
    config.resolve = bindResolver(config, options.strategyDir)
    return config
  })
  // 排序契约:anchor 提示词配置保持模块文件相对顺序(固定锚点),ordered 提示词配置按 order
  // 稳定升序排在其后。默认 order=0 时等价于文件顺序。
  return attachStRenderers(configs
    .map((config, fileOrder) => ({ config, fileOrder }))
    .sort((a, b) => {
      const aAnchor = a.config.configKind === 'anchor' ? 0 : 1
      const bAnchor = b.config.configKind === 'anchor' ? 0 : 1
      if (aAnchor !== bAnchor) return aAnchor - bAnchor
      if (aAnchor === 1 && a.config.order !== b.config.order) return a.config.order - b.config.order
      return a.fileOrder - b.fileOrder
    })
    .map(({ config }) => config))
}
