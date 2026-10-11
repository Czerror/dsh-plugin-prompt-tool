/** 「有没有主语」的唯一判据：模块类编辑与模块草稿键都从这里派生（无主语＝插件等于未启用）。 */
import type { ModuleFacts } from '../../shared/engine-capabilities.ts'
import type { ModuleSummary } from '../../shared/bridge-contract.ts'
import type { ModuleVariableScope } from '../../shared/module-variables.ts'
import { isModuleId } from '../../shared/module-ids.ts'
import type { Fields } from './prompt-tool-fields.ts'

/** 判据输入：模块总闸在 Fields 里，模块事实来自 `/meta` 的逐模块 `facts`（不是 Fields 字段）。 */
type SubjectFields = Pick<Fields, 'modulesEnabled'> & { moduleFacts?: ModuleFacts }

/** 总闸打开且该模块声明可编辑，才存在可编辑的主语；`moduleFacts` 缺席即无主语。 */
export const canEditSubject = (fields: SubjectFields): boolean =>
  fields.modulesEnabled === true && fields.moduleFacts?.editable === true

/** 模块草稿键只随主语存在；无主语返回 undefined，避免 `undefined:scope` 把无主语与真模块串成一份草稿。 */
export const subjectDraftKey = (moduleId: string | undefined, scope: ModuleVariableScope): string | undefined =>
  moduleId === undefined ? undefined : `${moduleId}:${scope}`

/** 该模块的逐模块事实（`/meta` 的 `modules[].facts`）：能力门控与可编辑判据的唯一来源。 */
export const moduleFactsOf = (modules: readonly ModuleSummary[] | undefined, moduleId: string): ModuleFacts | undefined =>
  modules?.find((module) => module.id === moduleId)?.facts

/**
 * 「这一步发不发、这张卡出不出」的声明面准入：判据是 `/meta` 下发的 `declares`（`module.yml` 顶层键名）。
 * 多节＝**任一存在**即已声明（与 `DECLARED_SECTIONS` 同口径，如 `params` 或 `layerSettings`）。
 * 返回 `undefined`＝**未知**（模块不在快照里／声明面未下发）：不把「读不到」当「没声明」，调用方保守放行。
 */
export const moduleDeclares = (
  modules: readonly ModuleSummary[] | undefined,
  moduleId: string,
  ...sections: readonly string[]
): boolean | undefined => {
  const declares = modules?.find((module) => module.id === moduleId)?.declares
  return declares === undefined ? undefined : sections.some((section) => declares.includes(section))
}

/** 该模块此刻是否可编辑：总闸 + 该模块自己的事实——卡按归属问它，不用单主语镜像。 */
export const canEditModule = (
  fields: Pick<Fields, 'modulesEnabled'>,
  modules: readonly ModuleSummary[] | undefined,
  moduleId: string,
): boolean => canEditSubject({ modulesEnabled: fields.modulesEnabled, moduleFacts: moduleFactsOf(modules, moduleId) })

/**
 * 「新建内容能写进哪个模块」的唯一判据：**在装配集合内**（启用表）+ 该模块事实可编辑 + 可渲染。
 *
 * 为什么不能只看 `canEditModule`：`/meta` 对**未启用**的模块也下发 facts，只判可编辑会把停用模块
 * 当成可写目标——它的编辑器根本不在装配集合里，写进去只会静默丢失。候选列表与写入前的第二道闸
 * 共用这一个判据，两侧不会分叉。
 */
const isWritableTargetModule = (fields: Pick<Fields, 'modulesEnabled'>, module: ModuleSummary): boolean =>
  module.enabled === true && module.renderable !== false && module.broken === undefined
  && canEditSubject({ modulesEnabled: fields.modulesEnabled, moduleFacts: module.facts })

/** 目标选择的候选：只列**可写**模块（未启用／只读／损坏都不出现）。 */
export const writableModuleTargets = (
  fields: Pick<Fields, 'modulesEnabled'>,
  modules: readonly ModuleSummary[] | undefined,
): ModuleSummary[] => (modules ?? []).filter((module) => isWritableTargetModule(fields, module))

/** 写入前的第二道闸：目标此刻是否真的可写（候选过滤将来被改坏也不静默丢内容）。 */
export const isWritableTarget = (
  fields: Pick<Fields, 'modulesEnabled'>,
  modules: readonly ModuleSummary[] | undefined,
  moduleId: string,
): boolean => (modules ?? []).some((module) => module.id === moduleId && isWritableTargetModule(fields, module))

/**
 * 「新建空白模块」的复制源：包内 `modules/blank`（只声明身份，不预置任何节）。
 *
 * ponytail: 名字**不可由用户指定**——`/module-clone` 只吃模板 id，目录名由服务端定
 * （模板名已占用则追加 `-2`/`-3`…）。要自定义命名就得给 `/module-clone` 加显式 targetId，
 * 那是另一条任务；在那之前不要在客户端拼路径，也不要在界面上给一个不生效的输入框。
 */
export const BLANK_MODULE_TEMPLATE = 'blank'

/** 该模板是否合法模块 id（唯一进路径的值都从这里过一道，非法即拒绝发请求）。 */
export const blankModuleTargetValid = (): boolean => isModuleId(BLANK_MODULE_TEMPLATE)

/** 新建空白模块要用的两个既有端点的最小子集（调用方用 `bridgeCall` 适配即可）。 */
export type BlankModuleCall = (
  endpoint: 'moduleClone' | 'moduleEnable',
  body: { id: string; autoSuffix?: boolean; enabled?: boolean },
) => Promise<{ ok: boolean; value?: any }>

/**
 * 新建空白模块：**复用**既有 `/module-clone` 动作（复制内置空白模板）再用既有 `/module-enable`
 * 把它加入装配集合。名字不是用户输入：目标 id 由服务端返回并回传。不新增端点、不新增创建通道。
 */
export async function createBlankModule(call: BlankModuleCall): Promise<string | undefined> {
  if (!blankModuleTargetValid()) return undefined
  const cloned = await call('moduleClone', { id: BLANK_MODULE_TEMPLATE, autoSuffix: true })
  const created = cloned.ok ? cloned.value?.id : undefined
  if (created === undefined) return undefined
  const enabled = await call('moduleEnable', { id: created, enabled: true })
  return enabled.ok ? created : undefined
}
