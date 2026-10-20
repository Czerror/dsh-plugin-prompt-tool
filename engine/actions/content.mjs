/**
 * strategies — 引擎内容策略绑定(config.resolve)。
 * 内容策略: static / placeholder / context-activation。
 * 策略参数全部来自 config.params（由 preset.yml 单一配置源下发），引擎只负责组装。
 * 仍支持 strategyDir 懒加载自定义模板策略。
 */

import { createPlaceholderResolver } from '../fillers.mjs'

const name = 'prompt-config-engine'

/**
 * 为归一化后的提示词配置绑定策略 resolve(策略状态随提示词配置对象,不随 apply)。
 * strategyDir:外部策略模块目录(相对本文件 URL)。未声明时只允许内置策略。
 */
export function bindResolver(config, strategyDir) {
  switch (config.strategy) {
    case 'placeholder': return createPlaceholderResolver(config)
    case 'guide-auto':
    case 'custom-fallback':
    case 'first-turn-anchor':
    case 'anchor-notice':
      throw new TypeError(`${name}: retired strategy ${config.strategy}; use rule conditions and static content`)
    case 'context-activation':
      return ({ contextActivationSelected }) => contextActivationSelected === true ? { text: config.texts.join('\n\n') } : null
    case 'static': {
      const texts = config.texts
      const patch = config.templatePatch ?? {}
      return () => {
        if (texts.length > 0) return { ...patch, content: texts.map((item) => ({ type: 'text', text: item })) }
        return null
      }
    }
    default: {
      // 模板专属策略:懒加载 <strategyDir>/<strategy>.mjs,模块约定导出
      // `createResolver(config)` 或默认导出同名工厂。加载失败按单配置失败语义
      // 抛给调用方(executor 会跳过该配置并 warnOnce)。
      if (typeof strategyDir !== 'string' || strategyDir.length === 0) {
        throw new TypeError(`${name}: unknown config strategy ${JSON.stringify(config.strategy)}`)
      }
      const moduleUrl = new URL(`${config.strategy}.mjs`, strategyDir.endsWith('/') ? strategyDir : `${strategyDir}/`)
      let loaded
      return async (args) => {
        if (loaded === undefined) {
          loaded = await import(moduleUrl.href)
        }
        const make = typeof loaded.createResolver === 'function'
          ? loaded.createResolver
          : typeof loaded.default === 'function'
            ? loaded.default
            : undefined
        if (typeof make !== 'function') {
          throw new TypeError(`${name}: strategy module ${moduleUrl.href} must export createResolver(config)`)
        }
        // 每次求值重建工厂产物（不缓存 closure）：缓存会同时改变闭包状态跨调用、文件热刷新、
        // 跨会话串扰三项可观察行为——模块本身仍按上面缓存一次，只省 import。
        return make(config)(args)
      }
    }
  }
}
