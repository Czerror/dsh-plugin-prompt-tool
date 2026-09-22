/**
 * prompt-tool preset 核心(兼容层):
 *   - 提示词配置的加载/合并/渲染再导出(旧调用方与测试消费)。
 * 新代码请使用 src/host/ 下的 manifest / write-preset / prompt-configs / templates。
 */

export type { PromptConfigFile, PromptConfigSpec } from './host/prompt-configs.ts'
// `loadPromptConfigFiles` 是**本兼容层的旧名**，指向 host 侧的 `listPromptConfigSpecs`
// （它只做编辑/列举用的加载；引擎的 `engine/schema.mjs loadPromptConfigFiles` 是另一个契约，
// 会额外合并 `variables.yml`）。新代码请直接用 `src/host/prompt-configs.ts` 的新名。
export { listPromptConfigSpecs as loadPromptConfigFiles, mergePromptConfigs, renderPromptConfigYaml } from './host/prompt-configs.ts'
