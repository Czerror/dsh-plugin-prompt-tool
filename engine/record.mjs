/** 统一的对象形状判据；纯 ESM，无宿主 import，供引擎内多个纯模块共用。 */
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
