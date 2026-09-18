import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { parseDocument, stringify, YAMLMap } from 'yaml'
// @ts-expect-error 引擎 ESM 是权威校验实现，由构建器同源打包。
import { createPromptConfigs } from '../../engine/schema.mjs'
import type { AssetFile, ImportChoices, ImportKind } from '../shared/asset-transfer.ts'
import { MAX_ASSET_BYTES, MAX_ASSET_FILES } from '../shared/asset-transfer.ts'
import type { StConversionReport } from '../shared/bridge-contract.ts'
import type { PresetSpec } from './manifest.ts'
import { assertPresetId } from './preset-install.ts'
import { assertSafeConfigId } from './prompt-configs.ts'
import { decodePngCharacterCard, isPngBuffer } from './character-png.ts'
import { convertStToPresetWithReport, mergeStConversionReports, mergeStPresetsWithReport, stOrderSelectionState, stPresetId } from './sillytavern.ts'
import type { StOrderGroupSummary } from './sillytavern.ts'

export const MAX_ASSET_FILE_BYTES = MAX_ASSET_BYTES
export const MAX_ASSET_TOTAL_BYTES = MAX_ASSET_BYTES
export { MAX_ASSET_FILES } from '../shared/asset-transfer.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function decodeAssetFile(file: AssetFile): Buffer {
  if (typeof file.content !== 'string') throw new Error(`${file.path}: 文件内容必须是字符串`)
  if (file.encoding === undefined && /\.(png|jpe?g|gif|webp|zip|ico|pdf|woff2?|bin)$/i.test(file.path)) throw new Error(`${file.path}: 二进制文件缺少编码标记，请刷新页面后重新选择文件`)
  if (file.encoding !== undefined && file.encoding !== 'utf8' && file.encoding !== 'base64') throw new Error(`${file.path}: 未知文件编码`)
  if (file.content.length > MAX_ASSET_FILE_BYTES * 4 / 3 + 4) throw new Error(`${file.path}: 文件大小超限`)
  if (file.encoding === 'base64' && (file.content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.content))) throw new Error(`${file.path}: 非法 base64`)
  const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
  if (bytes.length > MAX_ASSET_FILE_BYTES) throw new Error(`${file.path}: 文件大小超限`)
  return bytes
}

/** 校验传输路径和字节；外层目录由载体入口剥离一次，显式来源顺序保持不变。 */
export function normalizeAssetFiles(files: AssetFile[]): AssetFile[] {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_ASSET_FILES) throw new Error('导入文件数量为空或超限')
  const seen = new Set<string>()
  let total = 0
  const normalized = files.map(file => {
    if (!isRecord(file) || typeof file.path !== 'string') throw new Error('文件路径必须是字符串')
    const path = file.path
    const segments = path.split('/')
    if (path.length > 1024 || path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32) || segments.some(segment => segment === '' || segment === '.' || segment === '..' || /[<>:"|?*]/.test(segment)
      || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw new Error(`非法文件路径：${file.path}`)
    const key = path.normalize('NFC').toLowerCase()
    if (seen.has(key)) throw new Error(`文件路径重复或大小写冲突：${file.path}`)
    seen.add(key)
    const bytes = decodeAssetFile(file as unknown as AssetFile)
    total += bytes.length
    if (total > MAX_ASSET_TOTAL_BYTES) throw new Error('导入总大小超限')
    return { path, content: file.content as string, ...(file.encoding === undefined ? {} : { encoding: file.encoding as AssetFile['encoding'] }) }
  })
  for (const path of seen) {
    const segments = path.split('/')
    while (segments.length > 1) { segments.pop(); if (seen.has(segments.join('/'))) throw new Error(`文件与目录路径冲突：${path}`) }
  }
  return normalized
}

export function assetSourceDigest(files: AssetFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    const bytes = decodeAssetFile(file)
    hash.update(JSON.stringify([file.path, bytes.length])).update(bytes)
  }
  return hash.digest('hex')
}

