/**
 * 官方装配档位名的**区段分组**（只存名字，**不存数值**）。
 *
 * ## 来源与同源纪律
 *
 * 抄录自已安装的 `@deepseek-ai/dsh-system-prompt@0.2.1-alpha.3`：
 * 官方源码 `packages/core/system-prompt/src/index.ts` 的 `SECTION_ORDERS`（32 项）与
 * `CONTEXT_ORDERS`（7 项），与安装包 `lib/index.js` 的两张表逐项核对。
 *
 * 官方**新增、改名或删除**档位时必须同步本文件——本文件与官方包同源，不构成第二权威。
 * 数值一律**不抄**：运行时用官方 `getSectionOrder(name)` / `getContextOrder(name)` 求值，
 * 官方调整档位数值时 UI 自动跟随（手抄数值正是版本漂移的来源）。纪律对齐
 * `src/shared/engine-capabilities.ts` 的既有先例。
 *
 * ## 分组口径（2026-09-22 用户拍板：区段归纳）
 *
 * section 侧 6 组、context 侧 1 组，共 7 个区段。每组只给**有序档位名**，
 * 组的 `from` / `to` 由组内**取得到值的**档位在运行期决定（min/max），因此本节没有任何魔数。
 */

/** 官方 section 档位名（联合类型由本文件维护，与官方同名常量表逐项对应）。 */
export type OfficialSectionOrderName =
  | 'HARNESS_IDENTITY'
  | 'DEPLOYMENT_PERSONA_PREFIX'
  | 'PLAN_POLICY'
  | 'TEAM_POLICY'
  | 'PTC_ONLY'
  | 'FILE_REFERENCE'
  | 'TOOL_BASH'
  | 'TOOL_PWSH'
  | 'TOOL_READ'
  | 'TOOL_WRITE'
  | 'TOOL_EDIT'
  | 'TOOL_GLOB'
  | 'TOOL_GREP'
  | 'TOOL_JOBS'
  | 'TOOL_PTY'
  | 'TOOL_WEB_SEARCH'
  | 'TOOL_WEB_FETCH'
  | 'TOOL_LSP'
  | 'TOOL_SESSION_QUERY'
  | 'TOOL_GOAL'
  | 'TOOL_WORKFLOW'
  | 'TOOL_RALPH'
  | 'TOOL_SUBAGENT'
  | 'TOOL_REPORT'
  | 'TOOL_COMPUTER_USE'
  | 'MCP_SERVERS'
  | 'TOOLS_SDK'
  | 'DELIVERABLE_FILE_REFERENCES'
  | 'STRUCTURED_OUTPUT'
  | 'HARNESS_SOURCE'
  | 'WEB_SURFACE'
  | 'DEPLOYMENT_PERSONA_SUFFIX'

/** 官方 runtime-context 档位名（7 项，与官方 `CONTEXT_ORDERS` 的键集逐项对应）。 */
export type OfficialContextOrderName =
  | 'WORKING_DIRECTORY'
  | 'SANDBOX_POLICY'
  | 'APPROVAL_POLICY'
  | 'SUBAGENT_DELEGATION'
  | 'TEAM_IDENTITY'
  | 'HARNESS_SOURCE'
  | 'WEB_SURFACE'

/** 一个区段：稳定 id（显示名走客户端字典）+ 组内**有序**档位名。 */
export interface OfficialOrderGroup<Name extends string> {
  readonly id: string
  readonly names: readonly Name[]
}

/** section 侧 6 组，覆盖官方 32 个档位名（顺序即官方数值升序）。 */
export const OFFICIAL_SECTION_ORDER_GROUPS: readonly OfficialOrderGroup<OfficialSectionOrderName>[] = [
  { id: 'identity', names: ['HARNESS_IDENTITY', 'DEPLOYMENT_PERSONA_PREFIX'] },
  { id: 'policy', names: ['PLAN_POLICY', 'TEAM_POLICY', 'PTC_ONLY', 'FILE_REFERENCE'] },
  {
    id: 'tools',
    names: [
      'TOOL_BASH', 'TOOL_PWSH', 'TOOL_READ', 'TOOL_WRITE', 'TOOL_EDIT', 'TOOL_GLOB', 'TOOL_GREP',
      'TOOL_JOBS', 'TOOL_PTY', 'TOOL_WEB_SEARCH', 'TOOL_WEB_FETCH', 'TOOL_LSP', 'TOOL_SESSION_QUERY',
      'TOOL_GOAL', 'TOOL_WORKFLOW', 'TOOL_RALPH', 'TOOL_SUBAGENT', 'TOOL_REPORT',
      'TOOL_COMPUTER_USE', 'MCP_SERVERS',
    ],
  },
  { id: 'sdk', names: ['TOOLS_SDK'] },
  { id: 'deliverable', names: ['DELIVERABLE_FILE_REFERENCES', 'STRUCTURED_OUTPUT'] },
  { id: 'closing', names: ['HARNESS_SOURCE', 'WEB_SURFACE', 'DEPLOYMENT_PERSONA_SUFFIX'] },
]

