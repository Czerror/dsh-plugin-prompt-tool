/**
 * 预设保存后的「宿主默认模型同步」提示。
 *
 * 预设参数落盘与宿主默认模型同步是两件事：前者成功、后者未完成时，
 * 用户必须同时看到「已保存」和「未同步（可重试）」，不能只报成功或只报失败。
 * 纯函数：由 store 在保存成功后调用，便于单测覆盖四态。
 */
import type { ModelSyncResult } from '../../shared/bridge-contract.ts'

export interface ModelSyncNotice {
  kind: 'ok' | 'error'
  message: string
}

export function modelSyncNotice(
  modelSync: ModelSyncResult | undefined,
  savedLabel: string,
): ModelSyncNotice | undefined {
  // 没有同步事实（例如 rebuild:false 的预设切换保存）不提示。
  if (modelSync === undefined) return undefined
  // synced / unchanged 都是「宿主默认即为目标值」，无需打扰用户。
  if (modelSync.status === 'synced' || modelSync.status === 'unchanged') return undefined
  const reason = modelSync.status === 'unavailable' ? '宿主默认模型同步不可用' : '宿主默认模型同步失败'
  const detail = (modelSync.message ?? '').trim()
  return {
    kind: 'error',
    message: `${savedLabel}；${reason}${detail.length > 0 ? `（${detail}）` : ''}，可再次保存重试`,
  }
}
