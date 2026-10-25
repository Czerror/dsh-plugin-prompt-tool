/**
 * 一次已写盘操作的运行发布结果：host 生成、client 读取的唯一形状。
 *
 * 发布失败不是写入失败——定义已经提交到磁盘，只是运行实例还没跟上。它必须与
 * 4xx/5xx 的「没有写盘」区分开，由 `persisted` 与 `publicationPending` 表达。
 */
export interface PublicationFields {
  /** 写响应恒为 true；读响应不出现。 */
  persisted?: true
  /** 定义已落盘、运行发布尚未成功；失败原因见 `publicationError`。 */
  publicationPending?: boolean
  /** 给人读的发布失败原因；没有失败时缺席。 */
  publicationError?: string
}

export interface PublicationState extends PublicationFields {
  persisted: true
  publicationPending: boolean
}

/** 写盘已完成后的发布结果：成功恒发 pending:false，失败带域自己的文案。 */
export function published(error?: string): PublicationState {
  return error === undefined
    ? { persisted: true, publicationPending: false }
    : { persisted: true, publicationPending: true, publicationError: error }
}

/**
 * 客户端的唯一解读：显式 pending 或任意 error 都算待发布。
 *
 * 显式 `publicationPending: false` 不能压过 `publicationError`——错误存在就说明
 * 上次发布失败，重试入口必须仍然可见。
 */
export function readPublication(value: PublicationFields | undefined): { pending: boolean; error?: string } {
  const error = value?.publicationError
  return {
    pending: value?.publicationPending === true || error !== undefined,
    ...(error === undefined ? {} : { error }),
  }
}
