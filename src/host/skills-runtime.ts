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
import { catalogFromScan, resolveBundledSkillsDir, scanRoots, skillPathKey, skillRoots, skillWriteRestriction, withSkillWinners } from './skills-scan.ts'
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
        const observed = await ctx.skills.snapshot(view)
        if (observedPending !== pending) continue
        const entries = listSkills(view.cwd)
        if (observedPending !== pending) continue
        const complete = observed.complete && !mountFailed
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
