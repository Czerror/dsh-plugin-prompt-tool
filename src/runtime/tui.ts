/** /prompt-tool TUI 命令：查看或切换开关（UI 编辑器最后做，命令只读提示词配置数据入口）。 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { join } from 'node:path'
import type { DeepseekDetection } from './deepseek.ts'
import type { PromptSettings } from '../config.ts'
import type { PromptConfigSpec } from '../host/prompt-configs.ts'
import { loadPromptConfigFiles } from '../host/prompt-configs.ts'

/** dsh-tui 暴露的布尔开关：键名与 settings 路径一致。 */
const TUI_BOOLEAN_SWITCHES: ReadonlyArray<readonly [key: string, label: string]> = [
  ['writeAgents', '写入常驻规则 AGENTS.md'],
  ['writePreset', '启用锚定预设'],
  ['injectPrompt', '锚定确认后注入 preset.md'],
  ['injectAgentsPrompt', '用 AGENTS.md 替换 instruction-hint 提示'],
  ['firstTurnAnchor', '追加任务引导'],
  ['firstTurnCustom', '使用自定义引导（首句）'],
  ['guideCustom', '使用自定义引导（每轮）'],
  ['usePtcMode', '使用 PTC 模式'],
] as const

/** 把布尔开关渲染成 dsh-tui 命令输出。 */
/** 实际生效配置：生成目录优先（引擎加载源），settings 覆盖层作回退。 */
function resolvePromptConfigs(presetDir: string | undefined, fallback: PromptConfigSpec[]): PromptConfigSpec[] {
  if (presetDir === undefined || presetDir.length === 0) return fallback
  try {
    const actual = loadPromptConfigFiles(join(presetDir, 'prompt-configs'))
    return actual.length > 0 ? actual : fallback
  } catch {
    return fallback
  }
}

function renderTuiStatus(source: PromptSettings, promptConfigs: PromptConfigSpec[]): string {
  const onOff = (value: boolean): string => value ? '开' : '关'
  const lines = [
    '提示词工具开关',
    ...TUI_BOOLEAN_SWITCHES.map(([key, label]) => {
      const value = source[key as keyof PromptSettings]
      return `${key.padEnd(22)}${onOff(typeof value === 'boolean' ? value : false)}  ${label}`
    }),
    '锚点文本:',
    `  firstTurnText               ${source.firstTurnText.length > 0 ? source.firstTurnText : '（空 = 按任务自动选择）'}`,
    `  deepseekAvailable       ${source.deepseekAvailable ? '是' : '否（未检测到 DeepSeek 模型路由）'}`,
    `  modelProvider           ${source.modelProvider.length > 0 ? source.modelProvider : '（空 = 不设置）'}`,
    `  modelName               ${source.modelName.length > 0 ? source.modelName : '（空 = 不设置）'}`,
    `  bootstrapMaxTokens      ${source.bootstrapMaxTokens > 0 ? source.bootstrapMaxTokens : '0（关闭，不设封顶）'}`,
    `  activeSkillsDirs        ${source.activeSkillsDirs.length > 0 ? source.activeSkillsDirs.join(' → ') : '（未解析到技能目录）'}`,
    '提示词配置:',
  ]
  for (const config of promptConfigs) {
    lines.push(`${('config ' + config.id).padEnd(22)}${onOff(config.enabled !== false)}  layer=${config.layer ?? 'pre-step'} strategy=${config.strategy ?? 'static'}`)
  }
  lines.push('技能开关:')
  for (const skill of source.skillCatalog) {
    const value = source.skillSwitches[skill.folder] !== false
    const detail = skill.valid
      ? (skill.modelInvocable ? '模型可调用' : '模型不可调用')
      : `未注册:${skill.issue ?? '不合法'}`
    lines.push(`${('skill ' + skill.folder).padEnd(22)}${onOff(value)}  ${skill.name || skill.folder}  [${detail}]`)
  }
  return lines.join('\n')
}

/** 渲染单条提示词配置详情（params 以 JSON 摘要输出）。 */
function renderConfigDetail(source: PromptSettings, id: string, promptConfigs: PromptConfigSpec[]): string {
  const config = promptConfigs.find((item) => item.id === id)
  if (config === undefined) return `未找到提示词配置 ${id}`
  const lines = [`提示词配置 ${config.id}`, '']
  const fields: Array<[string, unknown]> = [
    ['name', config.name],
    ['enabled', config.enabled !== false],
    ['layer', config.layer],
    ['strategy', config.strategy],
    ['position', config.position],
    ['dedupe', config.dedupe],
    ['promotion', config.promotion],
    ['audience', config.audience ?? undefined],
    ['modelScope', config.modelScope],
    ['configKind', config.configKind],
    ['order', config.order],
    ['role', config.role],
    ['mergeMode', config.mergeMode],
    ['sourceKind', config.sourceKind],
    ['form', config.form],
    ['fill', config.fill],
    ['templateFile', config.templateFile],
    ['variables', config.variables],
    ['params', config.params],
  ]
  for (const [key, value] of fields) {
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue
    if (key === 'variables' || key === 'params') {
      lines.push(`${key.padEnd(14)}${JSON.stringify(value)}`)
      continue
    }
    lines.push(`${key.padEnd(14)}${String(value)}`)
  }
  if (typeof config.text === 'string' && config.text.length > 0) {
    lines.push('text:')
    lines.push(config.text)
  }
  if (Array.isArray(config.texts) && config.texts.length > 0) {
    lines.push('texts:')
    for (const item of config.texts) lines.push(`  - ${item}`)
  }
  return lines.join('\n')
}

