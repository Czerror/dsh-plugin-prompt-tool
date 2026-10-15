/** 外部 ST 语法只在导入时转换，赋值交给获准执行的原生模板事务。 */
import { splitTemplateArgument, transformTemplate } from '../../engine/template-evaluation.mjs'
// 动态宏拼写与引擎同源。
import { normalizeMacroSyntax } from '../../engine/interpolate.mjs'

export function prepareStText(text: string, cardName = '', replaceNames = true): string {
  const name = cardName.trim()
  return transformTemplate(text, (body, expand) => {
    if (/^\s*(?:\/\/|(?:trim|ERA)(?=$|[:\s]))/i.test(body)) return ''
    if (replaceNames && /^char$/i.test(body) && name) return name
    if (/^charifnotgroup$/i.test(body) && name) return replaceNames ? name : '{{char}}'
    if (replaceNames && /^user$/i.test(body)) return '用户'
    const [macro, args] = splitTemplateArgument(body)
    const operation = /^(set|add|get|inc|dec)(global)?var$/i.exec(macro.trim())
    if (operation && args !== undefined) return `{{${operation[2] ? 'global' : 'module'}.${operation[1]!.toLowerCase()}::${expand(args)}}}`
    return normalizeMacroSyntax(`{{${expand(body)}}}`) as string
  }).replace(/(?:\r?\n){3,}/g, '\n\n').trim()
}
