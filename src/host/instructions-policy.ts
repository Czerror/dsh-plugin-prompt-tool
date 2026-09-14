/**
 * 指令文件卡策略：独立于预设与 settings 的本插件自有状态。
 *
 * 位置：`<DSH_HOME>/.prompt-tool/instructions.yml`（同一 DSH_HOME 下的所有预设共享）。
 * 只承载行为开关与展示名：正文永远在用户的原文件里，策略文件不存正文、读取版本、
 * 会话 ID 或任意客户端路径——路径与文件身份由服务端探测结果解析。
 *
 * 缺省 `enabled: false`：新独立来源必须先完成负责人切换验收，再由用户显式开启，
 * 不从各预设的旧 agentsHints 推导。文件缺失时用默认值，不因读取自动创建。
 * 写入使用 yaml Document API 保留注释与未知字段；解析失败或 schemaVersion 不认识时
 * 拒绝写入（不把损坏文件当空配置覆盖）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Document, isMap, parseDocument } from 'yaml'
// 枚举取值与引擎同源，避免两处常量漂移。
// @ts-expect-error 仓库根 ESM 引擎文件由 tsdown 作为源码依赖打包，无独立声明文件。
import { KNOWN_AUDIENCES, KNOWN_MODEL_SCOPES, KNOWN_POSITIONS, KNOWN_PROMOTIONS } from '../../engine/schema.mjs'
import { DSH_HOME } from './paths.ts'
import type {
  InstructionPolicy,
  InstructionPolicyFileOverride,
  InstructionPolicyPatch,
  InstructionPolicySnapshot,
  InstructionPolicyValues,
} from '../shared/instructions.ts'

export type { InstructionPolicy, InstructionPolicyFileOverride, InstructionPolicyPatch, InstructionPolicySnapshot, InstructionPolicyValues }

/** 相对 DSH_HOME 的策略文件位置（唯一权威定义）。 */
export const INSTRUCTIONS_POLICY_RELATIVE = join('.prompt-tool', 'instructions.yml')

/** 策略文件格式版本；不认识的值按损坏处理，不猜测迁移。 */
export const INSTRUCTIONS_POLICY_VERSION = 1

export type InstructionPolicyWriteOutcome =
  | { ok: true; revision: string; policy: InstructionPolicy }
  | { ok: false; status: 400 | 409; code: string; message: string }

/** 读取结果 = 跨端快照 + 服务端解析出的文件路径（客户端只用于展示/诊断）。 */
export interface InstructionPolicyRead extends InstructionPolicySnapshot {
  path: string
}

const DEFAULT_VALUES: InstructionPolicyValues = {
  order: 30,
  position: 'after-user',
  promotion: 'none',
  audience: null,
  modelScope: 'all',
}

const VALUE_KEYS = ['order', 'position', 'promotion', 'audience', 'modelScope'] as const
const OVERRIDE_KEYS = [...VALUE_KEYS, 'enabled', 'name'] as const

export function defaultInstructionPolicy(): InstructionPolicy {
  return { enabled: false, defaults: { ...DEFAULT_VALUES }, files: {} }
}

