/** /prompt-tool 命令：读取规则定义，通过统一事务切换总开关与互斥组。 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { basename } from 'node:path'
import type { ModelDetection } from './models.ts'
import type { PromptSettings } from '../config.ts'
import type { SkillCatalogEntry } from '../shared/skills.ts'
import type { RuleDefinition } from '../shared/rules.ts'
import { readModuleRules, editModuleRules } from '../host/module-rules.ts'
import { loadModuleSpec, resolveModuleParams } from '../host/manifest.ts'
import { ENGINE_PARAM_DEFINITIONS, type EngineParamKey } from '../shared/engine-params.ts'
import { modulesEnabledOps } from '../shared/module-settings.ts'

/** dsh-tui 全局开关：键名与 settings 路径一致（settings mutate）。 */
const TUI_GLOBAL_SWITCHES: ReadonlyArray<readonly [key: string, label: string]> = [
  ['modulesEnabled', '模块运行总开关'],
]

/** dsh-tui 参数开关：写激活模块 module.yml（settings 不再承载引擎参数）。 */
const TUI_PARAM_SWITCHES = Object.entries(ENGINE_PARAM_DEFINITIONS)
  .filter(([, definition]) => definition.kind === 'boolean').map(([key]) => [key, key] as const)

/** 激活模块参数（status 显示与参数开关来源；settings 不再承载引擎参数）。 */
function readModuleParams(moduleDir: string | undefined): Record<string, unknown> {
  if (moduleDir === undefined || moduleDir.length === 0) return {}
  try {
    const spec = loadModuleSpec(moduleDir)
    return resolveModuleParams(spec, {})
  } catch {
    return {}
  }
}

type TuiSource = PromptSettings & { skillCatalog: SkillCatalogEntry[]; activeSkillsDirs: string[] }

function renderTuiStatus(source: TuiSource, params: Record<string, unknown>, rules: RuleDefinition[]): string {
  const onOff = (value: boolean): string => value ? '开' : '关'
  const paramBoolean = (key: string): boolean => (params[key] ?? ENGINE_PARAM_DEFINITIONS[key as EngineParamKey]?.defaultValue) === true
  const lines = [
    '提示词工具开关',
    ...TUI_GLOBAL_SWITCHES.map(([key, label]) => {
      const value = source[key as keyof PromptSettings]
      return `${key.padEnd(22)}${onOff(typeof value === 'boolean' ? value : false)}  ${label}`
    }),
    ...TUI_PARAM_SWITCHES.map(([key, label]) => {
      return `${key.padEnd(22)}${onOff(paramBoolean(key))}  ${label}（模块）`
    }),
    `  modelsAvailable         ${source.modelsAvailable ? '是' : '否（未检测到模型服务商）'}`,
    `  activeSkillsDirs        ${source.activeSkillsDirs.length > 0 ? source.activeSkillsDirs.join(' → ') : '（未解析到技能目录）'}`,
    '行为规则（条件 → 动作）:',
  ]
  for (const rule of rules) {
    lines.push(`${('config ' + rule.id).padEnd(22)}${onOff(rule.enabled !== false)}  ${rule.do.map(action => action.kind).join(' → ')}`)
  }
  lines.push('技能开关:')
  for (const skill of source.skillCatalog) {
    // 启停来自技能文件的调用策略：两端都被关掉才算停用。
    const value = skill.modelInvocable || skill.userInvocable
    const detail = skill.valid
      ? (skill.modelInvocable ? '模型可调用' : '模型不可调用')
      : `无效:${skill.issue ?? '不合法'}`
    lines.push(`${('skill ' + skill.name).padEnd(22)}${onOff(value)}  ${skill.folder}  [${detail}]`)
  }
  return lines.join('\n')
}

/** 详情呈现唯一声明，不把动作投影误当可独立启停的配置。 */
function renderConfigDetail(id: string, rules: RuleDefinition[]): string {
  const rule = rules.find(item => item.id === id)
  return rule === undefined ? `未找到规则 ${id}` : JSON.stringify(rule, null, 2)
}

/** 解析 on/off/toggle 三种输入。 */
function parseTuiBoolean(token: string | undefined, current: boolean): boolean | undefined {
  if (token === 'on') return true
  if (token === 'off') return false
  if (token === 'toggle') return !current
  return undefined
}

type CommandAction = 'on' | 'off' | 'toggle'

