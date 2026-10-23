/**
 * store 的视图端口：卡片与测试按**端口**声明依赖，不再各自 `Pick` 那 61 个成员。
 *
 * 端口按域切，每个端口对应一组同源成员（订阅通道、草稿池、某类资产的读写）。
 * 类型只是 `PromptToolStore` 的投影——**运行期零变化**：store 仍是一个扁平对象，
 * `PromptToolStore = 各端口交叉`，迁移可以逐个调用点进行。
 *
 * 新增卡片时先回答「我需要哪几个端口」，再在 props 上写交叉；不要回退到 Pick 大接口。
 */
import type { EngineMeta } from '../prompt-tool-types.ts'
import type { Fields, HostDefaultModel, SharedParamKey } from './prompt-tool-fields.ts'
import type { ModuleActions } from './module-actions.ts'
import type { ModuleVariablesView } from './module-variables.ts'
import type { ParamSnapshot } from './param-overrides.ts'
import type { PromptToolHostApi } from './host-api.ts'
import type { WorkspaceDrafts } from './workspace-drafts.ts'
import type { ConfirmSkillOverwrite } from './skill-import.ts'
import type { InstructionDraftPool } from './instruction-drafts.ts'
import type { BridgeResult } from './bridge-client.ts'
import type { createTemplateRuleWriter } from './template-rule-writer.ts'
import type { ModelReasoningView } from '../../shared/bridge-contract.ts'
import type { InstructionPolicyFileOverride, InstructionPolicySnapshot } from '../../shared/instructions.ts'
import type { ModuleVariableScope } from '../../shared/module-variables.ts'
import type { SkillCatalogEntry, SkillContentSnapshot, SkillPolicyChange } from '../../shared/skills.ts'

/** 模块事实与字段订阅：几乎每张卡都要。 */
export interface ModuleFactsPort {
  meta: EngineMeta
  fields: Fields
  /** fields 外部订阅通道（usePromptToolFields）：patch/load 变更后通知；`getFields` 返回引用稳定快照。 */
  getFields: () => Fields
  subscribeFields: (listener: () => void) => () => void
}

/** 工作台共享草稿池：模块参数、层设置、资产卡等共用同一份按主语索引的草稿。 */
export interface DraftsPort {
  editorDrafts: WorkspaceDrafts
  /** 草稿修订号与订阅：同一参数的多个镜像渲染点据此同步未完成的输入。 */
  getDraftRevision: () => number
  subscribeDrafts: (listener: () => void) => () => void
  publishDrafts: () => void
}

/** 公共参数：模块参数与全局层参数共用一套读写（落盘分别走 `persist*`）。 */
export interface ParamsPort {
  moduleParamsOf: (moduleId: string) => ParamSnapshot
  ensureModuleParams: (moduleId: string) => void
  setModuleParam: (moduleId: string, key: SharedParamKey, value: unknown) => void
  persistParamOverrides: (moduleId: string) => Promise<void>
  globalParams: ParamSnapshot
  globalParamsLoaded: boolean
  setGlobalParam: (key: SharedParamKey, value: unknown) => void
  persistGlobalParams: () => Promise<void>
}

/** 模板变量：按主语的读数、草稿写入与保存／发布重试。 */
export interface VariablesPort {
  moduleVariables: (moduleId: string) => ModuleVariablesView
  ensureModuleVariables: (moduleId: string) => void
  setModuleVariablesScope: (moduleId: string, scope: ModuleVariableScope) => void
  setModuleVariables: (moduleId: string, value: Record<string, string>) => void
  setModuleVariablesEnabled: (moduleId: string, value: boolean) => void
  saveModuleVariables: (moduleId: string, next?: Record<string, string>, enabled?: boolean) => Promise<boolean>
  retryModuleVariablesPublication: (moduleId: string) => Promise<boolean>
}

/** 技能资产与调用策略：清单刷新、正文读写、引用目录与宿主目录操作。 */
export interface SkillsPort {
  skillsBusy: boolean
  importSkillsDirectory: (path: string, confirm?: ConfirmSkillOverwrite) => Promise<boolean>
  refreshSkills: () => Promise<boolean>
  createSkill: (input: { name: string; description: string; content: string }) => Promise<boolean>
  readSkill: (skill: SkillCatalogEntry, sessionId: string | undefined) => Promise<BridgeResult<SkillContentSnapshot>>
  saveSkill: (skill: SkillCatalogEntry, content: string, description: string, expectedRevision: string, sessionId: string | undefined) => Promise<BridgeResult<SkillContentSnapshot>>
  deleteSkill: (skill: Pick<SkillCatalogEntry, 'name' | 'path'>) => Promise<boolean>
  setSkillPolicy: (name: string, path: string, change: SkillPolicyChange) => Promise<boolean>
  patchSkillFolders: (folders: string[]) => Promise<boolean>
  openSkillsDir: (path?: string) => Promise<void>
}

/** 指令文件：草稿池读取、显式保存、离开前保存、重读与逐文件策略。 */
export interface InstructionFilesPort {
  getInstructionPool: () => InstructionDraftPool
  /** 指令卡正文镜像进草稿池：fileId 是身份，text 是这条通道唯一接受的字段。 */
  patchInstructionText: (fileId: string, text: string) => void
  persistInstructionFiles: (fileIds?: readonly string[]) => Promise<boolean>
  /** 离开前保存：只管全局开关与指令文件两个域（规则草稿由各自的 rule editor 负责）。 */
  persistBeforeLeave: () => Promise<boolean>
  reloadInstructionFile: (fileId: string) => Promise<void>
  instructionPolicy: InstructionPolicySnapshot
  updateInstructionPolicy: (fileId: string, override: InstructionPolicyFileOverride | null) => Promise<boolean>
}

/** 规则编辑：已绑定模块身份的规则事务与模板建卡。 */
export interface RuleEditingPort {
  enqueueRuleTask: <T>(task: () => Promise<T>) => Promise<T>
  createTemplateRule: ReturnType<typeof createTemplateRuleWriter>
}

/** 模块动作：总闸、能力增删、新建与开关落盘（模块页／切换器／能力列表用）。 */
export interface ModuleActionsPort {
  moduleActions: ModuleActions
  createModule: () => Promise<string | undefined>
  toggle: () => void
  createModuleCapability: (moduleId: string, action: 'create' | 'create-recipe', id: string) => Promise<boolean>
  removeModuleCapability: (moduleId: string, id: string) => Promise<boolean>
  persistSwitches: (onSaved?: () => void) => Promise<boolean>
  dirtySwitches: boolean
}

/** 通知与加载：全局提示、重载与字段补丁。 */
export interface NoticePort {
  notice: string
  noticeKind: 'ok' | 'error'
  noticePill: string | undefined
  showNotice: (kind: 'ok' | 'error', message: string, pill?: string) => void
  load: (options?: { silent?: boolean }) => Promise<Fields>
  patch: (partial: Partial<Omit<Fields, 'instructionCards'>>) => void
  loading: boolean
}

/** 当前会话模型事实（模型路由卡）。 */
export interface ModelsPort {
  modelCatalog: Record<string, string[]>
  modelReasoning: Record<string, ModelReasoningView>
  hostDefaultModel?: HostDefaultModel
}

/** 宿主能力面：目录选择、打开路径、会话模型与官方预设投影。 */
export interface HostApiPort {
  api: PromptToolHostApi
}
