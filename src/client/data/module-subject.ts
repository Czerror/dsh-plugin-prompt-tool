/** 「有没有主语」的唯一判据：模块类编辑与模块草稿键都从这里派生（无主语＝插件等于未启用）。 */
import type { ModuleFacts } from '../../shared/engine-capabilities.ts'
import type { ModuleSummary } from '../../shared/bridge-contract.ts'
import type { ModuleVariableScope } from '../../shared/module-variables.ts'
import { isModuleId } from '../../shared/module-ids.ts'
import type { Fields } from './prompt-tool-fields.ts'

/** 读回前禁止以 UI 默认值写盘。 */
export const MODULE_PENDING_MESSAGE = '模块数据尚未加载完成，本次修改未保存；请稍后重试或重新打开工作台'
export const NO_SUBJECT_MESSAGE = '当前没有可编辑的模块主语，本次修改未保存'

/** 判据输入：模块总闸在 Fields 里，模块事实来自 `/meta` 的逐模块 `facts`（不是 Fields 字段）。 */
type SubjectFields = Pick<Fields, 'modulesEnabled'> & { moduleFacts?: ModuleFacts }

/** 总闸打开且该模块声明可编辑，才存在可编辑的主语；`moduleFacts` 缺席即无主语。 */
export const canEditSubject = (fields: SubjectFields): boolean =>
  fields.modulesEnabled === true && fields.moduleFacts?.editable === true

/** 模块草稿键只随主语存在；无主语返回 undefined，避免 `undefined:scope` 把无主语与真模块串成一份草稿。 */
export const subjectDraftKey = (moduleId: string | undefined, scope: ModuleVariableScope): string | undefined =>
  moduleId === undefined ? undefined : `${moduleId}:${scope}`

/** 引擎参数草稿键：`<owner>:param:<key>`；owner 是 `'global'` 或 moduleId。 */
export const paramDraftKey = (owner: string, param: string): string => `${owner}:param:${param}`

/** 该主语是否拥有某个参数草稿键（精确前缀，相似 id 不误判）。 */
export const ownsParamDraftKey = (key: string, owner: string): boolean => key.startsWith(paramDraftKey(owner, ''))

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
 * 「新建空白模块」的源：引擎内组装的空白模板（`src/host/module-catalog.ts` 的 `BLANK_MODULE_TEMPLATE`，
 * 不落包内目录）；只声明身份，不预置任何节。
 *
 * 目录身份仍由服务端分配为 blank、blank-2 等；显示名称可编辑，不用于拼路径。
 */
export const BLANK_MODULE_TEMPLATE = 'blank'
