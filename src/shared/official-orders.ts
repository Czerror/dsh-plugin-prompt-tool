/**
 * 官方装配档位名的**区段分组**（只存名字，**不存数值**）。
 *
 * ## 来源与同源纪律
 *
 * 抄录自已安装的 `@deepseek-ai/dsh-system-prompt@0.1.7-alpha.1`：
 * 官方源码 `packages/core/system-prompt/src/index.ts` 的 `SECTION_ORDERS`（32 项）与
 * `CONTEXT_ORDERS`（3 项），核对基线 `c36a83ff6b`。
 *
 * 官方**新增、改名或删除**档位时必须同步本文件——本文件与官方包同源，不构成第二权威。
 * 数值一律**不抄**：运行时用官方 `getSectionOrder(name)` / `getContextOrder(name)` 求值，
 * 官方调整档位数值时 UI 自动跟随（手抄数值正是版本漂移的来源）。纪律对齐
 * `src/shared/engine-capabilities.ts` 的既有先例。
 *
 * ## 分组口径（2026-09-22 用户拍板：区段归纳）
 *
 * section 侧 6 组、context 侧 1 组，共 7 个区段。每组只给**有序档位名**，
 * 组的 `from` / `to` 由组内**首末档位名**的运行期取值决定，因此本节没有任何魔数。
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

/** 官方 runtime-context 档位名。 */
export type OfficialContextOrderName = 'SANDBOX_POLICY' | 'APPROVAL_POLICY' | 'SUBAGENT_DELEGATION'

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

/** context 侧 1 组，覆盖官方 3 个档位名。 */
export const OFFICIAL_CONTEXT_ORDER_GROUPS: readonly OfficialOrderGroup<OfficialContextOrderName>[] = [
  { id: 'runtime-policy', names: ['SANDBOX_POLICY', 'APPROVAL_POLICY', 'SUBAGENT_DELEGATION'] },
]

/** 一个已求值的区段：`from` / `to` 是该组首末档位的**官方**数值。 */
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
 * 把一组档位名求值成一个区段；任一名字取不到**有限数**即返回 undefined。
 *
 * 不用手抄数值兜底：官方改名、方法缺失或服务降级时一律让整张表缺席，
 * 否则 UI 会展示一份看似完整、实则缺口的刻度。
 */
function segmentOf<Name extends string>(
  group: OfficialOrderGroup<Name>,
  lookup: (name: Name) => number | undefined,
): OfficialOrderSegment | undefined {
  const values: number[] = []
  for (const name of group.names) {
    const value = lookup(name)
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
    values.push(value)
  }
  return { id: group.id, from: Math.min(...values), to: Math.max(...values) }
}

/**
 * 求全部 7 个区段；**任一组失败即整体返回 undefined**（调用方据此不下发该字段）。
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
