#!/usr/bin/env node
/**
 * SillyTavern 角色卡 PNG → JSON 提取。
 *
 * 角色卡 PNG 的 JSON 藏在 tEXt chunk（键 chara）里：
 *   V1：chara = base64(明文 JSON)
 *   V2：chara = base64(zlib 压缩 JSON)
 *
 * 用法:
 *   node scripts/extract-st-character.mjs <card.png> [out.json]   # 提取角色卡 JSON
 *
 * 提取出的角色卡 JSON 直接在工作台「预设配置」页导入——单 JSON 导入自动走
 * convertStToPreset 完整转换链路（角色设定/系统提示/开场白/备用开场白/世界书/
 * setvar-getvar 变量/模块装配），无需脚本侧二次转换。
 * （旧 --preset 简化映射会丢失世界书/变量，已移除。）
 *
 * 前置: 无依赖（Node 内置 zlib / fs）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const input = args[0]
const output = args[1]

if (!input) {
  console.error('用法: node scripts/extract-st-character.mjs <card.png> [out.json]')
  process.exit(1)
}

/** 解析 PNG chunk，返回 tEXt 块键值对。 */
function readTextChunks(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('不是 PNG 文件（签名不符）')
  }
  const texts = []
  let off = 8
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'tEXt') {
      const nul = data.indexOf(0)
      if (nul > 0) texts.push([data.toString('latin1', 0, nul), data.toString('latin1', nul + 1)])
    }
    off += 12 + len
  }
  return texts
}

/** chara 值 → JSON：V2 先解 base64+zlib，失败回退 V1 base64 明文。 */
function parseChara(value) {
  try { return JSON.parse(inflateSync(Buffer.from(value, 'base64')).toString('utf8')) } catch {}
  try { return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) } catch {}
  return JSON.parse(value) // 极少数明文变体
}

try {
  const buf = readFileSync(input)
  const texts = readTextChunks(buf)
  // V3 卡写 ccv3 chunk，V1/V2 写 chara：与浏览器端 character-card.ts 一致，ccv3 优先。
  const entry = texts.find(([key]) => key === 'ccv3') ?? texts.find(([key]) => key === 'chara')
  if (!entry) throw new Error('PNG 中未找到 chara/ccv3 文本块（不是 SillyTavern 角色卡）')
  const card = parseChara(entry[1])
  const out = output ?? input.replace(/\.png$/i, '.json')
  writeFileSync(out, JSON.stringify(card, null, 2))
  console.log(`已写入 ${out}`)
  console.log(`角色: ${card.name ?? '(无名称)'} | spec: ${card.spec ?? 'v1'} | 在工作台「预设配置」页导入该 JSON 走完整转换链路`)
} catch (error) {
  console.error(`提取失败: ${error.message}`)
  process.exit(1)
}
