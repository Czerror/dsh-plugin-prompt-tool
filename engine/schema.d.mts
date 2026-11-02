/** 模板解析由引擎统一实现，宿主只决定已授权的读取路径。 */
export function loadTemplate(file: unknown, baseUrl?: URL | string, presetRootUrl?: URL | string): unknown
