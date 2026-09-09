#!/usr/bin/env node
// migrate-presets.mjs — 离线一次性参数迁移（替代运行时自动兼容）。
//
// 处理对象：$DSH_HOME/.agent-presets/*/preset.yml（用户预设，含包内模板副本）。
// 迁移项：
//   1. 旧 worldBook 段（injectMode + entries）→ promptConfigs（world-book 策略）；
//   2. 旧扁平模型键（params.modelProvider 等）→ 顶层 model / subagentModel 段；
//   3. 旧内容参数别名（params.guideComplexPattern）删除（运行时兼容已移除）；
//   4. 旧参数覆盖文件 prompt-tool.overrides.yml → 并入 preset.yml params 后归档 .bak；
//   5. 旧 str-replace-editor 模块名 → 官方 bootstrap-filesystem 组合；
//   6. 旧 persona 卡（promptConfigs 内 persona-main / 子代理人设）→ 顶层 persona 段
//      （官方 @deepseek-ai/dsh-persona 行同构）/ delegation 行 config.persona。
// 安全：dry-run（--dry-run / -n）只报告不写盘；写盘前每份 preset.yml 备份 .bak；
// 解析失败 fail loud（非零退出），不动用户资产。
//
// 用法：node scripts/migrate-presets.mjs [--dry-run]
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, parse as parseYamlText } from 'yaml'

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n')
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
const PRESETS_DIR = join(DSH_HOME, '.agent-presets')

/**
 * 库行默认 persona suffix（官方 standard/ptc/cordis 共用同一句）。旧版插件把
 * prefix+suffix 合成单段人设卡，5fa3ae9 整段迁进 persona.prefix，suffix 段
 * （官方 order 10200）的位置被拉到最前；本脚本按它拆回官方两键。
 */
const LIBRARY_PERSONA_SUFFIX = (() => {
  try {
    const rows = parseYamlText(readFileSync(new URL('../engine/compositions/library/persona.yml', import.meta.url), 'utf8'), { logLevel: 'silent' })
    const suffix = Array.isArray(rows) ? rows[0]?.config?.suffix : undefined
    return typeof suffix === 'string' && suffix.trim().length > 0 ? suffix : undefined
  } catch {
    return undefined
  }
})()

/**
 * 拆分旧版合并 persona 文本：只在文本确实含库行默认 suffix 时拆（段落级，
 * 保留其余段落与空行结构），避免误改用户自定义人设。
 */
function splitMergedPersonaSuffix(prefix, suffix) {
  if (typeof prefix !== 'string' || typeof suffix !== 'string' || suffix.length === 0) return undefined
  if (!prefix.includes(suffix)) return undefined
  let found = false
  const kept = []
  for (const segment of prefix.split(/\n{2,}/)) {
    if (!segment.includes(suffix)) {
      kept.push(segment)
      continue
    }
    found = true
    const remainder = segment.replaceAll(suffix, '').replace(/\s{2,}/g, ' ').trim()
    if (remainder.length > 0) kept.push(remainder)
  }
  const rebuilt = kept.join('\n\n').trim()
  if (!found || rebuilt.length === 0) return undefined
  return { prefix: rebuilt, suffix }
}

/** 旧扁平模型键 → [顶层段, 段键]（与 src/host/manifest.ts MODEL_SEGMENT_MAP 同源）。 */
const MODEL_SEGMENT_MAP = {
  modelProvider: ['model', 'provider'],
  modelName: ['model', 'name'],
  modelReasoningEffort: ['model', 'reasoningEffort'],
  modelTemperature: ['model', 'temperature'],
  modelMaxTokens: ['model', 'maxTokens'],
  subagentModelProvider: ['subagentModel', 'provider'],
  subagentModelName: ['subagentModel', 'name'],
  subagentReasoningEffort: ['subagentModel', 'reasoningEffort'],
  subagentTemperature: ['subagentModel', 'temperature'],
  subagentMaxTokens: ['subagentModel', 'maxTokens'],
}