/** 解析 on/off/toggle 三种输入。 */
function parseTuiBoolean(token: string | undefined, current: boolean): boolean | undefined {
  if (token === 'on') return true
  if (token === 'off') return false
  if (token === 'toggle') return !current
  return undefined
}

/** 通过 DSH 命令注册表暴露 /prompt-tool，Web 与 dsh-tui 都能执行。 */
export function registerTuiCommand(
  ctx: Context,
  ns: SettingsNamespace,
  getSource: () => PromptSettings,
  getDeepseekAvailable: () => boolean,
  getDeepseekState: () => DeepseekDetection,
  getPresetConfigsDir?: () => string,
): void {
  ctx.inject(['settings'], (sctx: Context) => {
    return sctx.commands.register({
      name: 'prompt-tool',
      description: '提示词工具：查看或切换本插件开关',
      input: { hint: 'status | on/off/toggle <开关> | skill <目录名> on/off | config <id> [on/off/toggle]' },
      handler: async (invocation): Promise<CommandResult> => {
        const usage = (): CommandResult => ({
          kind: 'error',
          text: '用法：/prompt-tool status\n' +
            '      /prompt-tool on|off|toggle <writeAgents|writePreset|injectPrompt|injectAgentsPrompt|firstTurnAnchor|firstTurnCustom|guideCustom|usePtcMode>\n' +
            '      /prompt-tool skill <技能目录名> on|off|toggle\n' +
            '      /prompt-tool config <id>\n' +
            '      /prompt-tool config <id> on|off|toggle\n' +
            '      /prompt-tool bootstrapMaxTokens <正整数|0（关闭）>',
        })
        const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
        const source = getSource()
        const promptConfigs = resolvePromptConfigs(getPresetConfigsDir?.(), source.promptConfigs)
        if (tokens.length === 0 || tokens[0] === 'status') {
          const detection = getDeepseekState()
          const deepseekLine = detection.available
            ? `检测到的 DeepSeek 模型路由: ${detection.providers.join(', ') || '（无）'}`
            : `未检测到 DeepSeek 模型路由。providers=[${detection.providers.join(', ') || '空'}] error=${detection.error ?? '无'}`
          const modelsLine = detection.models.length > 0
            ? `检测到的模型名: ${detection.models.join(', ')}`
            : '未检测到模型名（adapter 未公布或查询失败）'
          return { kind: 'success', text: renderTuiStatus(source, promptConfigs) + '\n' + deepseekLine + '\n' + modelsLine }
        }
        if (tokens[0] === 'skill') {
          const folder = tokens[1]
          if (folder === undefined) return usage()
          const current = source.skillSwitches[folder] !== false
          const next = parseTuiBoolean(tokens[2], current)
          if (next === undefined) return usage()
          await sctx.settings.mutate(ns, [{ op: 'set', path: ['skillSwitches', folder], value: next }])
          return { kind: 'success', text: `已把技能 ${folder} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource(), resolvePromptConfigs(getPresetConfigsDir?.(), getSource().promptConfigs))}` }
        }
        if (tokens[0] === 'config') {
          const id = tokens[1]
          if (id === undefined) return usage()
          const current = promptConfigs.find((config) => config.id === id)
          if (current === undefined) {
            return { kind: 'error', text: `未找到提示词配置 ${id}；用 /prompt-tool status 查看全部 id。` }
          }
          const action = tokens[2]
          if (action === undefined) return { kind: 'success', text: renderConfigDetail(source, id, promptConfigs) }
          const next = parseTuiBoolean(action, current.enabled !== false)
          if (next === undefined) return usage()
          const nextConfigs = promptConfigs.map((config) => config.id === id ? { ...config, enabled: next } : config)
          await sctx.settings.mutate(ns, [{ op: 'set', path: ['promptConfigs'], value: nextConfigs }])
          return { kind: 'success', text: `已把提示词配置 ${id} 设为 ${next ? '开' : '关'}

${renderConfigDetail(getSource(), id, resolvePromptConfigs(getPresetConfigsDir?.(), getSource().promptConfigs))}` }
        }
        if (tokens[0] === 'bootstrapMaxTokens') {
          const raw = tokens[1]
          const value = raw === undefined ? NaN : Number(raw)
          if (!Number.isSafeInteger(value) || value < 0) {
            return { kind: 'error', text: 'bootstrapMaxTokens 需要非负整数：0 关闭封顶，正整数设置首轮 maxTokens。' }
          }
          await sctx.settings.mutate(ns, [{ op: 'set', path: ['bootstrapMaxTokens'], value }])
          return { kind: 'success', text: `已把 bootstrapMaxTokens 设为 ${value === 0 ? '关闭（不设封顶）' : String(value)}

${renderTuiStatus(getSource(), resolvePromptConfigs(getPresetConfigsDir?.(), getSource().promptConfigs))}` }
        }
        const action = tokens[0]
        const key = tokens[1]
        if (action !== 'on' && action !== 'off' && action !== 'toggle') return usage()
        if (key === undefined || !TUI_BOOLEAN_SWITCHES.some(([candidate]) => candidate === key)) return usage()
        const currentValue = source[key as keyof PromptSettings]
        if (typeof currentValue !== 'boolean') {
          return { kind: 'error', text: `${key} 不是布尔开关，不能这样切换` }
        }
        const next = parseTuiBoolean(action, currentValue)
        if (next === undefined) return usage()
        await sctx.settings.mutate(ns, [{ op: 'set', path: [key], value: next }])
        return { kind: 'success', text: `已把 ${key} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource(), resolvePromptConfigs(getPresetConfigsDir?.(), getSource().promptConfigs))}` }
      },
    })
  })
}
