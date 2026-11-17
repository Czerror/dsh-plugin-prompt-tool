import { execFile } from 'node:child_process'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { revisionOf } from './module-write.ts'
import { createTargetQueue } from '../shared/target-queue.ts'

function footprint(path: string) {
  if (!isAbsolute(path)) throw new Error('项目目录必须由用户明确指定绝对路径')
  const stamps = new Map<string, unknown>()
  const inspect = (target: string, directory: boolean) => {
    const absolute = resolve(target), root = parse(absolute).root
    let current = root
    for (const part of ['', ...relative(root, absolute).split(/[\\/]/).filter(Boolean)]) {
      if (part) current = join(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink() || (current !== absolute || directory) && !stat.isDirectory()) throw new Error('项目身份路径含链接或不是目录')
      stamps.set(current, [stat.dev, stat.ino, stat.birthtimeMs, stat.isDirectory() ? 'directory' : 'file'])
    }
    return lstatSync(absolute)
  }
  inspect(path, true)
  const canonical = realpathSync(path)
  stamps.clear()
  inspect(canonical, true)
  let ancestor = canonical, git: string | undefined
  for (;;) {
    const candidate = join(ancestor, '.git')
    try { lstatSync(candidate); git = candidate; break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      stamps.set(candidate, null)
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const pointer = (file: string) => {
    const stat = inspect(file, false)
    if (!stat.isFile() || stat.size > 8192) throw new Error('项目Git指针无效')
    const text = readFileSync(file, 'utf8')
    stamps.set(file, [stat.dev, stat.ino, stat.birthtimeMs, stat.ctimeMs, text])
    return text.trim()
  }
  let common: string | undefined
  if (git) {
    const stat = inspect(git, false)
    if (stat.isFile()) {
      const text = pointer(git)
      if (!text.startsWith('gitdir: ')) throw new Error('项目Git指针无效')
      git = resolve(dirname(git), text.slice(8))
    }
    inspect(git, true)
    common = git
    const file = join(git, 'commondir')
    try { lstatSync(file); common = resolve(git, pointer(file)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      stamps.set(file, null)
    }
    inspect(common, true)
    common = realpathSync(common)
  }
  const target = common ?? canonical, stat = lstatSync(target)
  return { path: canonical, common, identity: (common ? 'git:' : 'directory:') + revisionOf(JSON.stringify([target, stat.dev, stat.ino, stat.birthtimeMs])), stamp: JSON.stringify([...stamps]) }
}

/** 只缓存解析结果；每次同步读取重新核对目录、祖先和Git指针。 */
export function createProjectIdentities(invalidate: (path: string) => void) {
  const entries = new Map<string, { snapshot: ReturnType<typeof footprint>; ready: boolean }>()
  const lifetime = new AbortController()
  const queue = createTargetQueue()
  const reject = (path: string) => { if (entries.delete(path)) invalidate(path) }
  const read = (path: string) => {
    lifetime.signal.throwIfAborted()
    const entry = entries.get(path)
    if (!entry?.ready) throw new Error('项目身份尚未异步准备')
    try {
      if (footprint(path).stamp !== entry.snapshot.stamp) throw new Error('项目身份变化')
    } catch (error) { reject(path); throw error }
    return { path: entry.snapshot.path, identity: entry.snapshot.identity }
  }
  return {
    read,
    async prepare(path: string, signal?: AbortSignal) {
      return queue.run(path, async () => {
        lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
        if (entries.get(path)?.ready) {
          try { return read(path) } catch { /* 失效后仅由异步路径重新解析。 */ }
        }
        const snapshot = footprint(path), entry = { snapshot, ready: false }
        // 持久绑定保存canonical路径，首次准备也以相同键交付。
        path = snapshot.path
        entries.set(path, entry)
        try {
          if (snapshot.common) {
            const common = await new Promise<string>((accept, fail) => {
              execFile('git', ['-C', snapshot.path, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', timeout: 5000, windowsHide: true, signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal }, (error, stdout) => error ? fail(error) : accept(stdout.trim()))
            })
            if (realpathSync(common) !== snapshot.common) throw new Error('项目Git身份无法确认')
          }
          lifetime.signal.throwIfAborted(); signal?.throwIfAborted()
          if (entries.get(path) !== entry || footprint(path).stamp !== snapshot.stamp) throw new Error('项目身份变化，准备结果已失效')
          entry.ready = true
          return read(path)
        } catch (error) {
          if (entries.get(path) === entry) reject(path)
          throw error
        }
      })
    },
    dispose() { lifetime.abort(); entries.clear() },
  }
}
