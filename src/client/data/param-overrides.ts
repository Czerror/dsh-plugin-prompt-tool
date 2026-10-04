/** preset.yml params 与客户端字段之间的纯转换；字段清单/类型/默认值来自共享契约。 */
import { ENGINE_PARAM_DEFINITIONS, engineParamList } from '../../shared/engine-params.ts'
import { SHARED_PARAM_KEYS, type Fields, type SharedParamKey } from './prompt-tool-fields.ts'
import { deepEqual } from './dirty-state.ts'

export function readParamOverridesPatch(source: Record<string, unknown>): Partial<Fields> {
  const patch: Record<string, unknown> = {}
  for (const key of SHARED_PARAM_KEYS) {
    const value = source[key]
    const definition = ENGINE_PARAM_DEFINITIONS[key]
    if (value === undefined || value === null) continue
    switch (definition.kind) {
      case 'boolean':
        if (typeof value === 'boolean') patch[key] = value
        break
      case 'number': {
        const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : undefined
        if (number !== undefined && definition.check(number) === undefined) {
          patch[key] = typeof definition.defaultValue === 'string' ? String(number) : number
        }
        break
      }
      case 'string':
        if (typeof value === 'string') patch[key] = value
        break
      // 正则串按原样回显：合法性交给保存层响亮拒绝，读回不因本地编译失败就吞掉用户值。
      case 'pattern':
        if (typeof value === 'string') patch[key] = value
        break
      case 'string-list':
        if (typeof value === 'string' || Array.isArray(value)) patch[key] = engineParamList(value).join(', ')
        break
      case 'max-depth':
        if (typeof value === 'string' || typeof value === 'number') patch[key] = String(value)
        break
    }
  }
  return patch as Partial<Fields>
}

export interface ParamOverrideBuildOptions {
  loadedKeys: ReadonlySet<string>
  /** 最近读回/保存的有效草稿；未编辑的行默认值不固化进 params。 */
  baseline?: Partial<Fields>
}

/** 将一次成功写入折叠到已存键集合，供后续请求正确发送删键值。 */
export function updateLoadedParamKeys(loadedKeys: Set<string>, overrides: Readonly<Record<string, unknown>>): void {
  for (const key of SHARED_PARAM_KEYS) {
    const value = overrides[key]
    if (value === '' || (Array.isArray(value) && value.length === 0)) loadedKeys.delete(key)
    else if (value !== undefined && value !== null) loadedKeys.add(key)
  }
}

function serializedParam(key: SharedParamKey, value: unknown): unknown {
  switch (ENGINE_PARAM_DEFINITIONS[key].kind) {
    case 'string-list': return engineParamList(value)
    case 'max-depth': return value === '' || value === 'provider-managed' ? value : Number(value)
    default: return value
  }
}

/** 只发送已存键或偏离默认的草稿；未操作字段不覆盖组合默认值。 */
export function buildParamOverrides(fields: Fields, options: ParamOverrideBuildOptions): Record<string, unknown> {
  const overrides: Record<string, unknown> = {}
  for (const key of SHARED_PARAM_KEYS) {
    const value = serializedParam(key, fields[key])
    const empty = serializedParam(key, options.baseline !== undefined && Object.hasOwn(options.baseline, key)
      ? options.baseline[key] : ENGINE_PARAM_DEFINITIONS[key].defaultValue)
    if (options.loadedKeys.has(key) || !deepEqual(value, empty)) overrides[key] = value ?? ''
  }
  return overrides
}

/** 保存队列中的过期草稿不得发往新模块；服务端另校验 expectedModuleId。 */
export const isCurrentModuleDraft = (draft: Pick<Fields, 'moduleId'>, current: Pick<Fields, 'moduleId'>): boolean =>
  draft.moduleId === current.moduleId
