/**
 * prompt-config-engine — prompt-tool 的唯一提示词注入执行器(装配入口)。
 *
 * 本文件只做装配:
 *   - schema.mjs    提示词配置加载/归一化/权威校验
 *   - strategies.mjs 内置策略绑定 + 模板专属策略懒加载(strategyDir)
 *   - fillers.mjs   placeholder 动态填充器(instruction-hint / env-facts / skill-catalog)
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

import { createPromptConfigs, loadPromptConfigFiles, parsePromptConfigYaml } from './schema.mjs'
import { applyPromptConfigs } from './executor.mjs'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-config-engine'

/**
 * 等待全部可注入层级的宿主服务。preset 行在 agent 组合内解析这些服务
 * (persona 依赖 systemPrompt,工具行依赖 tools,agent loop 依赖 llm)。
 */
export const inject = ['systemPrompt', 'tools', 'llm']

export { parsePromptConfigYaml, loadPromptConfigFiles, createPromptConfigs, applyPromptConfigs }

/**
 * 引擎插件入口:config.configsDir 为提示词配置模块目录(相对本文件的 URL),
 * config.strategyDir 为模板专属策略目录(可选)。引擎扫描目录内每个
 * *.yml / *.yaml / *.json 并装配为提示词配置。
 */
export function apply(ctx, config) {
  const dirName = typeof config?.configsDir === 'string' && config.configsDir.length > 0
    ? config.configsDir
    : './prompt-configs'
  const dirUrl = new URL(dirName.endsWith('/') ? dirName : `${dirName}/`, import.meta.url)
  const strategyDir = typeof config?.strategyDir === 'string' && config.strategyDir.length > 0
    ? config.strategyDir
    : undefined
  applyPromptConfigs(ctx, createPromptConfigs(loadPromptConfigFiles(dirUrl), { strategyDir }), { prepend: true })
}
