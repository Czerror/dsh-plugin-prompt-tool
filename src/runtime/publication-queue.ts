import { createTargetQueue } from '../shared/target-queue.ts'
import type { PublicationFailure } from '../shared/publication.ts'
import { ModuleWriteError } from '../host/module-write.ts'

interface PublicationQueueOptions {
  /** 返回 true 表示本次成功验证了全部存活 Agent，可清除此前全量失败。 */
  publish(moduleIds: readonly string[] | undefined, retry: readonly string[] | true, expected?: { id: string; generation: string }): Promise<boolean | void>
  warn(message: string): void
}

/** 保存防抖与请求前冲刷共用待发布集合；回调只消费当批快照。 */
export function createPublicationQueue(options: PublicationQueueOptions) {
  const serial = createTargetQueue()
  const ids = new Set<string>()
  const retries = new Set<string>()
  const errors = new Map<string, PublicationFailure>()
  let all = false, retryAll = false, active = true
  let timer: ReturnType<typeof setTimeout> | undefined
  let timerDone: Promise<void> | undefined
  let resolveTimer: (() => void) | undefined
  let running: Promise<void> | undefined

  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    resolveTimer?.()
    resolveTimer = undefined
    timerDone = undefined
  }
  const assertActive = (): void => {
    if (!active) throw new Error('publication queue released')
  }
  const include = (id?: string): void => {
    if (id === undefined) { all = true; ids.clear() }
    else if (!all) ids.add(id)
  }
  const publish = async (modules: readonly string[] | undefined, retry: readonly string[] | true, expected?: { id: string; generation: string }): Promise<void> => {
    try {
      const complete = await options.publish(modules, retry, expected)
      if (modules === undefined || complete === true) errors.clear()
      else for (const id of modules) errors.delete(id)
    } catch (error) {
      if (error instanceof ModuleWriteError && error.code === 'rules-conflict') throw error
      const message = error instanceof Error ? error.message : String(error)
      const at = Date.now()
      for (const id of modules ?? [undefined]) errors.set(id ?? '', { ...(id === undefined ? {} : { moduleId: id }), message, at })
      try { options.warn(message) } catch { /* 日志故障不覆盖原发布异常。 */ }
      throw error
    }
  }
  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = serial.run('publication', task)
    running = next
    const finished = (): void => { if (running === next) running = undefined }
    void next.then(finished, finished)
    return next
  }
  const start = (): Promise<void> => {
    cancelTimer()
    if (running !== undefined) return running.catch(() => {}).then(start)
    if (!active || (!all && ids.size === 0)) return Promise.resolve()
    const modules = all ? undefined : [...ids]
    const retry = retryAll ? true : [...retries]
    all = false; retryAll = false; ids.clear(); retries.clear()
    return enqueue(() => publish(modules, retry))
  }

  return {
    schedule(moduleId?: string): void {
      assertActive()
      include(moduleId)
      cancelTimer()
      timerDone = new Promise(resolve => { resolveTimer = resolve })
      timer = setTimeout(() => { void start().catch(() => {}) }, 300)
    },
    flush(moduleId?: string, retry = true): Promise<void> {
      assertActive()
      if (retry) {
        include(moduleId)
        if (moduleId === undefined) retryAll = true
        else retries.add(moduleId)
      } else if (moduleId !== undefined) include(moduleId)
      return start()
    },
    flushVersion(id: string, generation: string): Promise<void> {
      assertActive()
      return enqueue(() => publish([id], [id], { id, generation }))
    },
    async settled(): Promise<void> {
      while (timerDone !== undefined || running !== undefined) {
        await Promise.all([timerDone, running?.catch(() => {})])
      }
    },
    failures(): PublicationFailure[] {
      return active ? [...errors.values()].map(error => ({ ...error })) : []
    },
    async dispose(): Promise<void> {
      active = false
      cancelTimer()
      all = false; retryAll = false; ids.clear(); retries.clear(); errors.clear()
      await running?.catch(() => {})
    },
  }
}
