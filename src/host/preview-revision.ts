/**
 * 导入预览版本（previewRevision）：把「这次预览代表哪一次输入」压成稳定摘要。
 *
 * 预览身份与写入凭证是两件事：`sourceDigest` 只证明「提交的文件内容与预览时相同」，
 * 而 `previewRevision` 还绑定**实际选组**、**转换器版本**与**目标身份（含目标当前版本）**，
 * 因此换组、换文件、换目标或预览期间目标被改动都会失配。版本永远由服务端计算，
 * 客户端只回传；凭据不构成写入授权，服务端每次提交都重算。
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** 预览协议版本：字段语义变化时递增，纳入 revision 计算。 */
export const PREVIEW_PROTOCOL_VERSION = 'st-preview/1'

export interface PreviewFileEntry {
  path: string
  content: string
}

/**
 * 目标身份：导入类型、由内容解析出的目标 id、目标归属，以及目标**当前**的内容版本。
 * `targetVersion === null` 表示目标尚不存在——必须与「已存在」可区分，否则无法判断
 * 本次提交是新建还是覆盖，也无法发现预览期间用户已改过目标。
 */
export interface PreviewTargetIdentity {
  kind: 'preset-package' | 'character-card'
  targetId: string
  targetVersion: string | null
  /** 目标归属（预设包 = 目标预设目录名；角色卡 = 角色库所属预设）。 */
  ownerPreset: string
}

export interface PreviewRevisionInput {
  files: PreviewFileEntry[]
  orderCharacterId?: string
  converter: string
  target: PreviewTargetIdentity
}

/** 文件顺序参与身份（多文件合并结果依赖顺序），因此不做排序。 */
function fileFingerprint(entry: PreviewFileEntry): [string, string] {
  return [entry.path, createHash('sha256').update(entry.content).digest('hex')]
}

/** 结构化、确定序列化后的 SHA-256：同输入必得同值，任一绑定项变化即改变。 */
export function computePreviewRevision(input: PreviewRevisionInput): string {
  const canonical = JSON.stringify([
    PREVIEW_PROTOCOL_VERSION,
    input.converter,
    input.files.map(fileFingerprint),
    input.orderCharacterId ?? null,
    [input.target.kind, input.target.targetId, input.target.targetVersion, input.target.ownerPreset],
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

/**
 * 目录内容版本：按相对路径排序后逐个摘要文件内容，目录不存在返回 `null`。
 * 只用于目标身份的"是否被改过"判断，不持久化、不缓存。
 */
export function directoryVersionOf(dir: string): string | null {
  try {
    if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('目标不是普通目录')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const hash = createHash('sha256')
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`目标包含链接：${entry.name}`)
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        hash.update(`D\u0000${rel}\u0000`)
        walk(join(current, entry.name), rel)
        continue
      }
      if (!entry.isFile()) continue
      hash.update(`F\u0000${rel}\u0000`)
      hash.update(readFileSync(join(current, entry.name)))
    }
  }
  // 读取失败不可冒充“目标不存在”，提交方必须 fail closed。
  walk(dir, '')
  return hash.digest('hex')
}
