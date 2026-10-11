/** 「有没有主语」的唯一判据：模块类编辑与模块草稿键都从这里派生（无主语＝插件等于未启用）。 */
import type { ModuleFacts } from '../../shared/engine-capabilities.ts'
import type { ModuleSummary } from '../../shared/bridge-contract.ts'
import type { ModuleVariableScope } from '../../shared/module-variables.ts'
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

/** 该模块此刻是否可编辑：总闸 + 该模块自己的事实——卡按归属问它，不用单主语镜像。 */
export const canEditModule = (
  fields: Pick<Fields, 'modulesEnabled'>,
  modules: readonly ModuleSummary[] | undefined,
  moduleId: string,
): boolean => canEditSubject({ modulesEnabled: fields.modulesEnabled, moduleFacts: moduleFactsOf(modules, moduleId) })
