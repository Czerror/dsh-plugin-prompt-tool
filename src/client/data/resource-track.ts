/**
 * 资源编辑器的**读改写协议原语**：最新优先。
 *
 * 协议里各家 owner 真实共用的只有这一条策略：**只有最新一次请求拥有落地与清理权**——
 * 晚到的应答既不写草稿、也不清 `busy`/`loading`（清理权归最新那次请求，否则界面会停在忙碌态）。
 * 序号字段统一叫 `latest`，落在草稿/状态对象里（跨渲染保持）。
 *
 * 只有这一件被抽出来，是因为其余部分各家确实不同（对照见 docs/ui-architecture.md 的协议小节）：
 * 请求形状与分域粒度（rules 逐条 + settings、variables 按 scope、persona 两段）、失败分类
 * （rules 有 `READ_FIRST_CODES` 三分类、instructions 有 4 个冲突码、其余无）、发布态
 * （统一读 `shared/publication.ts#readPublication`，不在各 owner 复制判据）。
 * 硬包一个通用轨道需要 ~9 个回调，接口比它替换的代码还长——那是浅模块，不做。
 */

/** 带「最新优先」序号的对象：草稿、状态或池都能满足它。 */
export interface LatestSequence {
  latest: number
}

/** 开一次请求，返回它的序号。 */
export function beginLatest(holder: LatestSequence): number {
  return ++holder.latest
}

/** 这次请求是否仍是最新的一次——只有它为真时才允许落地与清理。 */
export function isLatest(holder: LatestSequence, seq: number): boolean {
  return seq === holder.latest
}
