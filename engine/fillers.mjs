/**
 * fillers — 引擎内置的动态填充器(strategy=placeholder 的数据源)。
 * 全部遵循同一铁律:服务缺失或列表失败时返回 null(跳过该配置),绝不伤及会话。
 */

import { readFileSync } from 'node:fs'
import { getService, parseToolNames } from './shared.mjs'

const name = 'prompt-config-engine'

const PROJECT_CANDIDATES = ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md']
const USER_GLOBAL_CANDIDATE = 'AGENTS.md'

/** instruction-hint 提示文本:agents-instruction.txt 优先,否则动态探测。 */
function readAgentsInstructionText() {
  try {
    return readFileSync(new URL('./agents-instruction.txt', import.meta.url), 'utf8').trim()
  } catch {
    return ''
  }
}

/** Find the project root: first ancestor containing any root marker (e.g. .git). */
async function findProjectRoot(fs, cwd, signal) {
  let current = cwd
  for (;;) {
    for (const marker of ['.git', '.hg', '.svn']) {
      try {
        const target = await fs.resolve(joinPath(current, marker), { cwd, signal })
        const info = await fs.stat(target, signal)
        if (info !== undefined) return current
      } catch {
        // Probe failure = marker absent; continue.
      }
    }
    const parent = parentPath(current)
    if (parent === current || parent.length === 0) return cwd
    current = parent
  }
}

/** List instruction files present in one directory (project candidates). */
async function presentInDir(fs, dir, candidates, signal) {
  const found = []
  for (const candidate of candidates) {
    try {
      const target = await fs.resolve(joinPath(dir, candidate), { cwd: dir, signal })
      const info = await fs.stat(target, signal)
      if (info !== undefined && info.type === 'file') found.push(candidate)
    } catch {
      // Absent or unreadable — skip.
    }
  }
  return found
}

/** Join one path segment onto a directory (platform-agnostic string join). */
function joinPath(dir, segment) {
  if (dir.endsWith('/') || dir.endsWith('\\')) return dir + segment
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir + sep + segment
}

/** Parent of an absolute Windows or POSIX path. */
function parentPath(path) {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  const parent = path.slice(0, idx)
  return parent.length === 0 ? path : parent
}

/**
 * instruction-hint:晋升后一次性提示指令文件存在(agents-instruction.txt 优先)。
 * 可自定义参数:params.text 直接作为提示文本(覆盖文件与动态探测);
 * 其余字段语义与 env-facts / skill-catalog 一致(config.params 由单一配置源下发)。
 */
function createInstructionHintResolver(config) {
  const customText = typeof config?.params?.text === 'string' && config.params.text.trim().length > 0
    ? config.params.text.trim()
    : ''
  const agentsInstructionText = readAgentsInstructionText()
  return async ({ ctx, agent, session }) => {
    const id = `instruction-hint-${session.id}`
    if (customText.length > 0) {
      return {
        id,
        text: customText,
        source: { kind: 'instruction-hint', form: 'hint' },
      }
    }
    if (agentsInstructionText.length > 0) {
      return {
        id,
        text: agentsInstructionText,
        source: { kind: 'instruction-hint', form: 'hint' },
      }
    }
    const fs = ctx.get('fs')
    if (fs === undefined) return null
    const cwd = session.header?.cwd ?? process.cwd()
    const projectFiles = []
    const root = await findProjectRoot(fs, cwd, agent.signal)
    projectFiles.push(...await presentInDir(fs, root, PROJECT_CANDIDATES, agent.signal))
    const userGlobalFiles = []
    try {
      const dshHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : undefined)
      if (dshHome !== undefined) {
        userGlobalFiles.push(...await presentInDir(fs, dshHome, [USER_GLOBAL_CANDIDATE], agent.signal))
      }
    } catch {
      // Unreadable home probe — ignore.
    }
    const sections = []
    if (projectFiles.length > 0) {
      sections.push(`Workspace instruction files exist: ${projectFiles.join(', ')} (project root: ${root}).`)
    }
    if (userGlobalFiles.length > 0) {
      sections.push(`A user-global instruction file exists: ${USER_GLOBAL_CANDIDATE}.`)
    }
    if (sections.length === 0) return null
    return {
      id,
      text: [
        ...sections,
        'Do NOT assume their content. When a task touches this workspace, read the relevant instruction files first and follow them.',
      ].join(' '),
      source: { kind: 'instruction-hint', form: 'hint' },
    }
  }
}

/**
 * env-facts:机器事实动态填充器。
 * params.envKeys 逗号分隔环境变量白名单,默认 DSH_HOME,DSH_WORKSPACE;
 * CWD 特殊映射到 session.header.cwd ?? process.cwd()。
 * 返回 facts 变量表与默认文本;用户可用 text 模板 + {{变量}} 完全自定义输出。
 */
