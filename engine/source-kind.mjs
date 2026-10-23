/**
 * v4 消息来源的生产者身份：`plugin:<owner>`。
 * 前缀拼接、owner 解析与「是否插件来源」只在这里解释；旧日志的裸 `plugin` 只在
 * `isPluginKind` 兼容，不进入 `pluginOwner`。
 */
const PLUGIN_KIND_PREFIX = 'plugin:'

export const pluginKind = owner => `${PLUGIN_KIND_PREFIX}${owner}`

export const pluginOwner = kind => typeof kind === 'string' && kind.startsWith(PLUGIN_KIND_PREFIX)
  ? kind.slice(PLUGIN_KIND_PREFIX.length)
  : undefined

/** 本插件的 kind：v4 `plugin:<owner>`，或旧日志的裸 `plugin`（不是合法 v4 kind）。 */
export const isPluginKind = kind => kind === 'plugin'
  || (typeof kind === 'string' && kind.startsWith(PLUGIN_KIND_PREFIX))
