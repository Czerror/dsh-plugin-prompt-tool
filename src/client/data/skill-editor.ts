/**
 * 技能目录与写入的 owner：读取、导入、创建、删除、调用策略与文件夹引用都在这一处。
 *
 * 形态与 `rule-drafts.ts` 的 `createRuleEditor(moduleId, draft, deps)` 一致——**显式声明依赖**，
 * 不自己创建。它的前提是「这个族有自己的状态载体」：`deps.state` 就是 skills 族的状态集合
 * （写锁、序号、会话），与核心 `load` 共用同一份 ref（`load` 读序号判这次技能读是否过期、
 * 在应答落地时写会话）。
 *
 * 写盘相关的校验（会话/上下文一致性、并发写锁、取消不报错）逐字保留自 store 内的原实现。
 */
import { bridgeCall, errorMessage } from './bridge-client.ts'
import type { BridgeResult } from './bridge-transport.ts'
import type { BridgeValueMap } from '../../shared/bridge-contract.ts'
import { requestSkillImport, type ConfirmSkillOverwrite } from './skill-import.ts'
import type { SkillCatalogEntry, SkillContentSnapshot, SkillPolicyChange } from '../../shared/skills.ts'

/** 技能目录族的状态载体（与核心 `load` 共用同一份 ref）。 */
export interface SkillCatalogState {
  /** 每次技能列表读取递增；应答回来时比对它判这次读是否过期。 */
  seq: number
  /** 上一次成功读取所属的会话：写操作的上下文一致性判据。 */
  session: string | undefined
  /** 写锁：覆盖按钮、Enter 与浏览器导入，React disabled 尚未渲染时也不会重复提交。 */
  writing: boolean
}

export interface SkillEditorDependencies {
  /** 族状态载体（由 store 持有，核心 load 与这里共用）。 */
  state: { readonly current: SkillCatalogState }
  /** 当前会话 id（上下文一致性判据）。 */
  currentSessionId: () => string | undefined
  /** 把技能列表快照落进字段（刷新成功后调用）。 */
  publishSkills: (snapshot: BridgeValueMap['skillsList']) => void
  /** 技能写入忙碌态（state，触发重渲染）。 */
  setBusy: (busy: boolean) => void
  /** 技能根：打开目录时的缺省目标。 */
  skillsRoot: () => string
  /** 统一提示通道（成功与失败同一条）。 */
  showNotice: (kind: 'ok' | 'error', message: string) => void
  /** 宿主能力：在文件管理器里打开路径。 */
  openPath: (path: string) => Promise<void>
}