/** 世界书条目 → world-book 提示词配置（与 writePreset 迁移语义一致）。 */
function worldBookToConfigs(worldBook) {
  const fullMode = worldBook.injectMode === 'full'
  const out = []
  for (const entry of Array.isArray(worldBook.entries) ? worldBook.entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    const content = typeof entry.text === 'string' ? entry.text : ''
    if (content.trim().length === 0) continue
    const id = String(entry.id ?? '')
    if (id.length === 0) continue
    const keys = Array.isArray(entry.keys) ? entry.keys.map(String).filter((key) => key.trim().length > 0) : []
    const secondaryKeys = Array.isArray(entry.secondaryKeys)
      ? entry.secondaryKeys.map(String).filter((key) => key.trim().length > 0) : []
    const constant = entry.constant === true || fullMode || (keys.length === 0 && secondaryKeys.length === 0)
    const config = {
      id,
      name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
      enabled: entry.enabled !== false,
      strategy: 'world-book',
      order: typeof entry.order === 'number' ? entry.order : 100,
      text: content,
      layer: 'pre-step',
      position: 'before-all',
    }
    const params = { constant }
    if (keys.length > 0) params.keys = keys
    if (secondaryKeys.length > 0) params.secondaryKeys = secondaryKeys
    if (entry.caseSensitive === true) params.caseSensitive = true
    if (entry.wholeWords === true) params.wholeWords = true
    config.params = params
    out.push(config)
  }
  return out
}

/** 旧卡文本：`text` 单块便捷写法 + `texts` 多块（与 src/host/prompt-configs.ts 归一一致）。 */
function cardText(config) {
  return [
    ...(typeof config.text === 'string' ? [config.text] : []),
    ...(Array.isArray(config.texts) ? config.texts.filter((item) => typeof item === 'string') : []),
  ].join('\n\n')
}

