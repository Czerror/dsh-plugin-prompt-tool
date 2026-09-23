/** 触发器只归属 preset.yml；内容版本覆盖完整定义，写盘复用现有 YAML Document 通道。 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'
import { assertPresetDirectory } from './preset-install.ts'
import { withPresetDoc } from './manifest.ts'

/** 声明数据以实际 triggers.yml 为基准；允许根与注册层注入的 presetRoot 一致。 */
export function triggerPromptConfigOptions(directory: string, strategy?: unknown) {
  const templatePresetRoot = pathToFileURL(dirname(directory) + '/')
  const templateBaseUrl = pathToFileURL(join(directory, 'triggers.yml'))
  const strategyDir = typeof strategy !== 'string' || strategy.length === 0 ? undefined
    : isAbsolute(strategy) ? pathToFileURL(strategy).href : new URL(strategy, templateBaseUrl).href
  return { templatePresetRoot, templateBaseUrl, strategyDir }
}

export function readPresetTriggers(directory: string): { triggers: unknown[]; revision: string } {
  const dir = assertPresetDirectory(dirname(directory), basename(directory))
  const source = readFileSync(join(dir, 'preset.yml'), 'utf8')
  const doc = parseDocument(source, { logLevel: 'silent' })
  const triggers: unknown = doc.toJS().triggers ?? []
  if (!Array.isArray(triggers)) throw new TypeError('preset.yml 的 triggers 必须是数组')
  return { triggers, revision: createHash('sha256').update(source).digest('hex') }
}

/** 同步读改写之间不让出事件循环；版本不符不调用写盘，也不丢弃外部字段和注释。 */
export function savePresetTriggers(directory: string, triggers: unknown[], expectedRevision: string): boolean {
  if (readPresetTriggers(directory).revision !== expectedRevision) return false
  withPresetDoc(directory, doc => {
    if (triggers.length === 0) doc.delete('triggers')
    else doc.set('triggers', triggers)
  })
  return true
}
