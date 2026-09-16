/**
 * prompt-tool preset 核心(兼容层):
 *   - 提示词配置的加载/合并/渲染再导出(旧调用方与测试消费)。
 * 新代码请使用 src/host/ 下的 manifest / write-preset / prompt-configs / templates。
 */

export type { PromptConfigFile, PromptConfigSpec } from './host/prompt-configs.ts'
export { loadPromptConfigFiles, mergePromptConfigs, renderPromptConfigYaml } from './host/prompt-configs.ts'