/** 角色片段只接受自包含配置，验证时不得读取上传来源以外的磁盘文件。 */
export function validateCharacterSpec(spec: PresetSpec): void {
  for (const field of ['composition', 'customTools', 'content', 'model', 'subagentModel', 'subagentToolPolicy', 'moduleConfigs'] as const) {
    const value = spec[field]
    if (value !== undefined && !(Array.isArray(value) && value.length === 0) && !(isRecord(value) && Object.keys(value).length === 0)) {
      throw new Error(`角色片段不支持 ${field}；请从预设页导入完整预设`)
    }
  }
  if (spec.persona !== undefined && (spec.persona.prefix || spec.persona.suffix || spec.persona.complete === true)) throw new Error('角色片段的 persona 正文请改为内嵌 promptConfigs，或从预设页导入完整预设')
  const configs = spec.promptConfigs ?? []
  for (const config of configs) {
    if (!isRecord(config)) throw new Error('角色 promptConfigs 必须是对象数组')
    assertSafeConfigId(config.id as string)
    if (config.templateFile !== undefined) throw new Error(`角色配置 ${String(config.id)} 的 templateFile 外部文件不受支持`)
    if (isRecord(config.params) && config.params.file !== undefined) throw new Error(`角色配置 ${String(config.id)} 的 params.file 外部文件不受支持`)
    if (config.text !== undefined && typeof config.text !== 'string') throw new Error(`角色配置 ${String(config.id)} 的 text 必须是字符串`)
  }
  createPromptConfigs(configs)
}

export type PreparedImport = {
  state: 'ready'; kind: ImportKind; spec: PresetSpec; yaml: string; files: AssetFile[]
  sourceName: string; sourceDigest: string; report?: StConversionReport; avatar?: Buffer; sourceText?: string
} | { state: 'needs-order-selection'; candidates: StOrderGroupSummary[]; sourceName: string }
  | { state: 'needs-kind-selection'; kinds: ImportKind[]; sourceName: string }

function classify(raw: unknown, target: 'preset' | 'character'): ImportKind {
  if (!isRecord(raw)) throw new Error('内容必须是已知格式的对象，不能是 null 或数组')
  const native = ['modules', 'promptConfigs', 'params', 'engineCompat', 'composition', 'content'].some(key => key in raw)
    || (typeof raw.id === 'string' && typeof raw.name === 'string')
  const prompts = 'prompts' in raw
  const data = isRecord(raw.data) ? raw.data : raw
  const character = /^chara_card_v[23]$/.test(String(raw.spec)) || (isRecord(raw.data) && typeof data.name === 'string')
    || ['personality', 'first_mes', 'mes_example', 'character_book', 'alternate_greetings'].some(key => key in data)
    || (typeof data.name === 'string' && typeof data.description === 'string' && !native)
  const worldBook = 'entries' in raw
  if ([native, prompts, character, worldBook].filter(Boolean).length !== 1) throw new Error('无法识别内容，或包含互相矛盾的原生／SillyTavern 结构')
  if (/^chara_card_v[23]$/.test(String(raw.spec)) && !isRecord(raw.data)) throw new Error('chara_card_v2/v3 的 data 必须是对象')
  if (native) {
    for (const field of ['promptConfigs', 'modules', 'customTools']) if (raw[field] !== undefined && !Array.isArray(raw[field])) throw new Error(`${field} 必须是数组`)
    for (const field of ['params', 'meta', 'variables', 'moduleConfigs', 'content']) if (raw[field] !== undefined && !isRecord(raw[field])) throw new Error(`${field} 必须是对象`)
    if (raw.modules !== undefined && (raw.modules as unknown[]).some(value => typeof value !== 'string')) throw new Error('modules 必须是字符串数组')
    return target === 'character' ? 'native-character' : 'native-preset'
  }
  if (prompts) { if (!Array.isArray(raw.prompts) || raw.prompts.some(prompt => !isRecord(prompt))) throw new Error('prompts 必须是对象数组'); return 'st-preset' }
  if (worldBook) { if (!isRecord(raw.entries) && !Array.isArray(raw.entries)) throw new Error('entries 必须是对象或数组'); return 'world-book' }
  return 'st-character'
}

