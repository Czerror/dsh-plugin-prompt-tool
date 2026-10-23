/**
 * `instruction-blocks.mjs` 的手写声明：只声明 `src/` 消费的导出，形状按实现写实。
 */

/** 一个官方指令标题块；`index` 是标题行首在正文中的位置。 */
export interface InstructionBlock {
  action: 'set' | 'replace' | 'remove'
  path: string
  index: number
}

/** 解析系统提醒正文里的 4 种官方指令标题。 */
export declare function instructionBlocks(text: string): InstructionBlock[]
