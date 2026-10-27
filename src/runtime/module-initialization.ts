import type { Context, Fiber } from '@deepseek-ai/cordis'

interface InitializationOwner {
  ready(): void
  failed(error: unknown): void
}

// 官方 FiberState.ACTIVE；该 const enum 没有运行期导出。
const ACTIVE = 2

/** 只跟踪装配拥有的初始化后代；任务执行异常不经过 Fiber 生命周期。 */
export function createModuleInitialization(ctx: Context) {
  type Group = { fibers: Map<number, Fiber>; owner: InitializationOwner; active: boolean; failed: boolean }
  const groups = new Map<number, Group>()
  const tasks = new Map<Promise<void>, Group>()
  const pruneDisposed = (group: Group): void => {
    for (const [id, fiber] of group.fibers) if (fiber.uid === null) {
      group.fibers.delete(id)
      groups.delete(id)
    }
  }
  const check = (group: Group): void => {
    if (!group.active || group.failed) return
    pruneDisposed(group)
    const task = Promise.resolve().then(async () => {
      await Promise.all([...group.fibers.values()].filter(fiber => fiber.uid !== null).map(fiber => fiber.await()))
      if (!group.active || group.failed) return
      pruneDisposed(group)
      if ([...group.fibers.values()].every(fiber => fiber.uid === null || fiber.state === ACTIVE)) group.owner.ready()
    }).catch((error: unknown) => {
      if (!group.active || group.failed) return
      group.failed = true
      group.owner.failed(error)
    }).finally(() => { tasks.delete(task) })
    tasks.set(task, group)
  }
  const listeners = [
    ctx.on('internal/plugin', fiber => {
      const parentId = fiber.parent.fiber.uid
      const group = parentId === null ? undefined : groups.get(parentId)
      if (group === undefined || !group.active) return
      if (fiber.uid === null) { pruneDisposed(group); return }
      group.fibers.set(fiber.uid, fiber)
      groups.set(fiber.uid, group)
      check(group)
    }, { global: true }),
    ctx.on('internal/status', fiber => {
      const id = fiber.uid ?? fiber.parent.fiber.uid
      const group = id === null ? undefined : groups.get(id)
      if (group !== undefined) check(group)
    }, { global: true }),
  ]
  ctx.effect(() => () => {
    for (const group of groups.values()) group.active = false
    groups.clear()
    for (const off of listeners) off()
  }, 'prompt-tool module initialization')
  return {
    observe(root: Fiber, owner: InitializationOwner): () => void {
      if (root.uid === null) return () => {}
      const group: Group = { fibers: new Map([[root.uid, root]]), owner, active: true, failed: false }
      groups.set(root.uid, group)
      check(group)
      return () => {
        group.active = false
        for (const id of group.fibers.keys()) groups.delete(id)
        for (const [task, owner] of tasks) if (owner === group) tasks.delete(task)
      }
    },
    async settled(roots?: readonly Fiber[]): Promise<void> {
      const selected = roots === undefined ? undefined : new Set(roots.flatMap(root => root.uid === null ? [] : [groups.get(root.uid)]))
      while (true) {
        const pending = [...tasks].filter(([, group]) => group.active && (selected === undefined || selected.has(group))).map(([task]) => task)
        if (pending.length === 0) return
        await Promise.all(pending)
      }
    },
  }
}
