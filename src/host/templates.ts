/**
 * 默认提示词配置模板库：包内 templates/ 目录的只读扫描与解析。
 *
 * 每个模板文件与模块的规则切片同构（单对象规则、id 必填，见 `rules/<规则id>.yml`），
 * 供 Web 编辑器“插入模板”与用户手动复制使用；解析失败 fail loud——
 * 包内模板损坏属于发布 bug，静默跳过会掩盖问题。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import type { RuleDefinition } from '../shared/rules.ts'
// @ts-expect-error 模板和运行时使用同一个规则校验目录。
import { compileRules } from '../../engine/rule-spec.mjs'

export interface PromptConfigTemplate {
  /** 模板文件名（数字前缀决定展示顺序）。 */
  file: string
  /** 模板原文（编辑器源码模式可直接展示）。 */
  content: string
  /** 解析后的单条提示词配置。 */
  spec: RuleDefinition
}

/** 自定义工具模板（templates/tools/*.yml；tool-config-engine 定义形态）。 */
export interface ToolTemplate {
  file: string
  content: string
  /** 解析后的工具定义（含 id/name/execute.kind）。 */
  spec: Record<string, unknown>
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
      compileRules([parsed])
      return { file: entry.name, content, spec: parsed as RuleDefinition }
    })
}

/** 工具模板库扫描（templates/tools/*.yml；损坏 fail loud——包内模板属于发布 bug）。 */
export function loadToolTemplates(): ToolTemplate[] {
  const dir = fileURLToPath(new URL('../templates/tools', import.meta.url))
  const entries = readdirSync(dir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const content = readFileSync(join(dir, entry.name), 'utf8')
      const parsed = parseYaml(content, { logLevel: 'silent' })
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || typeof (parsed as { id?: unknown }).id !== 'string'
        || (parsed as { id: string }).id.length === 0
        || typeof (parsed as { name?: unknown }).name !== 'string'
        || (parsed as { execute?: unknown }).execute === null
        || typeof (parsed as { execute?: unknown }).execute !== 'object') {
        throw new Error(`tool template ${entry.name} must contain id/name/execute`)
      }
      return { file: entry.name, content, spec: parsed as Record<string, unknown> }
    })
}
