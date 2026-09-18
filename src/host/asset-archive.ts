/** ZIP 仅负责载体，不决定资产语义或写入目标。 */
import { ZipReader, ZipWriter, Uint8ArrayReader, Uint8ArrayWriter } from '@zip.js/zip.js'
import type { AssetFile } from '../shared/asset-transfer.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES } from '../shared/asset-transfer.ts'
export { MAX_ASSET_BYTES, MAX_ASSET_FILES } from '../shared/asset-transfer.ts'

export function safeAssetPath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 1024
    || path.includes('\\') || path.startsWith('/') || /[\p{Cc}<>:"|?*]/u.test(path)) throw new Error(`非法资源路径：${path}`)
  const parts = path.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`非法资源路径：${path}`)
  return path
}

export async function unpackZip(bytes: Uint8Array): Promise<AssetFile[]> {
  if (bytes.length > MAX_ASSET_BYTES) throw new Error('ZIP 超过 64 MiB 上限')
  const reader = new ZipReader(new Uint8ArrayReader(bytes), { useWebWorkers: false })
  const files: AssetFile[] = []
  const seen = new Set<string>()
  let total = 0
  let entries = 0
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (++entries > MAX_ASSET_FILES) throw new Error('ZIP 文件数超过上限')
      const path = safeAssetPath(entry.filename.replace(/\/$/, ''))
      const key = path.normalize('NFC').toLowerCase()
      if (seen.has(key)) throw new Error(`ZIP 路径重复：${path}`)
      seen.add(key)
      const fileType = (entry.externalFileAttributes >>> 16) & 0xf000
      if (entry.encrypted || entry.symlink || ![0, 0x8000, 0x4000].includes(fileType)) throw new Error(`ZIP 不允许加密项、链接或特殊文件：${path}`)
      if (entry.directory) continue
      if (entry.uncompressedSize > MAX_ASSET_BYTES || total + entry.uncompressedSize > MAX_ASSET_BYTES) throw new Error('ZIP 解压大小超过 64 MiB')
      const chunks: Buffer[] = []
      let size = 0
      await entry.getData(new WritableStream<Uint8Array>({
        write(chunk) {
          size += chunk.length
          total += chunk.length
          if (total > MAX_ASSET_BYTES) throw new Error('ZIP 实际解压大小超过 64 MiB')
          chunks.push(Buffer.from(chunk))
        },
      }), { checkSignature: true })
      if (size !== entry.uncompressedSize) throw new Error(`ZIP 长度不符：${path}`)
      files.push({ path, encoding: 'base64', content: Buffer.concat(chunks).toString('base64') })
    }
  } finally { await reader.close() }
  if (files.length === 0) throw new Error('ZIP 没有可导入文件')
  return files
}

export async function packZip(files: Array<{ path: string; bytes: Uint8Array }>): Promise<Uint8Array> {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { useWebWorkers: false })
  for (const file of files) await writer.add(safeAssetPath(file.path), new Uint8ArrayReader(file.bytes))
  return writer.close()
}
