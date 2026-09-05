#!/usr/bin/env node
// migrate-presets.mjs — 离线一次性参数迁移（替代运行时自动兼容）。
//
// 处理对象：$DSH_HOME/.agent-presets/*/preset.yml（用户预设，含包内模板副本）。
// 迁移项：
//   1. 旧 worldBook 段（injectMode + entries）→ promptConfigs（world-book 策略）；
//   2. 旧扁平模型键（params.modelProvider 等）→ 顶层 model / subagentModel 段；
//   3. 旧内容参数别名（params.guideComplexPattern）删除（运行时兼容已移除）；
//   4. 旧参数覆盖文件 prompt-tool.overrides.yml → 并入 preset.yml params 后归档 .bak；
//   5. 旧 str-replace-editor 模块名 → 官方 bootstrap-filesystem 组合。
// 安全：dry-run（--dry-run / -n）只报告不写盘；写盘前每份 preset.yml 备份 .bak；
// 解析失败 fail loud（非零退出），不动用户资产。
//
// 用法：node scripts/migrate-presets.mjs [--dry-run]
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'

const DRY_RUN = process.argv.includes('--dry-run') || process.argv.includes('-n')
const DSH_HOME = process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh')
const PRESETS_DIR = join(DSH_HOME, '.agent-presets')

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

/** 迁移单个预设目录；返回 { changed, summary }。 */
function migratePresetDir(presetDir) {
  const presetFile = join(presetDir, 'preset.yml')
  const summary = { worldBook: 0, flatModel: 0, oldParam: 0, moduleAlias: false, overrides: false }
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

  if (!changed) return { changed: false, summary }

  // 写盘前备份 preset.yml（.bak-<时间戳>），失败非零并保留原文件。
  const backup = `${presetFile}.bak-${Date.now().toString(36)}`
  if (DRY_RUN) {
    console.log(`[dry-run] ${presetDir}: worldBook=${summary.worldBook} flatModel=${summary.flatModel} oldParam=${summary.oldParam} moduleAlias=${summary.moduleAlias} overrides=${summary.overrides}`)
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
  console.log(`migrated ${presetDir}: worldBook=${summary.worldBook} flatModel=${summary.flatModel} oldParam=${summary.oldParam} moduleAlias=${summary.moduleAlias} overrides=${summary.overrides} (backup ${backup})`)
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
