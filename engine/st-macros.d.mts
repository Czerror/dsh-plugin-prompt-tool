/** 数字运算保留 number；JSON 数组以字符串保存，与 ST 变量存储一致。 */
export type StVariableTable = Record<string, string | number>

export interface StTextOptions {
  variables?: Readonly<Record<string, unknown>>
  local?: StVariableTable
  global?: StVariableTable
  /** 原样传给 interpolateVariables，仅供读取会话事实。 */
  session?: unknown
  sourceId?: string
  warn?: (message: string) => void
}

/** 清理注释/trim/ERA、归一宏写法、替换已知角色与默认用户；不求值变量。 */
export function prepareStText(text: string, cardName?: string): string

/**
 * 顺序求值，仅修改显式 local/global；getvar 的非空 fallback 初始化所属表。
 * 未知普通引用保留；危险键拒绝并 warn；循环、超过 32 层或 1 MiB 抛 RangeError。
 * 另设总展开工作量上限，防止零输出的重复展开耗尽资源。
 */
export function renderStText(text: string, options?: StTextOptions): string