export function createSkillEditor(deps: SkillEditorDependencies) {
  const state = deps.state

  const refreshSkills = async (): Promise<boolean> => {
    const seq = ++state.current.seq
    const sessionId = deps.currentSessionId()
    const res = await bridgeCall('skillsList', sessionId === undefined ? {} : { sessionId })
    if (seq !== state.current.seq || sessionId !== deps.currentSessionId()) return false
    if (!res.ok) {
      deps.showNotice('error', '技能列表刷新失败：' + (res.message ?? 'settings bridge unavailable'))
      return false
    }
    state.current.session = sessionId
    state.current.seq += 1
    deps.publishSkills(res.value)
    return true
  }

  /** 所有技能写操作共用即时忙期守卫与局部刷新，覆盖确认期间也保持忙碌。 */
  const writeSkill = async <T,>(
    submit: () => Promise<BridgeResult<T>>, success: (value: T) => string, failure: string,
  ): Promise<boolean> => {
    if (state.current.writing) { deps.showNotice('error', '技能正在保存，请稍候再试'); return false }
    state.current.writing = true
    deps.setBusy(true)
    try {
      const res = await submit()
      if (!res.ok) {
        if (res.code !== 'skills-import-cancelled') deps.showNotice('error', failure + '：' + (res.message ?? 'settings bridge unavailable'))
        return false
      }
      const refreshed = await refreshSkills()
      deps.showNotice(refreshed ? 'ok' : 'error', success(res.value) + (refreshed ? '' : '；技能列表刷新失败，请重新读取'))
      return true
    } catch (error) {
      deps.showNotice('error', failure + '：' + errorMessage(error))
      return false
    } finally {
      state.current.writing = false
      deps.setBusy(false)
    }
  }

  const importSkills = (submit: Parameters<typeof requestSkillImport>[0], confirm?: ConfirmSkillOverwrite) =>
    writeSkill(() => requestSkillImport(submit, confirm), ({ count, path, overwritten, warning }) =>
      `已复制 ${count} 个技能文件到 ${path}` + (overwritten > 0 ? `，覆盖 ${overwritten} 个已确认的同名技能` : '')
      + (warning ? `；导入已完成，清理提示：${warning}` : ''), '导入技能目录失败')

  const importSkillsDirectory = (path: string, confirm?: ConfirmSkillOverwrite): Promise<boolean> => {
    const source = path.trim()
    if (source.length === 0) { deps.showNotice('error', '请选择要导入的目录'); return Promise.resolve(false) }
    return importSkills((overwrite) => bridgeCall('skillsImportDirectory', { path: source, ...(overwrite === undefined ? {} : { overwrite }) }), confirm)
  }

  const createSkill = (input: { name: string; description: string; content: string }) =>
    writeSkill(() => bridgeCall('skillCreate', input), ({ id }) => `已创建技能：${id}`, '创建技能失败')

  const readSkill = async (skill: SkillCatalogEntry, sessionId: string | undefined): Promise<BridgeResult<SkillContentSnapshot>> => {
    if (skill.path === undefined || sessionId !== deps.currentSessionId() || sessionId !== state.current.session) {
      return { ok: false, message: '技能上下文已变化，请刷新后重试' }
    }
    const result = await bridgeCall('skillRead', { name: skill.name, path: skill.path, ...(sessionId === undefined ? {} : { sessionId }) })
    return sessionId === deps.currentSessionId() ? result : { ok: false, message: '技能上下文已变化，请刷新后重试' }
  }

  const saveSkill = async (skill: SkillCatalogEntry, content: string, description: string, expectedRevision: string, sessionId: string | undefined): Promise<BridgeResult<SkillContentSnapshot>> => {
    const path = skill.path
    if (path === undefined || sessionId !== deps.currentSessionId() || sessionId !== state.current.session) {
      return { ok: false, message: '技能上下文已变化，请刷新后重试' }
    }
    let result: BridgeResult<SkillContentSnapshot> = { ok: false, message: '技能正在保存，请稍候再试' }
    await writeSkill(async () => {
      result = await bridgeCall('skillWrite', { name: skill.name, path, content, description, expectedRevision, ...(sessionId === undefined ? {} : { sessionId }) })
      return result
    }, () => `已保存技能：${skill.name}`, '技能保存失败')
    return result
  }

  const deleteSkill = (skill: Pick<SkillCatalogEntry, 'name' | 'path'>): Promise<boolean> => {
    const sessionId = deps.currentSessionId()
    const path = skill.path
    if (path === undefined || sessionId !== state.current.session) {
      deps.showNotice('error', '技能上下文已变化，请刷新后重试')
      return Promise.resolve(false)
    }
    return writeSkill(() => bridgeCall('skillDelete', { name: skill.name, path, ...(sessionId === undefined ? {} : { sessionId }) }),
      ({ path }) => `已删除技能 ${skill.name}；文件已移入回收站 ${path}，可人工恢复`, `删除技能 ${skill.name} 失败`)
  }

  const setSkillPolicy = (name: string, path: string, change: SkillPolicyChange): Promise<boolean> => {
    const sessionId = deps.currentSessionId()
    if (sessionId !== state.current.session) {
      deps.showNotice('error', '技能上下文已变化，请刷新后重试')
      return Promise.resolve(false)
    }
    return writeSkill(() => bridgeCall('skillPolicy', { name, path, ...change, ...(sessionId === undefined ? {} : { sessionId }) }),
      () => `已更新技能 ${name} 的调用策略`, `技能 ${name} 调用策略写入失败`)
  }

  const patchSkillFolders = (folders: string[]) => {
    const sessionId = deps.currentSessionId()
    return writeSkill(() => bridgeCall('skillsFolders', { folders, ...(sessionId === undefined ? {} : { sessionId }) }),
      () => `已更新技能文件夹引用（${folders.length} 个）`, '技能文件夹保存失败')
  }

  const openSkillsDir = async (path?: string): Promise<void> => {
    const target = path ?? deps.skillsRoot()
    if (!target) { deps.showNotice('error', '技能目录路径未知，请先重新读取配置'); return }
    try {
      await deps.openPath(target)
      deps.showNotice('ok', '已打开技能目录：' + target)
    } catch (error) {
      deps.showNotice('error', '打开失败：' + errorMessage(error))
    }
  }

  return { refreshSkills, importSkillsDirectory, createSkill, readSkill, saveSkill, deleteSkill, setSkillPolicy, patchSkillFolders, openSkillsDir }
}
