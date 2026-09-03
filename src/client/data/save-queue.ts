/** 失败不阻断后续任务的最小串行队列。 */
export interface SerialTaskQueue {
  enqueue(task: () => Promise<void>): Promise<void>
}

export function createSerialTaskQueue(): SerialTaskQueue {
  let tail = Promise.resolve()
  return {
    enqueue(task) {
      const current = tail.then(task)
      tail = current.catch(() => {})
      return current
    },
  }
}
