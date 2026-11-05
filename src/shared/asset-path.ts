/** 压缩包/上传内的相对路径：三处入口共用最严规则，返回原路径。 */
export function assertSafeRelativePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024
    || path.includes('\\') || path.startsWith('/') || /[\p{Cc}<>:"|?*]/u.test(path)) {
    throw new Error(`非法资源路径：${String(path)}`)
  }
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error(`非法资源路径：${path}`)
  }
  return path
}