export function instructionPolicyPath(dshHome: string = DSH_HOME): string {
  return join(dshHome, INSTRUCTIONS_POLICY_RELATIVE)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')

/** 校验单个字段值；返回错误消息或 undefined。 */
function valueError(key: (typeof VALUE_KEYS)[number], value: unknown): string | undefined {
  if (key === 'order') {
    return typeof value === 'number' && Number.isFinite(value) && Number.isSafeInteger(value) && value >= 0
      ? undefined
      : 'order 必须是非负安全整数'
  }
  if (key === 'audience') {
    return value === null || (typeof value === 'string' && KNOWN_AUDIENCES.has(value))
      ? undefined
      : 'audience 必须是 null/main/subagent'
  }
  if (typeof value !== 'string') return `${key} 必须是字符串`
  const allowed = key === 'position' ? KNOWN_POSITIONS : key === 'promotion' ? KNOWN_PROMOTIONS : KNOWN_MODEL_SCOPES
  return allowed.has(value) ? undefined : `${key} 取值非法：${value}`
}

/** 请求体白名单校验：未知键一律拒绝，避免正文/路径/版本混进策略文件。 */
export function validateInstructionPolicyPatch(
  input: unknown,
): { ok: true; patch: InstructionPolicyPatch } | { ok: false; message: string } {
  if (!isRecord(input)) return { ok: false, message: '策略载荷必须是对象' }
  for (const key of Object.keys(input)) {
    if (key !== 'enabled' && key !== 'defaults' && key !== 'files') {
      return { ok: false, message: `未知字段：${key}` }
    }
  }
  const patch: InstructionPolicyPatch = {}
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return { ok: false, message: 'enabled 必须是布尔值' }
    patch.enabled = input.enabled
  }
  if (input.defaults !== undefined) {
    if (!isRecord(input.defaults)) return { ok: false, message: 'defaults 必须是对象' }
    const defaults: Partial<InstructionPolicyValues> = {}
    for (const [key, value] of Object.entries(input.defaults)) {
      if (!(VALUE_KEYS as readonly string[]).includes(key)) return { ok: false, message: `defaults 未知字段：${key}` }
      const error = valueError(key as (typeof VALUE_KEYS)[number], value)
      if (error !== undefined) return { ok: false, message: error }
      ;(defaults as Record<string, unknown>)[key] = value
    }
    patch.defaults = defaults
  }
  if (input.files !== undefined) {
    if (!isRecord(input.files)) return { ok: false, message: 'files 必须是对象' }
    const files: Record<string, InstructionPolicyFileOverride | null> = {}
    for (const [fileId, raw] of Object.entries(input.files)) {
      if (fileId.trim().length === 0) return { ok: false, message: 'files 键必须是非空 fileId' }
      if (raw === null) {
        files[fileId] = null
        continue
      }
      if (!isRecord(raw)) return { ok: false, message: `files.${fileId} 必须是对象或 null` }
      const override: InstructionPolicyFileOverride = {}
      for (const [key, value] of Object.entries(raw)) {
        if (!(OVERRIDE_KEYS as readonly string[]).includes(key)) return { ok: false, message: `files.${fileId} 未知字段：${key}` }
        if (key === 'enabled') {
          if (typeof value !== 'boolean') return { ok: false, message: `files.${fileId}.enabled 必须是布尔值` }
          override.enabled = value
          continue
        }
        if (key === 'name') {
          if (typeof value !== 'string' || value.trim().length === 0) return { ok: false, message: `files.${fileId}.name 必须是非空字符串` }
          override.name = value
          continue
        }
        const error = valueError(key as (typeof VALUE_KEYS)[number], value)
        if (error !== undefined) return { ok: false, message: `files.${fileId}.${error}` }
        ;(override as Record<string, unknown>)[key] = value
      }
      files[fileId] = override
    }
    patch.files = files
  }
  return { ok: true, patch }
}