/** context 侧 1 组，覆盖官方 7 个档位名（顺序即官方数值升序）。 */
export const OFFICIAL_CONTEXT_ORDER_GROUPS: readonly OfficialOrderGroup<OfficialContextOrderName>[] = [
  {
    id: 'runtime-policy',
    names: [
      'WORKING_DIRECTORY', 'SANDBOX_POLICY', 'APPROVAL_POLICY', 'SUBAGENT_DELEGATION',
      'TEAM_IDENTITY', 'HARNESS_SOURCE', 'WEB_SURFACE',
    ],
  },
]

/** 一个已求值的区段：`from` / `to` 是该组**取得到值的**档位在运行期的 min/max（官方数值）。 */
export interface OfficialOrderSegment {
  readonly id: string
  readonly from: number
  readonly to: number
}

/** 下发形状：两层各自一组区段。 */
export interface OfficialOrdersView {
  readonly sections: readonly OfficialOrderSegment[]
  readonly contexts: readonly OfficialOrderSegment[]
}

/** 取值方所需的最小服务面：官方 `SystemPrompt` 的档位查询方法。 */
export interface OfficialOrderLookup {
  getSectionOrder?: (name: OfficialSectionOrderName) => number
  getContextOrder?: (name: OfficialContextOrderName) => number
}

/**
 * 把一组档位名求值成一个区段：取得到**有限数**的档位参与求界，取不到的跳过；
 * 一个都取不到（服务缺失、降级或档位名全不匹配）才返回 undefined。
 *
 * 为什么不做「缺一即整组缺席」（2026-10-16 用户拍板）：本表声明的是**最新官方键集**，
 * 而宿主版本可能更旧——官方 `CONTEXT_ORDERS` 在 `0.2.1-alpha.2` 是 4 项、`alpha.3`／
 * `alpha.4` 是 7 项。旧宿主上整组缺席会让 UI 刻度**整体消失**（比窄区间更糟）；容错口径下
 * 刻度只声称覆盖该宿主**实际存在**的档位区间（alpha.2 得 100–120、alpha.3+ 得 100–210）。
 *
 * 代价：官方**改名**（而非新增）时那个名字会被静默跳过、区间变窄，不再整表缺席。
 */
function segmentOf<Name extends string>(
  group: OfficialOrderGroup<Name>,
  lookup: (name: Name) => number | undefined,
): OfficialOrderSegment | undefined {
  const values: number[] = []
  for (const name of group.names) {
    const value = lookup(name)
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value)
  }
  if (values.length === 0) return undefined
  return { id: group.id, from: Math.min(...values), to: Math.max(...values) }
}

/**
 * 求全部 7 个区段；**任一组一个档位都取不到即整体返回 undefined**（调用方据此不下发该字段）。
 * 这里按 min/max 求边界而不是取首末元素，官方若调整组内相对顺序也不会给出反向区间。
 */
export function readOfficialOrderSegments(lookup: OfficialOrderLookup): OfficialOrdersView | undefined {
  const sections: OfficialOrderSegment[] = []
  for (const group of OFFICIAL_SECTION_ORDER_GROUPS) {
    const segment = segmentOf(group, (name) => lookup.getSectionOrder?.(name))
    if (segment === undefined) return undefined
    sections.push(segment)
  }
  const contexts: OfficialOrderSegment[] = []
  for (const group of OFFICIAL_CONTEXT_ORDER_GROUPS) {
    const segment = segmentOf(group, (name) => lookup.getContextOrder?.(name))
    if (segment === undefined) return undefined
    contexts.push(segment)
  }
  return { sections, contexts }
}
