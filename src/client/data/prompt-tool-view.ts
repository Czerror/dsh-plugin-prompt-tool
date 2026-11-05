/** settings/bootstrap 载荷到客户端 Fields 的纯映射。 */
import { EMPTY_FIELDS, type Fields } from './prompt-tool-fields.ts'
import { PROMPT_TOOL_NS } from '../../shared/namespace.ts'
import type { BridgeResponse } from '../../shared/bridge-contract.ts'

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

const readBoolean = (source: Record<string, unknown>, key: string, fallback: boolean): boolean => {
  const value = source[key]
  return typeof value === 'boolean' ? value : fallback
}

export function fieldsFromView(res: BridgeResponse<'bootstrap'>): Fields {
  const ns = res.ok ? res.value : undefined
  const value = asRecord(ns?.value)
  const base = asRecord(ns?.base)
  const next: Fields = {
    ...EMPTY_FIELDS,
    promptText: readString(value, 'promptText') ?? readString(base, 'promptText') ?? '',
    promptPath: readString(value, 'promptPath') ?? readString(base, 'promptPath') ?? '',
    agentsText: readString(value, 'agentsText') ?? readString(base, 'agentsText') ?? '',
    agentsPath: readString(value, 'agentsPath') ?? readString(base, 'agentsPath') ?? '',
    modulesEnabled: readBoolean(value, 'modulesEnabled', readBoolean(base, 'modulesEnabled', true)),
  }
  return next
}
/** /bootstrap 已携带 descriptor；归一成 fieldsFromView 使用的结果形状。 */
export function bridgeViewFromBoot(boot: BridgeResponse<'bootstrap'>): BridgeResponse<'bootstrap'> {
  if (!boot.ok) return boot
  // 只归一化 `value`（补 ns、透传 base/revision）；**extras 原样传递**——它们本来就属于这次响应，
  // 逐个搬运等于在这里维护第二份清单（旧实现正因如此漏掉了 meta／promptConfigs 等会话段）。
  return {
    ...boot,
    value: {
      // 客户端没有 Loader 入口，settings ns 只能是编译期常量；换行 id 装配需同步（宿主侧已动态解析）。
      ns: PROMPT_TOOL_NS,
      value: boot.value.value,
      base: boot.value.base,
      revision: boot.value.revision,
    },
  }
}
