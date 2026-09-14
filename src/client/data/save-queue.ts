/** 失败不阻断后续任务的最小串行队列。 */
export interface SerialTaskQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    enqueue(task) {
      const current = tail.then(task)
      tail = current.catch(() => {})
      return current
    },
  }
}
