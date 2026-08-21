#!/usr/bin/env node
/**
 * SillyTavern 角色卡 PNG → JSON 提取 / 转预设参数 JSON。
 *
 * 角色卡 PNG 的 JSON 藏在 tEXt chunk（键 chara）里：
 *   V1：chara = base64(明文 JSON)
 *   V2：chara = base64(zlib 压缩 JSON)
 *
 * 用法:
 *   node scripts/extract-st-character.mjs <card.png> [out.json]   # 提取角色卡 JSON
 *   node scripts/extract-st-character.mjs --preset <card.png> [out.json]
 *                                 # 提取并转换为本插件可导入的预设参数 JSON
 *                                 # （角色卡字段 → prompts[] 结构，工作台「预设配置」页直接导入）
 *
 * 前置: 无依赖（Node 内置 zlib / fs）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const args = process.argv.slice(2)
const toPreset = args[0] === '--preset'
const input = toPreset ? args[1] : args[0]
const output = toPreset ? args[2] : args[1]

if (!input) {
  console.error('用法: node scripts/extract-st-character.mjs [--preset] <card.png> [out.json]')
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

/** 角色卡 JSON → 本插件预设卡 JSON（convertStToPreset 输入结构）。 */
function characterToPresetCard(card) {
  const prompts = []
  const push = (identifier, name, content, role, systemPrompt) => {
    if (typeof content !== 'string' || content.trim().length === 0) return
    prompts.push({
      identifier,
      name,
      content,
      role,
      ...(systemPrompt ? { system_prompt: true } : {}),
      injection_order: prompts.length + 1,
      enabled: true,
    })
  }
  // 字段 → 注入层映射（与项目六层语义对齐）：
  //   system_prompt        → system-section（system 静态段）
  //   description/personality/scenario → pre-step 角色设定（user）
  //   first_mes            → pre-step 开场白（assistant）
  //   post_history_instructions → pre-step 尾部指令（user）
  push('character-system', '角色系统提示', card.system_prompt, 'system', true)
  push('character-lore', '角色设定', [card.description, card.personality, card.scenario].filter(Boolean).join('\n\n'), 'user', false)
  push('character-greeting', '开场白', card.first_mes, 'assistant', false)
  push('character-post', '历史后指令', card.post_history_instructions, 'user', false)

  const preset = { name: card.name ?? '', prompts }
  // V2 角色卡采样参数在 extensions.sampling（与预设卡顶层字段对齐）。
  const sampling = card.extensions?.sampling ?? {}
  if (typeof sampling.temperature === 'number') preset.temperature = sampling.temperature
  if (typeof sampling.max_tokens === 'number' && sampling.max_tokens > 0) preset.openai_max_tokens = sampling.max_tokens
  return preset
}

try {
  const buf = readFileSync(input)
  const texts = readTextChunks(buf)
  const entry = texts.find(([key]) => key === 'chara')
  if (!entry) throw new Error('PNG 中未找到 chara 文本块（不是 SillyTavern 角色卡）')
  const card = parseChara(entry[1])
  const result = toPreset ? characterToPresetCard(card) : card
  const out = output ?? input.replace(/\.png$/i, toPreset ? '-preset.json' : '.json')
  writeFileSync(out, JSON.stringify(result, null, 2))
  console.log(`已写入 ${out}`)
  console.log(`角色: ${card.name ?? '(无名称)'} | spec: ${card.spec ?? 'v1'} | prompts: ${(result.prompts ?? []).length} 条`)
} catch (error) {
  console.error(`提取失败: ${error.message}`)
  process.exit(1)
}