/** 迁移单个预设目录；返回 { changed, summary }。 */
function migratePresetDir(presetDir) {
  const presetFile = join(presetDir, 'preset.yml')
  const summary = { worldBook: 0, flatModel: 0, oldParam: 0, moduleAlias: false, overrides: false, personaCard: 0, subagentPersona: 0, personaMerge: 0 }
  if (!existsSync(presetFile)) return { changed: false, summary }
  let doc
  try {
    doc = parseDocument(readFileSync(presetFile, 'utf8'), { logLevel: 'silent' })
  } catch (error) {
    throw new Error(`preset ${presetFile} YAML 解析失败: ${String(error?.message ?? error)}`)
  }
  let changed = false

  // 1) 旧 worldBook 段 → promptConfigs。
  const worldBook = doc.get('worldBook')
  if (worldBook !== null && typeof worldBook === 'object' && !Array.isArray(worldBook)) {
    // Document API 返回 YAML 节点：toJS(doc) 转普通对象再迁移（节点 toJS 需文档参数）。
    const configs = worldBookToConfigs(typeof worldBook.toJS === 'function' ? worldBook.toJS(doc) : worldBook)
    if (configs.length > 0) {
      const current = doc.toJS()
      const existingConfigs = Array.isArray(current?.promptConfigs) ? current.promptConfigs : []
      const ids = new Set(existingConfigs
        .filter((item) => item !== null && typeof item === 'object' && typeof item.id === 'string')
        .map((item) => item.id))
      doc.set('promptConfigs', [...existingConfigs, ...configs.filter((item) => {
        if (ids.has(item.id)) return false
        ids.add(item.id)
        return true
      })])
      summary.worldBook = configs.length
      changed = true
    }
    doc.delete('worldBook')
    if (summary.worldBook === 0) changed = true // 空 worldBook 段也删除
  }

  // 2) 旧扁平模型键 → 顶层段（逐键迁移并清理扁平键）。
  for (const [flatKey, [segment, segmentKey]] of Object.entries(MODEL_SEGMENT_MAP)) {
    if (!doc.hasIn(['params', flatKey])) continue
    const value = doc.getIn(['params', flatKey])
    doc.deleteIn(['params', flatKey])
    if (value === '' || (Array.isArray(value) && value.length === 0)) continue // 空值 = 删键
    doc.setIn([segment, segmentKey], value)
    summary.flatModel += 1
    changed = true
  }

  // 3) 旧内容参数别名删除（运行时兼容已移除）。
  if (doc.hasIn(['params', 'guideComplexPattern'])) {
    doc.deleteIn(['params', 'guideComplexPattern'])
    summary.oldParam += 1
    changed = true
  }

  // 4) 旧 Minimal 拆分模块迁移到官方 filesystem 组合；若两者同时存在，
  // 保留一个 canonical 模块，避免生成重复 Loader row。
  const modulesNode = doc.get('modules')
  const modules = modulesNode !== null && modulesNode !== undefined && typeof modulesNode.toJS === 'function'
    ? modulesNode.toJS(doc)
    : modulesNode
  if (Array.isArray(modules) && modules.includes('str-replace-editor')) {
    const canonical = [...new Set(modules.map((name) => name === 'str-replace-editor' ? 'bootstrap-filesystem' : name))]
    doc.set('modules', canonical)
    summary.moduleAlias = true
    changed = true
  }

  // 5) 旧参数覆盖文件并入 params（随后归档 .bak）。
  const overridesFile = join(presetDir, 'prompt-tool.overrides.yml')
  if (existsSync(overridesFile)) {
    const overrides = parseDocument(readFileSync(overridesFile, 'utf8'), { logLevel: 'silent' })
    for (const [key, value] of Object.entries(overrides.toJS() ?? {})) {
      if (doc.hasIn(['params', key])) continue // 已存在参数不覆盖（params 优先）
      doc.setIn(['params', key], value)
    }
    summary.overrides = true
    changed = true
  }

  // 6) 旧 persona 卡（promptConfigs 内的主/子代理人设）→ 顶层 persona 段 /
  //    tool-subagent 行 config.persona。运行时人设段由官方
  //    @deepseek-ai/dsh-persona 行注册，遗留卡会与官方行同名段冲突，
  //    所以这里是纯数据迁移：遍历全部人设卡（多张合并），全部删除。
  const currentConfigs = doc.toJS()?.promptConfigs
  if (Array.isArray(currentConfigs)) {
    const isPersonaSectionName = (name) => name === 'deployment:persona-prefix' || name === 'deployment:persona-suffix'
      || name === 'deployment:persona' || name === 'persona'
    const entries = currentConfigs
      .map((config, index) => ({ config, index }))
      .filter(({ config }) => config !== null && typeof config === 'object' && !Array.isArray(config))
    const isPersonaEntry = ({ config }) => isPersonaSectionName(config.params?.sectionName) || config.id === 'persona-main'
    const mainEntries = entries.filter((entry) => isPersonaEntry(entry) && entry.config.audience !== 'subagent')
    const subEntries = entries.filter((entry) => isPersonaEntry(entry) && entry.config.audience === 'subagent')
    const removals = []
    if (mainEntries.length > 0) {
      const prefixParts = []
      const suffixParts = []
      let complete = false
      let includeRuntimeContext
      for (const { config } of mainEntries) {
        const text = cardText(config)
        const params = config.params ?? {}
        // 段名是 persona-suffix 的卡归 suffix，其余（prefix/legacy/仅 id）归 prefix；
        // 空文本卡原本就不注册段（回落部署人设）：只删卡，不写空文本。
        if (text.trim().length > 0) {
          if (params.sectionName === 'deployment:persona-suffix') suffixParts.push(text)
          else prefixParts.push(text)
        }
        if (params.complete === true) complete = true
        if (params.suppressRuntimeContext === true) includeRuntimeContext = false
      }
      if (!doc.has('persona') && (prefixParts.length > 0 || suffixParts.length > 0)) {
        const suffixText = suffixParts.join('\n\n')
        doc.set('persona', {
          ...(suffixText.length > 0 ? { suffix: suffixText } : {}),
          prefix: prefixParts.join('\n\n'),
          ...(complete ? { complete: true } : {}),
          ...(includeRuntimeContext === false ? { includeRuntimeContext: false } : {}),
        })
        summary.personaCard += mainEntries.length
      }
      removals.push(...mainEntries.map(({ index }) => index))
      changed = true
    }
    if (subEntries.length > 0) {
      const texts = subEntries
        .map(({ config }) => cardText(config))
        .filter((text) => text.trim().length > 0)
      if (texts.length > 0) doc.setIn(['moduleConfigs', 'tool-subagent', 'persona'], texts.join('\n\n'))
      summary.subagentPersona += subEntries.length
      removals.push(...subEntries.map(({ index }) => index))
      changed = true
    }
    // worldBook 迁移后 promptConfigs 可能是普通数组；其余情况是 YAMLSeq。
    const configsNode = doc.get('promptConfigs')
    const items = Array.isArray(configsNode?.items) ? configsNode.items : undefined
    for (const index of removals.sort((a, b) => b - a)) {
      if (items !== undefined) doc.deleteIn(['promptConfigs', index])
      else if (Array.isArray(configsNode)) configsNode.splice(index, 1)
    }
  }

  // 7) persona 段旧合并文本拆回官方两键（suffix 在上、prefix 在下）：旧版
  //    prefix+suffix 合成单段卡，迁移后 suffix 位置错误，只在含库行默认 suffix
  //    时拆；保留段内其余键与顺序。
  const personaNode = doc.get('persona')
  if (LIBRARY_PERSONA_SUFFIX !== undefined && personaNode !== null && personaNode !== undefined
    && typeof personaNode === 'object' && !Array.isArray(personaNode)) {
    const persona = typeof personaNode.toJS === 'function' ? personaNode.toJS(doc) : personaNode
    if (persona !== null && typeof persona === 'object' && !Array.isArray(persona)
      && typeof persona.prefix === 'string' && !doc.hasIn(['persona', 'suffix'])) {
      const split = splitMergedPersonaSuffix(persona.prefix, LIBRARY_PERSONA_SUFFIX)
      if (split !== undefined) {
        const rest = { ...persona }
        delete rest.prefix
        delete rest.suffix
        doc.setIn(['persona'], { suffix: split.suffix, prefix: split.prefix, ...rest })
        summary.personaMerge = 1
        changed = true
      }
    }
  }

  if (!changed) return { changed: false, summary }

  // 写盘前备份 preset.yml（.bak-<时间戳>），失败非零并保留原文件。
  const backup = `${presetFile}.bak-${Date.now().toString(36)}`
  if (DRY_RUN) {
    console.log(`[dry-run] ${presetDir}: worldBook=${summary.worldBook} flatModel=${summary.flatModel} oldParam=${summary.oldParam} moduleAlias=${summary.moduleAlias} overrides=${summary.overrides} personaCard=${summary.personaCard} subagentPersona=${summary.subagentPersona} personaMerge=${summary.personaMerge}`)
    return { changed: true, summary }
  }
  const migratedText = doc.toString()
  writeFileSync(backup, readFileSync(presetFile, 'utf8'), 'utf8')
  // 先写同目录临时文件，再 rename；迁移过程中进程中断不会留下截断的 preset.yml。
  const temporary = `${presetFile}.tmp-${process.pid}-${Date.now().toString(36)}`
  try {
    writeFileSync(temporary, migratedText, 'utf8')
    renameSync(temporary, presetFile)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw new Error(`preset ${presetFile} 写盘失败：${String(error?.message ?? error)}`)
  }
  if (summary.overrides) renameSync(overridesFile, `${overridesFile}.bak-${Date.now().toString(36)}`)
  console.log(`migrated ${presetDir}: worldBook=${summary.worldBook} flatModel=${summary.flatModel} oldParam=${summary.oldParam} moduleAlias=${summary.moduleAlias} overrides=${summary.overrides} personaCard=${summary.personaCard} subagentPersona=${summary.subagentPersona} personaMerge=${summary.personaMerge} (backup ${backup})`)
  return { changed: true, summary }
}

let total = 0
let changed = 0
if (!existsSync(PRESETS_DIR)) {
  console.log(`no presets dir at ${PRESETS_DIR}`)
  process.exit(0)
}
for (const entry of readdirSync(PRESETS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const result = migratePresetDir(join(PRESETS_DIR, entry.name))
  total += 1
  if (result.changed) changed += 1
}
console.log(`migrate-presets: ${total} preset(s) scanned, ${changed} migrated (${DRY_RUN ? 'dry-run' : 'written'})`)
if (changed === 0) process.exit(0)
// 有任何迁移执行过但存在失败时（异常已在上面抛出非零），这里正常退出。
