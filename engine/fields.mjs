/**
 * fields — 配置字段类型系统（B2 配置契约统一的底座）。
 *
 * 把「每个模块自己写白名单、自己写归一化、自己决定缺省语义」收敛为
 * 「一份字段声明 + 一个校验运行时」：
 *
 *   const { allowedKeys, parse } = defineConfig({
 *     enabled: bool({ default: false }),
 *     envKeys: stringList({ trim: true, dedupe: true, message: '...', emptyMessage: '...' }),
 *   })
 *   const config = parse(source, name)   // 未知键 / 类型错 / 缺必填一律 fail loud
 *
 * 硬约束（B2）：**逐字段的校验结果与错误消息必须与迁移前逐字一致**，
 * 唯一允许的行为变更是 `enabled` 的 fail loud（见 PLAN T3）。因此：
 *   - 缺省语义由每个字段**显式声明**，不再有隐式 `undefined` / `[]` / `new Set()` 的混用；
 *   - 底层复用 shared.mjs 的既有 helper（`booleanOption` / `requiredInt` / `requiredText` /
 *     `validateConfig`），不复制它们的逻辑，默认消息也就自动逐字相同；
 *   - 模块需要用别的措辞时，用 `message` / `emptyMessage` 覆盖（模板里的 `{plugin}`、
 *     `{field}` 会被替换）。
 *
 * 字段类型与它替代的历史 helper：
 *   bool(...)        ← booleanOption                        （缺省 → default）
 *   int({min,...})   ← requiredInt / optionalPositiveInt     （required 缺键即抛）
 *   text(...)        ← requiredText / requiredStageField     （requiredText 的空串 → undefined）
 *   stringList(...)  ← nameSet / allowKindList / sourceList / deferredList / stringList /
 *                      stringListOrEmpty / normalizeEnvKeys（返回数组或 Set、可选 dedupe/trim）
 *   enumOf(...)      ← 枚举白名单（如 promoteOn 一族）
 */

import { booleanOption, requiredInt, requiredText, validateConfig } from './shared.mjs'

/** 把 `{plugin}` / `{field}` 占位替换进消息模板。 */
const format = (template, plugin, field) =>
  String(template).replaceAll('{plugin}', plugin).replaceAll('{field}', field)

/**
 * 缺省值解析：`default` 既可以是值，也可以是**工厂函数**。
 * 工厂形态是必要的 —— 像 `new Set()` / `[]` 这种可变默认值若被多次 parse 共享，
 * 调用方一旦 mutate 就会串味到别的会话。
 */
const resolveDefault = (fallback) => (typeof fallback === 'function' ? fallback() : fallback)

/** 字段公共形状：每个字段都提供 parse(value, plugin, field)。 */
const makeField = (spec) => {
  if (spec === null || typeof spec !== 'object' || typeof spec.parse !== 'function') {
    throw new TypeError('fields: a field must be produced by bool()/int()/text()/stringList()/enumOf()')
  }
  return spec
}

/** 布尔开关：缺省返回 default；非布尔一律 fail loud。 */
export function bool({ default: fallback = false, message } = {}) {
  return makeField({
    kind: 'bool',
    default: fallback,
    parse: (value, plugin, field) => {
      if (message === undefined) return booleanOption(plugin, value, field, resolveDefault(fallback))
      if (value === undefined) return resolveDefault(fallback)
      if (typeof value !== 'boolean') throw new TypeError(format(message, plugin, field))
      return value
    },
  })
}

/**
 * 整数：`required: true` 时缺键即抛（消息与 shared.requiredInt 逐字一致）；
 * 否则缺键返回 default。`max` 只在声明了才检查。
 */
export function int({ min = 0, default: fallback, required = false, message } = {}) {
  if (!Number.isSafeInteger(min)) throw new TypeError('fields: int({min}) must be a safe integer')
  return makeField({
    kind: 'int',
    default: fallback,
    parse: (value, plugin, field) => {
      // 缺键的 required 错误交给 requiredInt 生成，消息逐字相同。
      if (value === undefined) {
        if (required) requiredInt(plugin, value, field, min)
        return resolveDefault(fallback)
      }
      // 不设 max：engine 里 11 处 requiredInt 调用全部只传最小值，上限语义零需求（YAGNI）。
      // message 只在需要偏离 requiredInt 默认措辞时使用。
      if (message !== undefined) {
        if (!Number.isSafeInteger(value) || value < min) throw new TypeError(format(message, plugin, field))
        return value
      }
      return requiredInt(plugin, value, field, min)
    },
  })
}

/**
 * 文本：
 *  - `required: true` 走 shared.requiredText —— 非字符串抛、**空串返回 undefined**
 *    （「空串 = 显式留空」是既有语义，调用方据此跳过注册）；
 *  - `allowEmpty: false` 时空串按错值处理（对应 tool-bootstrap 的 requiredStageField）；
 *  - 否则缺键返回 default。
 */