function asCommandAction(token: string): CommandAction | undefined {
  return token === 'on' || token === 'off' || token === 'toggle' ? token : undefined
}

/**
 * 解析可含空格的标识符与末尾动作。
 *
 * 斜杠命令没有 shell 引号语义，因此动作只认“最后一个独立 token”。config 的
 * 详情形态没有动作；只有去掉末尾动作后的候选 id 已存在时才把末尾 token 视为
 * 动作，避免把普通 id 误拆。
 */
function parseIdentifierAndAction(
  tokens: readonly string[],
  exists: (id: string) => boolean,
): { id: string; action?: CommandAction } {
  if (tokens.length === 0) return { id: '' }
  const last = tokens[tokens.length - 1]
  const action = asCommandAction(last ?? '')
  if (action !== undefined && tokens.length >= 2) {
    const id = tokens.slice(0, -1).join(' ')
    if (exists(id)) return { id, action }
  }
  return { id: tokens.join(' ') }
}

/** 参数保存回调：写激活模块 module.yml；失败必须抛给命令层渲染为错误。 */
export type SaveModuleParam = (key: string, value: unknown) => void | Promise<void>

/** 技能启停回调：切换受管实体的根链接。 */
export type ToggleSkillState = (folder: string, enabled: boolean) => { ok: boolean; message?: string }