/** 字节集合 → 同一规范化候选；没有目标写入和静默的未知 JSON 回退。 */
export function prepareImport(input: AssetFile[], target: 'preset' | 'character', choices: ImportChoices = {}): PreparedImport {
  const files = normalizeAssetFiles(input)
  const sourceDigest = assetSourceDigest(files)
  const named = files.filter(file => /^(preset|converted)\.ya?ml$/i.test(file.path))
  if (named.length > 1) throw new Error(`存在多个定义候选：${named.map(file => file.path).join('、')}`)
  const topFiles = files.filter(file => !file.path.includes('/'))
  const structured = topFiles.filter(file => /\.(json|ya?ml)$/i.test(file.path))
  const native = named.length === 0 ? structured.filter(file => {
    try {
      const raw = decodeAssetFile(file).toString('utf8')
      const value: unknown = /\.json$/i.test(file.path) ? JSON.parse(raw) : parseDocument(raw).toJS({ maxAliasCount: 100 })
      return classify(value, target).startsWith('native-')
    } catch { return false }
  }) : []
  if (native.length > 1) throw new Error(`存在多个原生定义候选：${native.map(file => file.path).join('、')}`)
  const candidates = named.length === 1 ? named : native.length === 1 ? native : topFiles.filter(file => structured.includes(file)
    || (isPngBuffer(decodeAssetFile(file)) && !(structured.length === 1 && /^avatar\.png$/i.test(file.path))))
  if (candidates.length === 0) throw new Error(`${files[0]!.path}: 未发现可识别的预设或角色内容`)
  if (target === 'character' && candidates.length !== 1) throw new Error('角色库每次只能导入一张角色卡，请逐张预览')
  const parts: Array<{ spec: PresetSpec; report?: StConversionReport; kind: ImportKind; yaml: string; file: AssetFile; sourceText: string; avatar?: Buffer }> = []
  for (const file of candidates) {
    try {
      const bytes = decodeAssetFile(file)
      const png = isPngBuffer(bytes) ? decodePngCharacterCard(bytes) : undefined
      const sourceText = png?.jsonText ?? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (png !== undefined || /\.json$/i.test(file.path)) JSON.parse(sourceText)
      const doc = parseDocument(sourceText, { logLevel: 'silent' })
      if (doc.errors.length > 0 || !(doc.contents instanceof YAMLMap)) throw new Error(doc.errors[0]?.message ?? '内容必须是已知格式的对象')
      const raw: unknown = doc.toJS({ maxAliasCount: 100 })
      let kind = classify(raw, target)
      if (kind === 'native-preset' && isRecord(raw)) {
        const fragment = Array.isArray(raw.promptConfigs) && !['version', 'engineCompat', 'modules', 'composition', 'customTools', 'persona', 'content'].some(key => key in raw)
        let selfContained = false
        try { validateCharacterSpec(raw as unknown as PresetSpec); selfContained = true } catch { /* 完整预设仍可由候选物化校验其附件与模块。 */ }
        if (selfContained && fragment && !/^preset\.ya?ml$/i.test(file.path) && !/^converted\.ya?ml$/i.test(file.path) && choices.sourceKind === undefined) {
          return { state: 'needs-kind-selection', kinds: ['native-preset', 'native-character'], sourceName: file.path }
        }
        if (choices.sourceKind === 'native-character' || /^converted\.ya?ml$/i.test(file.path)) {
          validateCharacterSpec(raw as unknown as PresetSpec)
          kind = 'native-character'
        }
      }
      if (target === 'character' && kind !== 'st-character' && kind !== 'native-character') throw new Error('角色库只接受角色卡；预设和独立世界书请从预设页导入')
      if (choices.sourceKind !== undefined && choices.sourceKind !== kind) throw new Error(`所选类型 ${choices.sourceKind} 与实际 ${kind} 不一致`)
      const options = { characterId: choices.promptOrderCharacterId }
      if (kind === 'st-preset') {
        const state = stOrderSelectionState(raw, options)
        if (state.needsSelection) return { state: 'needs-order-selection', candidates: state.candidates, sourceName: file.path }
        if (state.error !== undefined) throw new Error(state.error)
      }
      let spec: PresetSpec
      let report: StConversionReport | undefined
      if (kind.startsWith('native-')) {
        spec = raw as PresetSpec
        if (spec.id === undefined) doc.set('id', stPresetId(posix.basename(file.path).replace(/\.[^.]+$/, '')))
        if (spec.name === undefined) doc.set('name', String(doc.get('id')))
        // 来源中的生成项证明不可信。分享出口必须经本机重新核验。
        if (doc.hasIn(['meta', 'characterMemories'])) doc.deleteIn(['meta', 'characterMemories'])
        spec = doc.toJS() as PresetSpec
      } else {
        const converted = convertStToPresetWithReport(raw, posix.basename(file.path).replace(/\.[^.]+$/, ''), options)
        spec = converted.spec
        report = converted.report
      }
      if (target === 'character') validateCharacterSpec(spec)
      parts.push({ spec, report, kind, yaml: kind.startsWith('native-') ? doc.toString() : stringify(spec, { lineWidth: 0 }), file, sourceText, ...(png === undefined ? {} : { avatar: png.avatar }) })
    } catch (error) { throw new Error(`${file.path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (parts.length > 1 && parts.some(part => part.kind.startsWith('native-'))) throw new Error(`多个定义候选不能自动合并：${candidates.map(file => file.path).join('、')}`)
  const first = parts[0]!
  let yaml = first.yaml
  let report = first.report
  if (parts.length > 1) {
    const merged = mergeStPresetsWithReport(parts.map(part => part.spec))
    yaml = stringify(merged.spec, { lineWidth: 0 })
    report = mergeStConversionReports(parts.map(part => part.report!), parts.map((part, index) => ({ sourceName: part.file.path, idMap: merged.idMap.get(index) })))
  }
  const doc = parseDocument(yaml)
  if (choices.targetId !== undefined) doc.set('id', choices.targetId)
  if (choices.targetName !== undefined) doc.set('name', choices.targetName)
  const spec = doc.toJS() as PresetSpec
  try { assertPresetId(spec.id) } catch (error) { throw new Error(`${first.file.path}: ${String(error)}`) }
  if (typeof spec.name !== 'string' || spec.name.trim().length === 0) throw new Error(`${first.file.path}: 名称必须为非空字符串`)
  yaml = doc.toString()
  const resources = files.filter(file => !candidates.includes(file))
  if (target === 'character' && resources.some(file => !/^avatar\.png$/i.test(file.path))) throw new Error('角色片段只支持内嵌内容和 avatar.png；其他附件请从预设页导入')
  const avatarFile = resources.find(file => /^avatar\.png$/i.test(file.path))
  const avatar = first.avatar ?? (avatarFile === undefined ? undefined : decodeAssetFile(avatarFile))
  if (avatar !== undefined && !isPngBuffer(avatar)) throw new Error('avatar.png 必须提供显式编码的 PNG 原始字节')
  const preparedFiles: AssetFile[] = [{ path: 'preset.yml', content: yaml, encoding: 'utf8' }, ...resources]
  if (first.avatar !== undefined && !resources.some(file => file.path.toLowerCase() === 'avatar.png')) preparedFiles.push({ path: 'avatar.png', content: first.avatar.toString('base64'), encoding: 'base64' })
  return { state: 'ready', kind: first.kind, spec, yaml, files: preparedFiles, sourceName: candidates.map(file => file.path).join('、'), sourceDigest,
    ...(report === undefined ? {} : { report }), ...(avatar === undefined ? {} : { avatar }), sourceText: first.sourceText }
}
