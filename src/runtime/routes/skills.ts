/** skills 域端点：清单、策略、正文读写、引用目录、导入与增删。 */
import type { SkillPolicyChange, SkillPolicyScope } from '../../shared/skills.ts'
import { MAX_SKILL_CONTENT_BYTES } from '../../shared/skills.ts'
import { SKILL_NAME_PATTERN } from '../../host/skills-config.ts'
import { assertImportableSource, importSkillsDirectory, importSkillsPackage } from '../../host/skills-import.ts'
import { createSkill } from '../../host/skills-actions.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import { localAgentCwd, readSessionIdField, type BridgeRuntime } from '../bridge-runtime.ts'

/** 确认名单只授权已展示的目录；不是允许覆盖任意同名目标的总开关。 */
function readSkillOverwrite(value: unknown): string[] | undefined {
  if (value === undefined) return []
  return Array.isArray(value) && value.length <= 10_000
    && value.every((name) => typeof name === 'string' && SKILL_NAME_PATTERN.test(name))
    ? [...new Set(value as string[])] : undefined
}

export function registerSkills(runtime: BridgeRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.skillsList, { handle: async (tx) => {
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'skills-list-rejected', message: session.message })
        return
      }
      // 项目技能按会话工作目录解析；没有存活会话时只列用户根与内置来源。
      const state = runtime.deps.skills()
      tx.write(200, {
        ok: true,
        value: {
          ...await runtime.collectSkills(session.sessionId),
          folders: state.folders,
          roots: [state.skillsRoot],
        },
      })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.skillsImport, { handle: async (tx) => {
      const record = tx.record
      const files = Array.isArray(record.files) ? record.files : []
      const overwrite = readSkillOverwrite(record.overwrite)
      if (overwrite === undefined) {
        tx.write(400, { ok: false, code: 'skills-import-rejected', message: 'overwrite 必须是已确认的技能目录名数组' })
        return
      }
      const root = runtime.deps.skills().skillsRoot
      const result = importSkillsPackage(root, files, overwrite)
      if (!result.ok) {
        tx.write(result.code === 'skills-overwrite-required' ? 409 : 400,
          { ...result, code: result.code ?? 'skills-import-rejected' })
        return
      }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: result })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.skillPolicy, { handle: async (tx) => {
      const record = tx.record
      const change: SkillPolicyChange | undefined = record.scope === undefined
        ? ((record.side === 'model' || record.side === 'user') && typeof record.enabled === 'boolean'
          ? { side: record.side, enabled: record.enabled } : undefined)
        : (record.side === undefined && record.enabled === undefined && typeof record.scope === 'string'
          && ['none', 'model', 'user', 'all'].includes(record.scope)
          ? { scope: record.scope as SkillPolicyScope } : undefined)
      if (typeof record.name !== 'string' || record.name.length === 0
        || typeof record.path !== 'string' || record.path.length === 0 || change === undefined) {
        tx.write(400, { ok: false, code: 'skill-policy-rejected', message: 'name、path 与单端 side/enabled 或显式 scope 必填' })
        return
      }
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'skill-policy-rejected', message: session.message })
        return
      }
      // 身份校验在与清单相同的工作区视图里做：客户端提交的 path 只有命中服务端当次扫描的
      // 同名条目才被接受，陈旧界面因此改不到被替换过的同名技能。
      const cwd = session.sessionId === undefined ? undefined : localAgentCwd(runtime.scope, session.sessionId)
      const written = runtime.deps.skills().setSkillPolicy(record.name, record.path, change, cwd)
      if (written.ok === false) {
        // 界面陈旧、技能无效、只读或链接目标等都在这里如实回报，不静默。
        tx.write(409, { ok: false, code: 'skill-policy-rejected', message: written.message })
        return
      }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: await runtime.collectSkills(session.sessionId) })
    } }),
    ...(['skillRead', 'skillWrite'] as const).map((endpoint) => runtime.register(BRIDGE_ENDPOINTS[endpoint], { handle: async (tx) => {
      const record = tx.record
      const code = endpoint === 'skillWrite' ? 'skill-write-rejected' : 'skill-read-rejected'
      if (typeof record.name !== 'string' || record.name.length === 0 || record.name.length > 256
        || typeof record.path !== 'string' || record.path.length === 0 || record.path.length > 32768
        || (endpoint === 'skillWrite' && (typeof record.content !== 'string'
          || Buffer.byteLength(record.content, 'utf8') > MAX_SKILL_CONTENT_BYTES
          || typeof record.description !== 'string' || record.description.trim().length === 0 || record.description.length > 8192
          || typeof record.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(record.expectedRevision)))) {
        tx.write(400, { ok: false, code, message: 'name、path 必填；保存需要 1 MiB 以内的 content、非空 description（最多 8192 字符）和有效 expectedRevision' })
        return
      }
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code, message: session.message })
        return
      }
      const cwd = session.sessionId === undefined ? undefined : localAgentCwd(runtime.scope, session.sessionId)
      const state = runtime.deps.skills()
      const result = endpoint === 'skillWrite'
        ? state.writeSkillContent(record.name, record.path, record.content as string, record.description as string, record.expectedRevision as string, cwd)
        : state.readSkillContent(record.name, record.path, cwd)
      if (!result.ok) {
        tx.write(409, { ok: false, code, message: result.message })
        return
      }
      if (endpoint === 'skillWrite' && result.changed) runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: { content: result.content, description: result.description, revision: result.revision } })
    } })),
    runtime.register(BRIDGE_ENDPOINTS.skillsFolders, { handle: async (tx) => {
      const record = tx.record
      if (!Array.isArray(record.folders) || record.folders.some((item) => typeof item !== 'string')) {
        tx.write(400, { ok: false, code: 'skills-folders-rejected', message: 'folders 必须是字符串数组' })
        return
      }
      const session = readSessionIdField(tx.record)
      if (!session.ok) {
        tx.write(400, { ok: false, code: 'skills-folders-rejected', message: session.message })
        return
      }
      // 只记引用，不复制也不移动任何文件。
      const written = await runtime.deps.skills().patchSkillFolders(record.folders as string[])
      if (written.ok === false) {
        tx.write(409, { ok: false, code: 'skills-folders-rejected', message: written.message })
        return
      }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, {
        ok: true,
        value: { ...await runtime.collectSkills(session.sessionId), folders: written.state.folders },
      })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.skillCreate, { handle: async (tx) => {
      const record = tx.record
      const result = createSkill(runtime.deps.skills().skillsRoot, record as { name: unknown; description: unknown; content: unknown })
      if (!result.ok) { tx.write(400, { ok: false, code: 'skill-create-rejected', message: result.message }); return }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: result })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.skillDelete, { handle: async (tx) => {
      const record = tx.record
      const session = readSessionIdField(tx.record)
      if (!session.ok || typeof record.name !== 'string' || record.name.length === 0
        || typeof record.path !== 'string' || record.path.length === 0) {
        tx.write(400, { ok: false, code: 'skill-delete-rejected', message: session.ok ? 'name、path 必填' : session.message })
        return
      }
      const cwd = session.sessionId === undefined ? undefined : localAgentCwd(runtime.scope, session.sessionId)
      const result = runtime.deps.skills().deleteSkill(record.name, record.path, cwd)
      if (!result.ok) { tx.write(400, { ok: false, code: 'skill-delete-rejected', message: result.message }); return }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: result })
    } }),
    runtime.register(BRIDGE_ENDPOINTS.skillsImportDirectory, { handle: async (tx) => {
      const body = tx.record
      const source = typeof body.path === 'string' ? body.path : ''
      // 与实现层共用同一个校验入口：空串不能落到 resolve，否则会退化成进程工作目录。
      try {
        assertImportableSource(source)
      } catch (error) {
        tx.write(400, { ok: false, code: 'skills-import-rejected', message: `技能导入失败：${error instanceof Error ? error.message : String(error)}` })
        return
      }
      const overwrite = readSkillOverwrite(body.overwrite)
      if (overwrite === undefined) {
        tx.write(400, { ok: false, code: 'skills-import-rejected', message: 'overwrite 必须是已确认的技能目录名数组' })
        return
      }
      const result = importSkillsDirectory(runtime.deps.skills().skillsRoot, source, overwrite)
      if (!result.ok) {
        tx.write(result.code === 'skills-overwrite-required' ? 409 : 400,
          { ...result, code: result.code ?? 'skills-import-rejected' })
        return
      }
      runtime.deps.afterSkillsChange?.()
      tx.write(200, { ok: true, value: result })
    } }),
  ]
}
