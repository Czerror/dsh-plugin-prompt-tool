/** 独立装配入口只读取统一 rules 产物包；插件管理路径直接调用同一编译/装配接口。 */
import { readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from './vendor/yaml/index.js'
import { defineConfig, passthrough } from './fields.mjs'
import { compileRules, getRuleEditorMeta } from './rule-spec.mjs'
import { mountRuleSources } from './rule-runtime.mjs'
import { loadStandingMountFor } from './predicates.mjs'

export const name = 'rule-engine'
export const inject = ['systemPrompt', 'tools', 'llm']
export { compileRules, mountRuleSources, getRuleEditorMeta }
const fields = defineConfig({
  rulesFile: passthrough(value => typeof value === 'string' && value.length ? value : '../rules.yml'),
  moduleRoot: passthrough(value => typeof value === 'string' && value.length ? value : undefined),
  presetRoot: passthrough(value => typeof value === 'string' && value.length ? value : undefined),
  strategyDir: passthrough(value => typeof value === 'string' && value.length ? value : undefined),
})
export const configContract = { ...fields, parse(config, plugin = name) {
  const source = fields.parse(config, plugin)
  if (source.moduleRoot !== undefined && source.presetRoot !== undefined && source.moduleRoot !== source.presetRoot) throw new TypeError(`${plugin}: moduleRoot and presetRoot conflict`)
  source.moduleRoot ??= source.presetRoot
  delete source.presetRoot
  return source
} }

export async function apply(ctx, config) {
  const source = configContract.parse(config, name)
  const file = isAbsolute(source.rulesFile) ? source.rulesFile : fileURLToPath(new URL(source.rulesFile, import.meta.url))
  const packet = parse(readFileSync(file, 'utf8'), { logLevel: 'silent' })
  if (packet === null || typeof packet !== 'object' || Array.isArray(packet) || !Array.isArray(packet.rules)) throw new TypeError('rule-engine: rules.yml must contain a rules package')
  const templateBaseUrl = pathToFileURL(file)
  const templateModuleRoot = source.moduleRoot === undefined ? new URL('./', templateBaseUrl)
    : isAbsolute(source.moduleRoot) ? pathToFileURL(source.moduleRoot.replace(/[\\/]?$/, '/')) : new URL(source.moduleRoot.replace(/\/?$/, '/'), templateBaseUrl)
  const strategyDir = source.strategyDir === undefined ? undefined : isAbsolute(source.strategyDir) ? pathToFileURL(source.strategyDir).href : new URL(source.strategyDir, templateBaseUrl).href
  const moduleId = typeof packet.moduleId === 'string' ? packet.moduleId : basename(dirname(file))
  const rules = compileRules(packet.rules, { moduleId, variables: packet.variables, variablesEnabled: packet.variablesEnabled, configOrder: packet.configOrder, ctx, standingMountFor: await loadStandingMountFor(), promptConfigOptions: { templateBaseUrl, templateModuleRoot, strategyDir } })
  return mountRuleSources(ctx, [{ moduleId, rules }])
}
