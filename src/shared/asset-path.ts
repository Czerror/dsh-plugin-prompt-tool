/** 压缩包/上传内的相对路径：三处入口共用最严规则，返回原路径。 */
export interface SafeRelativePathOptions {
  /** 路径最大长度；默认 1024（技能导入传 2048）。 */
  maxLength?: number
  /** 额外拒绝的首段（如技能管理目录）。 */
  reservedRoots?: readonly string[]
}

export function assertSafeRelativePath(path: string, options: SafeRelativePathOptions = {}): string {
  const maxLength = options.maxLength ?? 1024
  if (typeof path !== 'string' || path.length === 0 || path.length > maxLength
    || path.includes('\\') || path.startsWith('/') || /[\p{Cc}<>:"|?*]/u.test(path)) {
    throw new Error(`非法资源路径：${String(path)}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error(`非法资源路径：${path}`)
  }
  if (options.reservedRoots?.includes(parts[0]!)) throw new Error(`非法资源路径：${path}`)
  return path
}