/** 读取策略文件并归一化；文件缺失返回默认值（revision = null）。 */
export function readInstructionPolicy(file: string = instructionPolicyPath()): InstructionPolicyRead {
  const empty: InstructionPolicyRead = { policy: defaultInstructionPolicy(), revision: null, exists: false, path: file }
  if (!existsSync(file)) return empty
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    return { ...empty, exists: true, error: `读取指令策略失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const revision = sha256(raw)
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) {
    return { ...empty, exists: true, revision, error: `指令策略不是合法 YAML：${doc.errors[0]?.message ?? '解析失败'}` }
  }
  const data = doc.toJS() as unknown
  if (!isRecord(data)) return { ...empty, exists: true, revision, error: '指令策略必须是 YAML 映射' }
  const version = data.schemaVersion
  if (version !== undefined && version !== INSTRUCTIONS_POLICY_VERSION) {
    return { ...empty, exists: true, revision, error: `指令策略 schemaVersion 不受支持：${String(version)}` }
  }
  const validated = validateInstructionPolicyPatch({
    ...(data.enabled === undefined ? {} : { enabled: data.enabled }),
    ...(data.defaults === undefined ? {} : { defaults: data.defaults }),
    ...(data.files === undefined ? {} : { files: data.files }),
  })
  if (!validated.ok) return { ...empty, exists: true, revision, error: validated.message }
  const patch = validated.patch
  const policy: InstructionPolicy = {
    enabled: patch.enabled ?? false,
    defaults: { ...DEFAULT_VALUES, ...patch.defaults },
    files: Object.fromEntries(Object.entries(patch.files ?? {}).flatMap(([fileId, override]) => (override === null ? [] : [[fileId, override]]))),
  }
  return { policy, revision, exists: true, path: file }
}

/** 单文件的有效策略：部署级开关优先于每文件开关。 */
export function resolveInstructionPolicy(
  policy: InstructionPolicy,
  fileId: string,
): InstructionPolicyValues & { enabled: boolean; name?: string } {
  const override = policy.files[fileId] ?? {}
  return {
    ...policy.defaults,
    ...override,
    enabled: policy.enabled && override.enabled !== false,
  }
}

/** 写盘用文档：保留注释与未知字段。 */
function documentFor(file: string): { doc: Document } | { error: string } {
  if (!existsSync(file)) {
    const doc = new Document({})
    doc.commentBefore = ' prompt-tool 指令文件卡策略（独立于预设与 settings）\n'
      + ' enabled: 文件来源是否参与注入（缺省 false，先完成负责人切换再开启）\n'
      + ' defaults: 未单独覆盖的文件使用的行为；files: 按 fileId 的覆盖\n'
      + ' 这里不放正文：正文始终在用户自己的 AGENTS.md/CLAUDE.md 里'
    doc.set('schemaVersion', INSTRUCTIONS_POLICY_VERSION)
    return { doc }
  }
  const raw = readFileSync(file, 'utf8')
  const doc = parseDocument(raw)
  if (doc.errors.length > 0) return { error: `指令策略不是合法 YAML，已拒绝覆盖：${doc.errors[0]?.message ?? '解析失败'}` }
  return { doc }
}

function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/**
 * 乐观并发写入：`expectedRevision` 必须等于当前文件版本（文件缺失时为 null）。
 * 只改传入的键；恢复默认值即删除该键，不留空壳。
 */
export function writeInstructionPolicy(options: {
  patch: unknown
  expectedRevision: string | null
  file?: string
}): InstructionPolicyWriteOutcome {
  const file = options.file ?? instructionPolicyPath()
  const current = readInstructionPolicy(file)
  if (current.error !== undefined) {
    return { ok: false, status: 409, code: 'instructions-policy-unreadable', message: current.error }
  }
  if (current.revision !== options.expectedRevision) {
    return {
      ok: false,
      status: 409,
      code: 'instructions-policy-conflict',
      message: '指令策略已被外部修改，保存被拒绝；请重新读取后再保存',
    }
  }
  const validated = validateInstructionPolicyPatch(options.patch)
  if (!validated.ok) return { ok: false, status: 400, code: 'instructions-policy-invalid', message: validated.message }
  const prepared = documentFor(file)
  if ('error' in prepared) return { ok: false, status: 409, code: 'instructions-policy-unreadable', message: prepared.error }
  const { doc } = prepared
  const patch = validated.patch

  if (patch.enabled !== undefined) {
    if (patch.enabled === false) doc.delete('enabled')
    else doc.set('enabled', true)
  }
  if (patch.defaults !== undefined) {
    for (const key of VALUE_KEYS) {
      const value = patch.defaults[key]
      if (value === undefined) continue
      if (value === DEFAULT_VALUES[key]) doc.deleteIn(['defaults', key])
      else doc.setIn(['defaults', key], value)
    }
    // 空 defaults（全部恢复默认）不留空壳映射。
    const defaults = doc.get('defaults')
    if (isMap(defaults) && defaults.items.length === 0) doc.delete('defaults')
  }
  if (patch.files !== undefined) {
    for (const [fileId, override] of Object.entries(patch.files)) {
      if (override === null) {
        doc.deleteIn(['files', fileId])
        continue
      }
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue
        if (key === 'enabled' && value === true) doc.deleteIn(['files', fileId, 'enabled'])
        else doc.setIn(['files', fileId, key], value)
      }
      const overrideNode = doc.getIn(['files', fileId])
      if (isMap(overrideNode) && overrideNode.items.length === 0) {
        doc.deleteIn(['files', fileId])
      }
    }
    const files = doc.get('files')
    if (isMap(files) && files.items.length === 0) doc.delete('files')
  }

  const content = doc.toString()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileAtomic(file, content)
  } catch (error) {
    return {
      ok: false,
      status: 409,
      code: 'instructions-policy-write-failed',
      message: `写入指令策略失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const written = readInstructionPolicy(file)
  if (written.error !== undefined) {
    return { ok: false, status: 409, code: 'instructions-policy-unreadable', message: written.error }
  }
  return { ok: true, revision: written.revision ?? sha256(content), policy: written.policy }
}
