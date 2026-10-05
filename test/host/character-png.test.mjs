/**
 * 角色卡 PNG 解码（`decodePngCharacterCard` / `isPngBuffer`）—— 工作台、上传入口与 CLI 共用的
 * 导入第一步。导入是本插件区别于官方工具的特有能力，这条 seam 此前零覆盖。
 *
 * 真值源是**本文件手工拼出的 PNG 字节**：chunk 结构、base64 文本与期望的 JSON 字面量都写死
 * 在这里，不经任何生产编码路径生成。ST 生态两种真实格式都在覆盖内：
 *   V2 = base64(zlib(JSON))（`chara`/`ccv3` 的现代形态）
 *   V1 = base64(JSON)（明文，解压失败时回落）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodePngCharacterCard, isPngBuffer } from '../../src/host/character-png.ts'

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
/** chunk 尾部的 CRC 一律写 0：解码只做长度与边界检查，不校验 CRC（故测试不需要真 CRC）。 */
const chunk = (type, data) => {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}
/** 1×1 真彩 PNG 的 IHDR 数据，让夹具保持真实 PNG 的块顺序。 */
const IHDR = chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]))
const text = (keyword, value) => chunk('tEXt', Buffer.concat([
  Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1'),
]))
const png = (...chunks) => Buffer.concat([SIGNATURE, IHDR, ...chunks, chunk('IEND', Buffer.alloc(0))])

const CARD = { spec: 'chara_card_v2', data: { name: 'Alice', description: 'hello' } }
const CARD_TEXT = JSON.stringify(CARD)

test('PNG 角色卡：V2（base64 + zlib）解出 JSON 文本，并原样带回图像字节', () => {
  const image = png(text('chara', deflateSync(Buffer.from(CARD_TEXT, 'utf8')).toString('base64')))
  const { jsonText, avatar } = decodePngCharacterCard(image)
  assert.equal(jsonText, CARD_TEXT)
  assert.deepEqual(JSON.parse(jsonText), CARD)
  assert.equal(avatar, image, '头像就是原图，解码不改写它')
})

test('PNG 角色卡：V1 明文格式同样可读，且两键并存时取 ccv3', () => {
  const legacy = png(text('chara', Buffer.from(CARD_TEXT, 'utf8').toString('base64')))
  assert.equal(decodePngCharacterCard(legacy).jsonText, CARD_TEXT, 'V1 明文 base64 是合法输入')

  const modernText = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Bob' } })
  const both = png(
    text('chara', Buffer.from(CARD_TEXT, 'utf8').toString('base64')),
    text('ccv3', deflateSync(Buffer.from(modernText, 'utf8')).toString('base64')),
  )
  assert.equal(decodePngCharacterCard(both).jsonText, modernText, 'chara 与 ccv3 并存时取 ccv3')
})

test('PNG 角色卡：坏输入在解码入口被拒绝，不返回半成品', () => {
  assert.equal(isPngBuffer(Buffer.from('not a png at all')), false, '签名不符即判非 PNG')
  assert.equal(isPngBuffer(png()), true, '带签名的输入判为 PNG（与后续结构校验分开）')

  const cases = [
    ['非 PNG 字节', Buffer.from('not a png at all'), /不是有效的 PNG 文件/],
    ['缺 IEND', Buffer.concat([SIGNATURE, IHDR]), /缺少完整 IEND chunk/],
    ['声明长度越界', Buffer.concat([SIGNATURE, Buffer.from([0, 0, 0, 99, 0x74, 0x45, 0x58, 0x74])]), /PNG chunk 越界/],
    ['无卡数据', png(text('Software', 'x')), /不含角色卡数据/],
    ['base64 非法', png(text('chara', 'not*base64')), /base64 非法/],
    ['JSON 非法', png(text('chara', Buffer.from('{oops', 'utf8').toString('base64'))), SyntaxError],
    ['UTF-8 非法', png(text('chara', Buffer.from([0xff, 0xfe]).toString('base64'))), TypeError],
  ]
  for (const [label, input, expected] of cases) {
    assert.throws(() => decodePngCharacterCard(input), expected, label)
  }
})
