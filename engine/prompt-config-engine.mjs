/**
 * prompt-config-engine — prompt-tool 的唯一提示词注入执行器(装配入口)。
 *
 * 本文件只做装配:
 *   - schema.mjs    提示词配置加载/归一化/权威校验
 *   - strategies.mjs 内置策略绑定 + 模板专属策略懒加载(strategyDir)
 *   - fillers.mjs   placeholder 动态填充器（instruction-hint / env-facts / skill-catalog）
 *   - instruction-hint.mjs 通用指令文件提示实现（策略与 context-gate 共用）
 *   - layers.mjs    非 pre-step 五个官方层级接线
 *   - executor.mjs  pre-step 消息批执行器(过滤/去重/合并/落位)
 *
 * agent.cordis.yml 引擎行:
 *   - id: prompt-config-engine
 *     name: ./engine/prompt-config-engine.mjs
 *     config:
 *       configsDir: ../prompt-configs        # 提示词配置模块目录(相对本文件)
 *       strategyDir: ../strategies           # 模板专属策略目录(可选,相对本文件)
 *
 * 铁律:任一提示词配置失败只跳过该提示词配置并 warnOnce;配置错误挂载时 fail loud。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPromptConfigs, loadPromptConfigFiles, parsePromptConfigYaml } from './schema.mjs'
import { applyPromptConfigs } from './executor.mjs'
import { defineConfig, passthrough } from './fields.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-config-engine'

/**
 * 等待全部可注入层级的宿主服务。preset 行在 agent 组合内解析这些服务
 * (persona 依赖 systemPrompt,工具行依赖 tools,agent loop 依赖 llm)。
 */
export const inject = ['systemPrompt', 'tools', 'llm']

export { parsePromptConfigYaml, loadPromptConfigFiles, createPromptConfigs, applyPromptConfigs }

/** 物化清单里是否仍挂着官方指令加载行（负责人冲突事实）。 */
const OFFICIAL_INSTRUCTIONS_ROW = /dsh-agent-instructions|(^|\s)id:\s*agent-instructions\b/m

/**
 * 本 mount 的装配事实：来源 id（协调器注册键，取预设目录名）+ 是否仍挂着官方
 * 指令行。协调器据此拒绝在官方负责人仍在时同时注入插件指令文件正文。
 * 引擎直接以源码方式被引用（无物化组合文件）时按未知处理，不声明冲突。
 */
function compositionFacts(dirUrl) {
  try {
    const dir = new URL('..', dirUrl)
    return {
      sourceId: `preset:${basename(fileURLToPath(dir))}`,
      officialInstructions: OFFICIAL_INSTRUCTIONS_ROW.test(readFileSync(new URL('../agent.cordis.yml', dirUrl), 'utf8')),
    }
  } catch {
    return { sourceId: undefined, officialInstructions: false }
  }
}

/**
 * 引擎插件入口:config.configsDir 为提示词配置模块目录(相对本文件的 URL),
 * config.strategyDir 为模板专属策略目录(可选)。引擎扫描目录内每个
 * *.yml / *.yaml / *.json 并装配为提示词配置。
 */
/**
 * 配置契约：白名单由字段声明派生（此前没有白名单，未知键被静默忽略）。
 * 两个键都刻意用 passthrough 保住既有语义——迁移前它们对**非字符串或空串**是静默取默认值
 * （`typeof x === 'string' && x.length > 0 ? x : 默认`），换成 text() 会把静默降级变成挂载期
 * 报错，那是 B2 未授权的行为变更。归一化结果与迁移前逐字段一致，唯一新增的是「未知键报错」。
 */
export const configContract = defineConfig({
  configsDir: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : './prompt-configs')),
  strategyDir: passthrough((value) => (typeof value === 'string' && value.length > 0 ? value : undefined)),
})

export function apply(ctx, config) {
  const { configsDir: dirName, strategyDir: rawStrategyDir } = configContract.parse(config, name)
  const dirUrl = new URL(dirName.endsWith('/') ? dirName : `${dirName}/`, import.meta.url)
  // strategyDir 在入口统一解析成绝对 URL：bindResolver 用 `new URL(x.mjs, strategyDir)`
  // 懒加载，相对写法的 base 不是合法绝对 URL（ERR_INVALID_URL），会让整行挂载失败。
  const strategyDir = rawStrategyDir === undefined
    ? undefined
    : new URL(rawStrategyDir.endsWith('/') ? rawStrategyDir : `${rawStrategyDir}/`, import.meta.url).href
  const facts = compositionFacts(dirUrl)
  applyPromptConfigs(ctx, createPromptConfigs(loadPromptConfigFiles(dirUrl), { strategyDir }), {
    prepend: true,
    ...facts,
  })
}
