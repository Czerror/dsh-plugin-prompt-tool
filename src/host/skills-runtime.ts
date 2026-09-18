/** 技能管理运行时：状态与资产属于插件，候选发现、缓存和作用域属于官方 registry。 */
import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl, SkillViewOptions } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SkillCatalogEntry, SkillPolicyChange, SkillsCatalogSnapshot, SkillsState } from '../shared/skills.ts'
import { createSkillsWatcher } from '../runtime/skills-watcher.ts'
import { deleteSkillTarget, type SkillActionResult } from './skills-actions.ts'
import { readSkillsState, skillsStatePath, writeSkillsState, type SkillsStateRead } from './skills-config.ts'
import { policyTarget, setSkillInvocation, type SkillPolicyWrite } from './skills-policy.ts'
import { createSkillsProvider } from './skills-provider.ts'
import { createSkillsReloader } from './skills-refresh.ts'
import { catalogFromScan, resolveBundledSkillsDir, scanRoots, skillPathKey, skillRoots, skillWriteRestriction, withGlobalSkillFallback, withSkillWinners } from './skills-scan.ts'
import { DSH_HOME } from './paths.ts'

export interface SkillsRuntime {
  readonly skillsRoot: string
  readonly folders: string[]
  listSkills: (cwd?: string) => SkillCatalogEntry[]
  snapshot: (options?: SkillViewOptions) => Promise<SkillsCatalogSnapshot>
  setPolicy: (name: string, path: string, change: SkillPolicyChange, cwd?: string) => SkillPolicyWrite
  deleteSkill: (name: string, path: string, cwd?: string) => SkillActionResult
  setFolders: (folders: string[]) => SkillsStateRead
  invalidate: () => void
}

