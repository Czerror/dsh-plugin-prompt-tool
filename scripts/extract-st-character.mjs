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
import { decodePngCharacterCard } from '../src/host/character-png.ts'

const args = process.argv.slice(2)
const input = args[0]
const output = args[1]

if (!input) {
  console.error('用法: node scripts/extract-st-character.mjs <card.png> [out.json]')
  process.exit(1)
}

try {
  const buf = readFileSync(input)
  const card = JSON.parse(decodePngCharacterCard(buf).jsonText)
  const out = output ?? (/\.png$/i.test(input) ? input.replace(/\.png$/i, '.json') : `${input}.json`)
  writeFileSync(out, JSON.stringify(card, null, 2))
  console.log(`已写入 ${out}`)
  console.log(`角色: ${card.data?.name ?? card.name ?? '(无名称)'} | spec: ${card.spec ?? 'v1'} | 在工作台「预设配置」页导入该 JSON 走完整转换链路`)
} catch (error) {
  console.error(`提取失败: ${error.message}`)
  process.exit(1)
}
