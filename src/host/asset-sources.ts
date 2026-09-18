/** 原始上传只进入当前 bridge 生命周期拥有的暂存目录。 */
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { AssetFile } from '../shared/asset-transfer.ts'
import { MAX_ASSET_BYTES, safeAssetPath } from './asset-archive.ts'

const TTL = 15 * 60_000
const OWNER = 'prompt-tool-upload/1'
export function createAssetSources(root: string): {
  upload: (name: string, input: Readable) => Promise<{ sourceId: string; name: string; bytes: number }>
  read: (id: string) => AssetFile[]
  release: (id: string) => boolean
  dispose: () => void
} {
  const entries = new Map<string, { dir: string; name: string; expires: number; ready: boolean }>()
  let disposed = false
  // 只回收带本插件标记且过期的来源；未知目录和链接不碰。
  if (existsSync(root)) for (const child of readdirSync(root, { withFileTypes: true })) {
    if (!child.isDirectory() || child.isSymbolicLink() || !child.name.startsWith('source-')) continue
    try {
      const dir = join(root, child.name)
      const record = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as { owner?: unknown; expires?: unknown }
      if (record.owner === OWNER && typeof record.expires === 'number' && record.expires < Date.now()) rmSync(dir, { recursive: true, force: true })
    } catch { /* 占用或未知内容保留，不能影响 bridge 注册。 */ }
  }
  const release = (id: string): boolean => {
    const entry = entries.get(id)
    if (!entry) return false
    rmSync(entry.dir, { recursive: true, force: true })
    entries.delete(id)
    return true
  }
  const cleanup = (): void => {
    for (const [id, entry] of entries) if (entry.expires < Date.now()) {
      try { release(id) } catch { /* 等文件句柄释放后的下一次清理，不让定时器抛异常。 */ }
    }
  }
  const timer = setInterval(cleanup, 60_000)
  timer.unref()
  return {
    async upload(name, input) {
      cleanup()
      safeAssetPath(name)
      if (disposed || name.includes('/') || entries.size >= 4) throw new Error('上传暂存不可用或数量已达上限')
      mkdirSync(root, { recursive: true })
      const sourceId = randomUUID()
      const dir = mkdtempSync(join(root, 'source-'))
      const entry = { dir, name, expires: Date.now() + TTL, ready: false }
      entries.set(sourceId, entry)
      let bytes = 0
      try {
        writeFileSync(join(dir, 'owner.json'), JSON.stringify({ owner: OWNER, expires: entry.expires }), { flag: 'wx' })
        const limiter = new Transform({ transform(chunk, _encoding, callback) {
          bytes += chunk.length
          callback(bytes > MAX_ASSET_BYTES ? new Error('上传超过 64 MiB 上限') : null, chunk)
        } })
        await pipeline(input, limiter, createWriteStream(join(dir, 'bytes'), { flags: 'wx' }))
        if (disposed || !entries.has(sourceId)) throw new Error('上传已取消')
        entry.ready = true
        return { sourceId, name, bytes }
      } catch (error) { release(sourceId); throw error }
    },
    read(id) {
      cleanup()
      const entry = entries.get(id)
      if (!entry?.ready || entry.expires < Date.now() || disposed) throw new Error('上传来源不存在或已过期，请重新选择文件')
      return [{ path: entry.name, encoding: 'base64', content: readFileSync(join(entry.dir, 'bytes')).toString('base64') }]
    },
    release,
    dispose() {
      disposed = true
      clearInterval(timer)
      for (const id of entries.keys()) {
        try { release(id) } catch { /* 在途上传的 finally 或下次启动按标记回收。 */ }
      }
    },
  }
}