const within = (path: string, root: string): boolean => {
  const suffix = relative(skillPathKey(root), skillPathKey(path))
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

export function createSkillsRuntime(ctx: Context, options: { dshHome?: string } = {}): SkillsRuntime {
  const dshHome = resolve(options.dshHome ?? DSH_HOME)
  const skillsRoot = join(dshHome, 'skills')
  const stateFile = skillsStatePath(dshHome)
  const initial = readSkillsState(stateFile)
  let state = initial.state
  let stateSnapshot = JSON.stringify(state)
  let disposed = false
  let pending = Promise.resolve()
  let mountFailed = false

  const mount = (folders: readonly string[]) => {
    let provider: ReturnType<typeof createSkillsProvider> | undefined
    let control: SkillProviderControl | undefined
    const unregister = ctx.skills.registerProvider((borrowed) => {
      control = borrowed
      provider = createSkillsProvider(ctx, borrowed, folders)
      return provider
    })
    return { unregister, provider: provider!, invalidate: (): void => { control?.invalidate() } }
  }
  let mounted = mount(state.folders)
  ctx.on('fs/observed', (target, _observation, actor) => {
    if (actor !== undefined && 'name' in actor && (actor.name === 'edit' || actor.name === 'write')) {
      mounted.provider.observeHostMutation(target.displayPath)
    }
  })
  const accept = (next: SkillsState, snapshot: string): void => {
    state = next
    if (snapshot === stateSnapshot || disposed) return
    stateSnapshot = snapshot
    const folders = [...next.folders]
    pending = pending.then(async () => {
      mounted.unregister()
      await mounted.provider.dispose()
      if (disposed) return
      mounted = mount(folders)
      mountFailed = false
    }).catch((error: unknown) => {
      mountFailed = true
      ctx.logger.warn(`prompt-tool: 技能提供方更新失败：${String(error)}`)
    })
  }
  const reloader = createSkillsReloader({
    stateFile, currentSnapshot: () => stateSnapshot, accept,
    warn: (message) => ctx.logger.warn(`prompt-tool: ${message}`),
  })
  reloader.reload()
  const watcher = createSkillsWatcher(stateFile, reloader.reload)
  ctx.effect(() => async () => {
    disposed = true
    watcher.close()
    mounted.unregister()
    await pending
    await mounted.provider.dispose()
  }, 'prompt-tool skills runtime')

  const allowedDeleteRoots = (): string[] => {
    const bundled = resolveBundledSkillsDir()
    return [skillsRoot, ...state.folders].filter((root) => {
      if (resolve(root).split(sep).some((part) => part.toLowerCase() === '.system')) return false
      return bundled === undefined || !within(root, bundled)
    })
  }
  const listSkills = (cwd?: string): SkillCatalogEntry[] => {
    reloader.reload()
    const allowed = allowedDeleteRoots()
    const bundled = resolveBundledSkillsDir()
    return catalogFromScan(scanRoots(skillRoots({ cwd, dshHome, folders: state.folders }))).map((entry) => {
      const official = bundled !== undefined && entry.path !== undefined && within(entry.path, bundled)
      return {
        ...entry,
        canDelete: entry.valid && entry.path !== undefined && allowed.some((root) => skillPathKey(root) === skillPathKey(entry.dir))
          && skillWriteRestriction(entry.path) === undefined,
        ...(official ? { canSetPolicy: false, canDelete: false, readonlyReason: '官方内置技能只读' } : {}),
      }
    })
  }
  const invalidate = (): void => { if (!disposed) mounted.invalidate() }
  return {
    skillsRoot,
    get folders() { return [...state.folders] },
    listSkills,
    snapshot: async (view = {}) => {
      reloader.reload()
      for (;;) {
        const observedPending = pending
        await observedPending
        // 带 scope 的查询只读该视图层（官方 SkillViewOptions 注释：omitted reads the
        // global layer alone）；技能装在全局层时它整表为空，而空 resolved 会让
        // withSkillWinners 把每个条目判成 unregistered——技能页于是整页显示
        // 「当前会话未注册」。视图为空时回退到不带 scope 的全局视图。
        const scoped = await ctx.skills.snapshot(view)
        const observed = view.scope === undefined
          ? scoped
          : await withGlobalSkillFallback(scoped, () => ctx.skills.snapshot({ ...view, scope: undefined }))
        // 诊断出口：视图异常为空是「整页未注册」的唯一成因，留下可定位的一行。
        if (view.scope !== undefined && observed !== scoped) {
          ctx.logger?.warn(`prompt-tool: 带 scope 的技能视图为空，已改用全局视图（cwd=${view.cwd ?? ''}）`)
        }
        if (view.scope !== undefined && observed.skills.length === 0) {
          ctx.logger?.warn(`prompt-tool: 技能注册表视图为空，技能页将显示未注册（cwd=${view.cwd ?? ''}；scope 视图与全局视图均为空）`)
        }
        if (observedPending !== pending) continue
        const entries = listSkills(view.cwd)
        if (observedPending !== pending) continue
        // 注册表只作补充、不作否决（与参照实现 dsh-web 的 collectSkills 同策略）：
        // 插件这一层只有引用 provider，看不到宿主注册的官方 provider，注册表因此可能
        // 整体为空——「观测完整但没有条目」并不等于「技能都没注册」。此时按观测不可用
        // 处理，条目保留 unknown，而不是把整页误报成 unregistered。
        const registryInformed = observed.skills.length > 0 || entries.length === 0
        const complete = observed.complete && !mountFailed && registryInformed
        return { skills: withSkillWinners(entries, observed.skills, complete), complete }
      }
    },
    setPolicy: (name, path, change, cwd) => {
      const entries = listSkills(cwd)
      const check = policyTarget(entries, name, path)
      if (!check.ok) return check
      const entry = entries.find((skill) => skill.name === name && skill.path === path)!
      if (!entry.canSetPolicy) return { ok: false, message: entry.readonlyReason ?? '该技能只读' }
      const result = setSkillInvocation(path, change)
      if (result.ok) invalidate()
      return result
    },
    deleteSkill: (name, path, cwd) => {
      const entry = listSkills(cwd).find((skill) => skill.name === name && skill.path === path)
      if (entry === undefined) return { ok: false, message: '技能或引用目录已变化，请刷新后重试' }
      if (!entry.canDelete) return { ok: false, message: entry.readonlyReason ?? '该来源不允许删除' }
      const result = deleteSkillTarget(allowedDeleteRoots(), path)
      if (result.ok) invalidate()
      return result
    },
    setFolders: (folders) => {
      const result = writeSkillsState({ folders }, stateFile)
      if (result.ok) accept(result.state, JSON.stringify(result.state))
      return result
    },
    invalidate,
  }
}
