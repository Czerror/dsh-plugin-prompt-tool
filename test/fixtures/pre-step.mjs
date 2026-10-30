/** pre-step 测试夹具：单来源 apply 与固定 promotion 对；只给测试用。 */
import { createPreStepSource } from '../../engine/pre-step-source.mjs'

// apply 与 sourceId 前缀是公开引擎函数，但 src/ 不消费其类型；测试夹具用 any 命名空间拿，
// 避免把仅测试使用的符号塞进 engine/*.d.mts。
const executorModule = /** @type {any} */ (await import('../../engine/executor.mjs'))
const sourceModule = /** @type {any} */ (await import('../../engine/pre-step-source.mjs'))
export const moduleSourceId = sourceModule.moduleSourceId
export const presetSourceId = sourceModule.presetSourceId
export const applyPromptConfigSources = executorModule.applyPromptConfigSources

export const PROMOTION = {
  main: { status: () => ({ promoted: true }) },
  withSubagents: { status: () => ({ promoted: true }) },
}

/**
 * @param {unknown} ctx
 * @param {ReadonlyArray<import('../../engine/pre-step-source.mjs').PreStepConfigLike>} configs
 * @param {{ sourceId?: string; onOutcome?: import('../../engine/pre-step-source.mjs').PreStepOutcomeSink; promotion?: import('../../engine/pre-step-source.mjs').PreStepPromotion; agent?: unknown; prepend?: boolean; layers?: boolean }} [options]
 */
export function mountPreStepConfigs(ctx, configs, options = {}) {
  const source = createPreStepSource({
    sourceId: options.sourceId ?? presetSourceId(configs[0]?.id ?? 'unknown'),
    ctx,
    configs,
    onOutcome: options.onOutcome,
    promotion: options.promotion,
  })
  return executorModule.applyPromptConfigSources([source], {
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.prepend === undefined ? {} : { prepend: options.prepend }),
    ...(options.layers === undefined ? {} : { layers: options.layers }),
  })
}
