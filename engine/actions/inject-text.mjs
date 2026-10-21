import { applyPromptConfigSources } from '../executor.mjs'
import { createPreStepSource } from '../pre-step-source.mjs'
import { wireLayers } from '../layers.mjs'
import { createPromptConfigs } from '../schema.mjs'
import { actionExecutionPoint } from './registration.mjs'

export function prepareInjectText(action, plugin, promptConfigOptions) {
  const source = action.config
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError(`${plugin}: inject-text requires a config object (与 promptConfigs 同形状的提示词配置)`)
  }
  if (typeof source.layer !== 'string' || source.layer.length === 0) {
    throw new TypeError(`${plugin}: inject-text config.layer is required (九层之一)`)
  }
  // 层→注册点的判据只有 `actionExecutionPoint` 一处：没有通道的层必须在这里**显式拒绝**，
  // 否则公开 API 的 inject-text 会静默变成「配了没效果」（原先它落到已删的 tool-pipeline 分派）。
  actionExecutionPoint(action)
  // 纯声明复用提示词配置编译；函数仅来自已有编程接口，不写回可序列化声明。
  const config = typeof source.resolve === 'function' ? source : createPromptConfigs([source], promptConfigOptions)[0]
  return (ctx, { warnOnce, collect, agent }) => {
    if (config.layer === 'pre-step') {
      const options = action.options ?? {}
      const sourceId = typeof options.sourceId === 'string' && options.sourceId.length > 0
        ? options.sourceId
        : `preset:${config.id}`
      const source = createPreStepSource({
        sourceId,
        ctx,
        configs: [config],
        onOutcome: options.onOutcome,
        promotion: options.promotion,
      })
      collect(applyPromptConfigSources([source], {
        agent,
        ...(options.prepend === undefined ? {} : { prepend: options.prepend }),
        ...(options.layers === undefined ? {} : { layers: options.layers }),
      }))
      return
    }
    collect(wireLayers(ctx, [config], warnOnce, { agent }))
  }
}