export function text({ required = false, default: fallback, allowEmpty = true, message } = {}) {
  return makeField({
    kind: 'text',
    default: fallback,
    parse: (value, plugin, field) => {
      // required 且未覆盖消息、且不需要"空串即错"时，**完全委托** requiredText：
      // 非字符串抛它自己的消息（含中文后缀）、空串返回 undefined —— 与迁移前逐字相同。
      if (required && message === undefined && allowEmpty) return requiredText(plugin, value, field)
      if (value === undefined) {
        if (required) requiredText(plugin, value, field)
        return resolveDefault(fallback)
      }
      if (typeof value !== 'string') {
        throw new TypeError(message === undefined
          ? `${plugin}: ${field} must be a string`
          : format(message, plugin, field))
      }
      if (!allowEmpty && value.length === 0) {
        throw new TypeError(message === undefined
          ? `${plugin}: ${field} must be a non-empty string`
          : format(message, plugin, field))
      }
      // requiredText 的空串契约：显式留空 → undefined，由调用方跳过注册。
      return required && value.length === 0 ? undefined : value
    },
  })
}

/**
 * 字符串列表：
 *  - `required: true` 时缺键即抛；否则缺键返回 default（可给工厂，如 `() => new Set()`）；
 *  - 形状错误（非数组 / 含非字符串 / 含空串）抛 `message`；
 *  - `trim: true` 先修剪再**丢弃**空项（normalizeEnvKeys 的语义），修剪后为空抛 `emptyMessage`；
 *  - 空数组在 `allowEmpty: false` 时抛 `emptyMessage ?? message`；
 *  - `as: 'set'` 返回 Set（nameSet / allowKindList / sourceList / deferredList 的形态）。
 */
export function stringList({
  required = false, default: fallback, dedupe = false, trim = false,
  allowEmpty = false, as = 'array', message, emptyMessage,
} = {}) {
  const shapeTemplate = message ?? '{plugin}: {field} must be an array of non-empty strings'
  const emptyTemplate = emptyMessage ?? shapeTemplate
  return makeField({
    kind: 'stringList',
    default: fallback,
    parse: (value, plugin, field) => {
      if (value === undefined) {
        if (required) throw new TypeError(format(shapeTemplate, plugin, field))
        return resolveDefault(fallback)
      }
      if (!Array.isArray(value)) throw new TypeError(format(shapeTemplate, plugin, field))
      // 空数组是**形状**问题，与「给出了但被 trim 丢光」是两回事：normalizeEnvKeys 对 [] 与
      // ['  '] 给的是两条不同消息，必须能分别表达。
      if (value.length === 0 && !allowEmpty) throw new TypeError(format(shapeTemplate, plugin, field))
      const items = []
      for (const item of value) {
        if (typeof item !== 'string') throw new TypeError(format(shapeTemplate, plugin, field))
        const trimmed = trim ? item.trim() : item
        if (trimmed.length === 0) {
          // trim 模式下空项是「被丢弃的噪声」；非 trim 模式下空串是形状错误。
          if (trim) continue
          throw new TypeError(format(shapeTemplate, plugin, field))
        }
        items.push(trimmed)
      }
      if (items.length === 0 && !allowEmpty) throw new TypeError(format(emptyTemplate, plugin, field))
      const list = dedupe ? [...new Set(items)] : items
      return as === 'set' ? new Set(list) : list
    },
  })
}

/**
 * 直通字段：**只登记白名单**，值的归一化交给模块自己的 parse —— 用于旧代码里刻意存在的
 * 「非法值即静默取默认」语义（如 `typeof x === 'string' && x.length > 0 ? x : 默认值`）。
 * 换用严格字段类型会把这些静默降级变成挂载期报错，而那是 B2 未授权的行为变更，
 * 所以这类键一律用 passthrough 保住原语义，并在模块里注明依据。
 */
export function passthrough(parse, { default: fallback } = {}) {
  if (typeof parse !== 'function') throw new TypeError('fields: passthrough(parse) requires a function')
  return makeField({ kind: 'passthrough', default: fallback, parse })
}

/** 枚举：值必须落在 `values` 里；`required: true` 时缺键即抛。 */
export function enumOf(values, { default: fallback, required = false, message } = {}) {
  const allowed = [...values]
  if (allowed.length === 0) throw new TypeError('fields: enumOf(values) must not be empty')
  const template = message ?? `{plugin}: {field} must be one of ${allowed.map((item) => JSON.stringify(item)).join(', ')}`
  return makeField({
    kind: 'enum',
    default: fallback,
    parse: (value, plugin, field) => {
      if (value === undefined) {
        if (required) throw new TypeError(format(template, plugin, field))
        return resolveDefault(fallback)
      }
      if (!allowed.includes(value)) throw new TypeError(format(template, plugin, field))
      return value
    },
  })
}

/**
 * 由字段声明派生 `{ allowedKeys, parse }`：
 *  - `allowedKeys` 取代手写 `ALLOWED_KEYS`（未知键的报错格式沿用 shared.validateConfig）；
 *  - `parse(source, plugin)` 先做信封校验再逐字段归一化，返回**只含声明键**的对象。
 */
export function defineConfig(fields) {
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new TypeError('fields: defineConfig(fields) requires an object of field declarations')
  }
  const entries = Object.entries(fields)
  for (const [key, spec] of entries) makeField(spec)
  const allowedKeys = new Set(entries.map(([key]) => key))
  const parse = (source, plugin) => {
    const config = validateConfig(plugin, source, allowedKeys)
    const normalized = {}
    for (const [key, spec] of entries) normalized[key] = spec.parse(config[key], plugin, key)
    return normalized
  }
  return { allowedKeys, parse, fields }
}
