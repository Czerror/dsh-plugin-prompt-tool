/** 失败不阻断后续任务的最小串行队列。 */
import { createTargetQueue } from '../../shared/target-queue.ts'
export interface SerialTaskQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialTaskQueue(): SerialTaskQueue {
  const queue = createTargetQueue()
  return { enqueue: task => queue.run('global', task) }
}