/** 通过 DSH 命令注册表暴露 /prompt-tool，Web 与 dsh-tui 都能执行。 */
export function registerTuiCommand(
  ctx: Context,
  ns: 'prompt-tool',
  getSource: () => TuiSource,
  getModelsState: () => ModelDetection,
  getModelCatalog: () => Promise<Record<string, string[]>>,
  getModuleDirectory?: () => string,
  saveModuleParam?: SaveModuleParam,
  toggleSkillState?: ToggleSkillState,
  refreshModule?: (id: string) => Promise<void>,
): void {
  ctx.inject(['settings'], (sctx: Context) => {
    return sctx.commands.register({
      name: 'prompt-tool',
      description: '提示词工具：查看或切换本插件开关',
      input: { hint: 'status | on/off/toggle <开关> | skill <技能名> on/off/toggle | config <id> [on/off/toggle]' },
      handler: async (invocation): Promise<CommandResult> => {
        const usage = (): CommandResult => ({
          kind: 'error',
          text: '用法：/prompt-tool status\n' +
            `      /prompt-tool on|off|toggle <${[...TUI_GLOBAL_SWITCHES, ...TUI_PARAM_SWITCHES].map(([key]) => key).join('|')}>\n` +
            '      /prompt-tool skill <frontmatter 技能名> on|off|toggle\n' +
            '      /prompt-tool config <id>（id 可含空格）\n' +
            '      /prompt-tool config <id> on|off|toggle',
        })
        const persistModuleParam = async (key: string, value: unknown): Promise<CommandResult | undefined> => {
          if (saveModuleParam === undefined) {
            return { kind: 'error', text: `无法保存 ${key}：模块参数保存回调不可用` }
          }
          try {
            await saveModuleParam(key, value)
            return undefined
          } catch (error) {
            return { kind: 'error', text: `保存 ${key} 失败：${error instanceof Error ? error.message : String(error)}` }
          }
        }
        const tokens = invocation.rawInput.trim().split(/\s+/).filter((token) => token.length > 0)
        const source = getSource()
        const moduleDir = getModuleDirectory?.()
        const params = readModuleParams(moduleDir)
        let snapshot: ReturnType<typeof readModuleRules> | undefined
        try {
          if (moduleDir) snapshot = readModuleRules(moduleDir)
        } catch (error) {
          return { kind: 'error', text: `读取规则失败：${error instanceof Error ? error.message : String(error)}` }
        }
        const rules = snapshot?.rules ?? []
        if (tokens.length === 0 || tokens[0] === 'status') {
          const detection = getModelsState()
          const catalog = await getModelCatalog()
          const providersLine = detection.available
            ? `检测到的模型服务商: ${detection.providers.join(', ') || '（无）'}`
            : `未检测到模型服务商。providers=[${detection.providers.join(', ') || '空'}] error=${detection.error ?? '无'}`
          const catalogEntries = Object.entries(catalog)
          const modelsLine = catalogEntries.length > 0
            ? `检测到的模型名: ${catalogEntries.map(([provider, models]) => `${provider} → ${models.join(', ')}`).join('；')}`
            : '未检测到模型名（adapter 未公布或查询失败）'
          return { kind: 'success', text: renderTuiStatus(source, params, rules) + '\n' + providersLine + '\n' + modelsLine }
        }
        if (tokens[0] === 'skill') {
          const { id, action } = parseIdentifierAndAction(tokens.slice(1), () => true)
          if (id.length === 0) return usage()
          const matches = source.skillCatalog.filter((skill) => skill.name === id)
          if (matches.length !== 1) return { kind: 'error', text: matches.length === 0
            ? `未找到技能：${id}` : `存在多个同名技能：${id}，请在技能管理页选择具体文件` }
          const found = matches[0]!
          if (!found.valid) return { kind: 'error', text: `技能无效：${found.issue ?? id}` }
          const current = found.modelInvocable || found.userInvocable
          const next = parseTuiBoolean(action, current)
          if (next === undefined) return usage()
          if (toggleSkillState === undefined) {
            return { kind: 'error', text: `无法切换技能 ${id}：技能启停回调不可用` }
          }
          // 技能启停 = 改写技能文件的调用策略键（正文不动），不再写 settings。
          const toggled = toggleSkillState(id, next)
          if (toggled.ok === false) {
            return { kind: 'error', text: toggled.message ?? `技能 ${id} 切换失败` }
          }
          return { kind: 'success', text: `已把技能 ${id} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource(), readModuleParams(moduleDir), rules)}` }
        }
        if (tokens[0] === 'config') {
          const { id, action } = parseIdentifierAndAction(
            tokens.slice(1),
            (candidate) => rules.some(rule => rule.id === candidate),
          )
          if (id.length === 0) return usage()
          const current = rules.find(rule => rule.id === id)
          if (current === undefined) {
            return { kind: 'error', text: `未找到规则 ${id}；用 /prompt-tool status 查看全部 id。` }
          }
          if (action === undefined) return { kind: 'success', text: renderConfigDetail(id, rules) }
          const next = parseTuiBoolean(action, current.enabled !== false)
          if (next === undefined) return usage()
          if (!moduleDir || !snapshot || !refreshModule) return { kind: 'error', text: '规则保存通道不可用' }
          try {
            editModuleRules(moduleDir, {
              expectedRevision: snapshot.revision,
              ...(next ? { activateRuleId: id } : { edits: [{ previousId: id, rule: { ...current, enabled: false } }] }),
            })
          } catch (error) {
            return { kind: 'error', text: `保存规则失败：${error instanceof Error ? error.message : String(error)}` }
          }
          try { await refreshModule(basename(moduleDir)) } catch (error) {
            return { kind: 'error', text: `规则已保存，但重新装配失败：${error instanceof Error ? error.message : String(error)}` }
          }
          return { kind: 'success', text: `已把规则 ${id} 设为 ${next ? '开' : '关'}\n\n${renderConfigDetail(id, readModuleRules(moduleDir).rules)}` }
        }
        const action = tokens[0]
        const key = tokens[1]
        if (action !== 'on' && action !== 'off' && action !== 'toggle') return usage()
        if (key === undefined
          || (!TUI_GLOBAL_SWITCHES.some(([candidate]) => candidate === key)
            && !TUI_PARAM_SWITCHES.some(([candidate]) => candidate === key))) {
          return usage()
        }
        const globalSwitch = TUI_GLOBAL_SWITCHES.some(([candidate]) => candidate === key)
        const currentValue = globalSwitch ? source[key as keyof PromptSettings] : params[key] ?? ENGINE_PARAM_DEFINITIONS[key as EngineParamKey]?.defaultValue
        if (typeof currentValue !== 'boolean') {
          return { kind: 'error', text: `${key} 不是布尔开关，不能这样切换` }
        }
        const next = parseTuiBoolean(action, currentValue)
        if (next === undefined) return usage()
        if (globalSwitch) {
          await sctx.settings.mutate(ns, modulesEnabledOps(next))
        } else {
          // 参数开关：写激活模块 module.yml（settings 不再承载引擎参数）。
          const failure = await persistModuleParam(key, next)
          if (failure !== undefined) return failure
        }
        return { kind: 'success', text: `已把 ${key} 设为 ${next ? '开' : '关'}

${renderTuiStatus(getSource(), readModuleParams(moduleDir), moduleDir ? readModuleRules(moduleDir).rules : [])}` }
      },
    })
  })
}

/** 已发布的旧类型名。 */
export type SavePresetParam = SaveModuleParam
