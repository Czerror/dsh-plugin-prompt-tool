import { inflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const MAX_PNG_CARD_BYTES = 16 * 1024 * 1024

export function isPngBuffer(buffer: Buffer): boolean {
  return buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

/** host、上传入口与 CLI 共用；完整 chunk 边界及解压上限在读取时检查。 */
export function decodePngCharacterCard(buffer: Buffer): { jsonText: string; avatar: Buffer } {
  if (!isPngBuffer(buffer)) throw new Error('不是有效的 PNG 文件')
  const chunks: Array<{ keyword: string; text: string }> = []
  let offset = PNG_SIGNATURE.length
  let ended = false
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error('PNG chunk 越界')
    const length = buffer.readUInt32BE(offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > buffer.length) throw new Error('PNG chunk 越界')
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'tEXt') {
      const separator = buffer.indexOf(0, dataStart)
      if (separator > dataStart && separator < dataEnd) chunks.push({
        keyword: buffer.toString('latin1', dataStart, separator).toLowerCase(),
        text: buffer.toString('latin1', separator + 1, dataEnd),
      })
    }
    if (type === 'IEND') { ended = true; break }
    offset = dataEnd + 4
  }
  if (!ended) throw new Error('PNG 缺少完整 IEND chunk')
  const card = chunks.find(chunk => chunk.keyword === 'ccv3') ?? chunks.find(chunk => chunk.keyword === 'chara')
  if (card === undefined) throw new Error('PNG 不含角色卡数据（无 chara/ccv3 tEXt chunk）')
  if (card.text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(card.text)) throw new Error('PNG 角色卡 base64 非法')
  const encoded = Buffer.from(card.text, 'base64')
  if (encoded.length > MAX_PNG_CARD_BYTES) throw new Error('PNG 角色卡数据超限')
  let decoded: Buffer
  try { decoded = inflateSync(encoded, { maxOutputLength: MAX_PNG_CARD_BYTES }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') throw new Error('PNG 角色卡解压超限')
    decoded = encoded
  }
  const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(decoded)
  JSON.parse(jsonText)
  return { jsonText, avatar: buffer }
}
