// 组合源行默认 config：引擎不再内置可配置默认值（默认值归模板/预设），
// 测试按真实装配来源取值，避免在测试里维护第二份默认值。
// 组合源 →（rebuild:composition）→ library → 预设装配行，是同一份来源。
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const CACHE = new Map()

/** engine/compositions/source/local/<module>.yml 首个模块行的 config（浅拷贝 + overrides）。 */
export function compositionConfig(module, overrides = {}) {
  let config = CACHE.get(module)
  if (config === undefined) {
    const url = new URL(`../../engine/compositions/source/local/${module}.yml`, import.meta.url)
    const rows = parse(readFileSync(url, 'utf8'))
    const row = Array.isArray(rows) ? rows.find((item) => item?.id === module) : undefined
    if (row === undefined) throw new Error(`composition row ${module} not found`)
    config = row.config ?? {}
    CACHE.set(module, config)
  }
  return { ...config, ...overrides }
}
