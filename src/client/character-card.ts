/** SillyTavern 角色卡 PNG 解析（对齐官方 src/character-card-parser.js read()）：
 *  PNG tEXt chunk，关键字 ccv3（v3 优先）/ chara（v2 兜底），值为 base64 编码的
 *  角色卡 JSON。浏览器端解析字节流，不依赖第三方库。 */

export interface CharacterCardData {
  /** 角色卡 JSON 文本（chara_card_v2/v3，含 data 内层正文）。 */
  jsonText: string
  /** 角色名（顶层 name 或 data.name，缺省回退文件名）。 */
  name: string
  /** 原图 base64（dataURL 逗号后部分，落盘为 avatar.png）。 */
  imageBase64: string
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!
}

/** tEXt 文本为 Latin-1（PNG 规范）；关键字/值经此解码后 base64 解出 UTF-8 JSON。 */
function latin1(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return text
}

function decodeBase64(text: string): string {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return new TextDecoder('utf-8').decode(bytes)
}

/** 解析角色卡 PNG：返回角色卡 JSON + 原图 base64。非 PNG / 无角色卡 chunk 抛错。 */
export function parseCharacterCardPng(buffer: ArrayBuffer, fileName: string): CharacterCardData {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) {
    throw new Error('不是有效的 PNG 文件')
  }
  const chunks: Array<{ keyword: string; text: string }> = []
  let offset = 8
  while (offset + 12 <= bytes.length) {
    const length = readU32(bytes, offset)
    const type = latin1(bytes.subarray(offset + 4, offset + 8))
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (type === 'tEXt') {
      let separator = dataStart
      while (separator < dataEnd && bytes[separator] !== 0) separator += 1
      chunks.push({
        keyword: latin1(bytes.subarray(dataStart, separator)).toLowerCase(),
        text: latin1(bytes.subarray(separator + 1, dataEnd)),
      })
    }
    if (type === 'IEND') break
    offset = dataEnd + 4 // 跳过 CRC
  }
  const card = chunks.find((chunk) => chunk.keyword === 'ccv3') ?? chunks.find((chunk) => chunk.keyword === 'chara')
  if (card === undefined) {
    throw new Error('PNG 不含角色卡数据（无 chara/ccv3 tEXt chunk）')
  }
  const jsonText = decodeBase64(card.text)
  let name = ''
  try {
    const parsed = JSON.parse(jsonText) as { name?: unknown; data?: { name?: unknown } }
    if (typeof parsed.name === 'string' && parsed.name.trim().length > 0) name = parsed.name.trim()
    else if (parsed.data !== null && typeof parsed.data === 'object'
      && typeof parsed.data.name === 'string' && parsed.data.name.trim().length > 0) {
      name = parsed.data.name.trim()
    }
  } catch (error) {
    throw new Error(`角色卡 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`)
  }
  const base64 = (() => {
    let binary = ''
    const chunkSize = 0x8000
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
    }
    return btoa(binary)
  })()
  return { jsonText, name: name || fileName.replace(/\.png$/i, ''), imageBase64: base64 }
}
