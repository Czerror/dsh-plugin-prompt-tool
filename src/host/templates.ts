/**
 * 默认提示词配置模板库：包内 templates/ 目录的只读扫描与解析。
 *
 * 每个模板文件与生成目录的 prompt-configs/*.yml 同构（单对象、id 必填），
 * 供 Web 编辑器“插入模板”与用户手动复制使用；解析失败 fail loud——
 * 包内模板损坏属于发布 bug，静默跳过会掩盖问题。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { PromptConfigSpec } from './prompt-configs.ts'

export interface PromptConfigTemplate {
  /** 模板文件名（数字前缀决定展示顺序）。 */
  file: string
  /** 模板原文（编辑器源码模式可直接展示）。 */
  content: string
  /** 解析后的单条提示词配置。 */
  spec: PromptConfigSpec
}

/** 打包产物位于 lib/，与包根 templates/ 平级；../templates 相对路径在构建后成立。 */
const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url))

/** 扫描包内 templates/*.yml，按文件名排序返回（文件损坏时抛出，由调用方决定呈现）。 */
export function loadPromptTemplates(): PromptConfigTemplate[] {
  const entries = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const content = readFileSync(join(TEMPLATES_DIR, entry.name), 'utf8')
      const parsed = parseYaml(content, { logLevel: 'silent' })
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof (parsed as { id?: unknown }).id !== 'string'
        || (parsed as { id: string }).id.length === 0) {
        throw new Error(`prompt config template ${entry.name} must contain a single config object with a non-empty string id`)
      }
      return { file: entry.name, content, spec: parsed as PromptConfigSpec }
    })
}
