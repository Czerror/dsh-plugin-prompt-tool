/** 进程内 per-target 串行：同 key 的任务依次执行，不同 key 互不阻塞。 */
export interface TargetQueue {
  run<T>(key: string, task: () => T | Promise<T>): Promise<T>
}

/**
 * key 由调用方给规范形式（路径大小写折叠、目标身份拼接都归调用方）；
 * 原语不做路径解析，也不持跨进程锁。
 */
export function createTargetQueue(): TargetQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    run<T>(key: string, task: () => T | Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      // tails 只存已收敛的 entry，previous 不会拒绝；任务自己的 rejection 原样返回。
      const run = previous.then(() => task())
      // 队尾只保存「已收敛」的 entry，供下一位挂链；清理只在仍是队尾时发生。
      const entry = run.then(() => undefined, () => undefined)
      tails.set(key, entry)
      void entry.then(() => {
        if (tails.get(key) === entry) tails.delete(key)
      })
      return run
    },
  }
}
