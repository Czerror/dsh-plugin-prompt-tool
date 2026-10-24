/** rule facts 与 schema 共用的 context-activation strategy id；纯 ESM，不 import 宿主或引擎模块。 */
export const CONTEXT_ACTIVATION_STRATEGY = 'context-activation'

// shortcut: context-activation 的其他字面量仍在 context-activation/actions/宿主导入路径；
// 这些路径未在本轮统一，等它们也要共享这个 id 时再收。
