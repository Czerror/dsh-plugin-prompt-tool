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
 * 声明面准入：判据是 `/meta` 下发的 `declares`（`module.yml` 顶层键名），只回答「这一步发不发读」
 * ——固定卡（指令卡参数组、人设卡）照常渲染、按空内容起步；通用资产卡未声明时改出添加入口。
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

/** 目标写入只看用户模块定义是否有效、可编辑，不看运行时装配开关。 */
const isWritableTargetModule = (module: ModuleSummary): boolean =>
  isModuleId(module.id) && module.user === true && module.renderable !== false && module.broken === undefined
  && module.facts?.editable === true

/** 目标选择候选：所有有效、可写的用户模块，包含未启用模块。 */
export const writableModuleTargets = (modules: readonly ModuleSummary[] | undefined): ModuleSummary[] =>
  (modules ?? []).filter(isWritableTargetModule)

/** 写入前的第二道闸：目标仍是有效、可写的用户模块。 */
export const isWritableTarget = (modules: readonly ModuleSummary[] | undefined, moduleId: string): boolean =>
  (modules ?? []).some((module) => module.id === moduleId && isWritableTargetModule(module))

/**
 * 「新建空白模块」的源：引擎内组装的空白模板（`src/host/manifest.ts` 的 `BLANK_MODULE_TEMPLATE`，
 * 不落包内目录）；只声明身份，不预置任何节。
 *
 * ponytail: 名字**不可由用户指定**——`/module-clone` 只吃模板 id，目录名由服务端定
 * （模板名已占用则追加 `-2`/`-3`…）。要自定义命名就得给 `/module-clone` 加显式 targetId，
 * 那是另一条任务；在那之前不要在客户端拼路径，也不要在界面上给一个不生效的输入框。
 */
export const BLANK_MODULE_TEMPLATE = 'blank'

/** 该模板是否合法模块 id（唯一进路径的值都从这里过一道，非法即拒绝发请求）。 */
export const blankModuleTargetValid = (): boolean => isModuleId(BLANK_MODULE_TEMPLATE)

/** 新建空白模块要用的既有复制端点（调用方用 `bridgeCall` 适配即可）。 */
export type BlankModuleCall = (
  endpoint: 'moduleClone',
  body: { id: string; autoSuffix?: boolean },
) => Promise<{ ok: boolean; value?: any }>

/**
 * 新建空白模块只复制定义，保持未启用。名字不是用户输入：目标 id 由服务端返回并回传。
 */
export async function createBlankModule(call: BlankModuleCall): Promise<string | undefined> {
  if (!blankModuleTargetValid()) return undefined
  const cloned = await call('moduleClone', { id: BLANK_MODULE_TEMPLATE, autoSuffix: true })
  return cloned.ok ? cloned.value?.id : undefined
}