function createEnvFactsResolver(config) {
  const keys = parseToolNames(typeof config.params?.envKeys === 'string' && config.params.envKeys.length > 0
    ? config.params.envKeys
    : 'DSH_HOME,DSH_WORKSPACE')
  return ({ agent }) => {
    const session = agent?.session
    const cwd = session?.header?.cwd ?? process.cwd()
    const builtinHome = process.env.DSH_HOME ?? (process.env.USERPROFILE ? `${process.env.USERPROFILE}\\.dsh` : '')
    const facts = {}
    for (const key of keys) {
      let value
      if (key === 'CWD' || key === 'WORKSPACE') value = cwd
      else if (key === 'DSH_HOME') value = builtinHome
      else value = process.env[key]
      if (typeof value === 'string' && value.length > 0) facts[key] = value
    }
    facts.WORKSPACE = process.env.DSH_WORKSPACE ?? cwd
    facts.CWD = cwd
    const defaultText = ['Environment facts:', ...Object.entries(facts).map(([key, value]) => `- ${key}=${value}`)].join('\n')
    return { text: defaultText, variables: facts }
  }
}

/**
 * skill-catalog:技能目录动态填充器。
 * 数据来自宿主 skills 服务(聚合各 provider;本插件 provider 的 list 已按
 * skillSwitches 过滤,因此目录天然只含已启用技能)。服务缺失或列表失败时
 * 跳过本配置并告警一次,绝不伤及会话。
 */
function createSkillCatalogResolver(config) {
  const limit = Number.isSafeInteger(config.params?.limit) && config.params.limit >= 0
    ? config.params.limit
    : 20
  const fields = parseToolNames(typeof config.params?.fields === 'string' ? config.params.fields : 'name,description')
    .filter((field) => ['name', 'description', 'whenToUse'].includes(field))
  const providers = parseToolNames(config.params?.providers)
  const emptyBehavior = config.params?.emptyBehavior === 'text' ? 'text' : 'skip'
  const emptyText = typeof config.params?.emptyText === 'string' && config.params.emptyText.length > 0
    ? config.params.emptyText
    : '当前没有可用技能。'
  let warned = false
  const warnOnceLocal = (ctx, message) => {
    if (warned) return
    warned = true
    try {
      ctx?.logger?.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  return async ({ ctx, agent, session }) => {
    try {
      const skills = getService(ctx, 'skills')
      if (skills === undefined || typeof skills.list !== 'function') {
        warnOnceLocal(ctx, `${name}: skills service unavailable — skill-catalog config ${config.id} skipped`)
        return null
      }
      const all = await skills.list({
        scope: agent ?? ctx,
        ...(session?.header?.cwd !== undefined ? { cwd: session.header.cwd } : {}),
        ...(agent?.signal !== undefined ? { signal: agent.signal } : {}),
      })
      const visible = Array.isArray(all) ? all : []
      const scoped = providers.length === 0
        ? visible
        : visible.filter((skill) => providers.includes(skill?.provider))
      const total = scoped.length
      if (total === 0) {
        if (emptyBehavior !== 'text') return null
        return { text: emptyText, variables: { SKILL_COUNT: '0', SKILL_NAMES: '', SKILLS_TEXT: '' } }
      }

      const nameOf = (skill) => {
        const value = skill?.name
        if (typeof value === 'string' && value.length > 0) return value
        if (typeof skill?.locator === 'string' && skill.locator.length > 0) return skill.locator
        return String(skill?.id ?? '(unnamed)')
      }
      const firstLine = (value) => typeof value === 'string' ? value.split('\n')[0].trim() : ''
      const rows = (limit === 0 ? scoped : scoped.slice(0, limit)).map((skill) => {
        const parts = []
        if (fields.includes('name')) parts.push(nameOf(skill))
        if (fields.includes('description')) {
          const description = firstLine(skill?.description)
          if (description.length > 0) parts.push(description)
        }
        if (fields.includes('whenToUse')) {
          const whenToUse = firstLine(skill?.whenToUse)
          if (whenToUse.length > 0) parts.push(`适用：${whenToUse}`)
        }
        return parts.length === 0 ? '' : `- ${parts.join(': ')}`
      }).filter((line) => line.length > 0)
      const skillsText = rows.join('\n')
      const skillsNames = scoped.map((skill) => nameOf(skill)).join(', ')
      return {
        text: `Available skills (${total}):\n${skillsText}`,
        variables: {
          SKILL_COUNT: String(total),
          SKILL_NAMES: skillsNames,
          SKILLS_TEXT: skillsText,
        },
      }
    } catch (error) {
      warnOnceLocal(ctx, `${name}: skill-catalog config ${config.id} failed, skipping: ${String((error && error.message) || error)}`)
      return null
    }
  }
}

/** 动态填充器:strategy=placeholder 时按 fill 键在注入点填充内容。 */
export const FILLERS = {
  'instruction-hint': (config) => createInstructionHintResolver(config),
  'env-facts': (config) => createEnvFactsResolver(config),
  'skill-catalog': (config) => createSkillCatalogResolver(config),
}

export function createPlaceholderResolver(config) {
  const make = FILLERS[config.fill]
  if (make === undefined) {
    throw new TypeError(`${name}: unknown config fill ${JSON.stringify(config.fill)}`)
  }
  return make(config)
}

export { createInstructionHintResolver }
