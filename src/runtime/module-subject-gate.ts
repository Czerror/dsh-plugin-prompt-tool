/**
 * 归属门：一次读写属于哪个模块、这个模块有没有声明这件事，只在这里判。
 *
 * 此前每个端点各自决定「要不要核形状／核可写／核身份」，外加各自的空目标早退；本模块把
 * 三个旧 guard（`guardModuleFormat`／`guardModuleWrite`／`guardModuleIdentity`）与空目标判据
 * 收成一个入口。端点只声明这次是不是写、要不要核形状；**是否要求主语由契约的主语策略表
 * `BRIDGE_SUBJECT_POLICY` 决定**，**这次要用的节由 `DECLARED_SECTIONS` 决定**——桥里不留
 * 第二份端点名单。
 *
 * 顺序固定，拒绝时写响应并返回 `undefined`（调用点必须
 * `const dir = subjectGate(tx, key, …); if (dir === undefined) return`）：
 * 1. `required` 且 `tx.editDir() === ''` → 400 `module-dir-unavailable`（先于可写校验：无目标报 400，不是 403）；
 * 2. `needs.write` → 目标不在用户模块根下 → 403 `module-readonly`；**空目标豁免本步**：没有模块
 *    目录可写时不判模块只读，写到哪里由端点的空目标分支决定——今天**唯一**用它的就是
 *    `paramOverrides` 的「空主语＝全局层」（写存储根 `config.yml` 的 `layerSettings`）；
 * 3. 形状核（`loadModuleDefinition` + `readModuleLayerSettings`，**默认开**，只有显式 `format: false` 才豁免）；
 * 4. 声明面（登记表里有这个端点、有主语、且**这次是读**时）：模块没声明该节 → 400 `module-not-declared`；
 *    写在读侧拦的是「没内容可读」，写侧不拦——写一个不存在的节恰恰是**创建**它，写完它就被声明了；
 *    定义不可解析时本步**不捕获**，按既有错误路径冒泡给端点（损坏 ≠ 没声明）；
 * 5. 身份一致拆两条判据——载荷主语 ≠ 请求头声明 → 400 `module-subject-conflict`（两个人声明了两个主语）；
 *    解析到的目录与载荷/当次目标不符 → 409 `module-changed`（处理期间目标被换掉）。
 * `format: false` 只跳过第 3 条，第 4、5 条照跑。
 *
 * **一次请求可能既有读分支又有写分支**（`customTools`／`persona`／`paramOverrides`／…）：读分支要的是
 * 「没声明就没内容可读」，写分支要的是「允许添加第一节」。所以这些端点的**早闸**把由载荷算出的
 * `write` 传进来（要写就不在第 4 条上拦），写闸再传 `{ write: true }`；分支判定留在端点（只有它认识自己的载荷）。
 *
 * `none` 策略的端点今天根本不解析目录，照旧不调用本门。
 */
import { basename, resolve, sep } from 'node:path'
import type { BridgeEndpointKey } from '../shared/bridge-contract.ts'
import {
  BRIDGE_SUBJECT_POLICY,
  EDIT_TARGET_HEADER,
  MODULE_IDENTITY_INVALID,
  MODULE_NOT_DECLARED,
  MODULE_SUBJECT_CONFLICT,
  readSubjectHeader,
} from '../shared/bridge-contract.ts'
import type { BridgeTransaction } from './bridge-transaction.ts'
import { DECLARED_SECTIONS, moduleDeclarations } from '../host/module-declarations.ts'
import { ModuleLayerSettingsError, readModuleLayerSettings } from '../host/module-layer-settings.ts'
import { userModulesDir } from '../host/manifest.ts'
import { loadModuleDefinition, ModuleRulesError } from '../host/module-storage.ts'

/** 写一次响应；事务的 `tx.write` 与门内判据共用这一个形态。 */
type GateWrite = (status: number, body: unknown) => void

/** 层配置/规则格式错误的统一反馈：读回时不得伪装成空配置。 */
export function writeLayerSettingsError(write: GateWrite, error: unknown): boolean {
  if (error instanceof ModuleRulesError) {
    write(error.status, { ok: false, code: error.code, message: error.message })
    return true
  }
  if (!(error instanceof ModuleLayerSettingsError)) return false
  write(400, { ok: false, code: error.code, message: error.message })
  return true
}

/**
 * 目标是否为**用户模块**（在用户模块根之下）：system 目录只读，写通道据此拒绝。
 * 读通道不受影响；路径先解析真实相对关系，不用客户端 ID 拼路径。
 */
export function isEditableModuleDir(dir: string, moduleRoot = userModulesDir()): boolean {
  const root = resolve(moduleRoot)
  const target = resolve(dir)
  return target !== root && target.startsWith(root + sep)
}

function guardEditableModuleDir(dir: string, write: GateWrite): boolean {
  // 空目标＝这次写不落在任何模块目录里（`optional` 端点「空主语＝全局层」）：模块只读判据
  // 对它不适用，写到哪里由端点的空目标分支自己决定；有目标才判是否在用户模块根下。
  if (dir.length === 0) return true
  if (isEditableModuleDir(dir)) return true
  write(403, { ok: false, code: 'module-readonly', message: 'system preset 只读，请先复制为用户模块' })
  return false
}

/** 目标模块的层设置/规则形状；空目标没有形状可核。 */
function guardModuleFormat(dir: string, write: GateWrite): boolean {
  if (dir.length === 0) return true
  try { readModuleLayerSettings(loadModuleDefinition(dir).source) } catch (error) {
    if (writeLayerSettingsError(write, error)) return false
  }
  return true
}

/**
 * 声明面：这次是**读**、且登记表里这个端点要的节目标模块一个都没声明时拒绝。
 *
 * 写在读侧拦的是「没有内容可读」；写路径由调用点传 `write: true` 跳过本判据（写会建立该节）。
 * `moduleDeclarations` 抛错（定义不可解析）时**不捕获**：损坏的定义要走端点的既有错误路径，
 * 不得降级成 400 `module-not-declared`（「读不出来」≠「没声明」）。
 */
function guardModuleDeclaration(dir: string, sections: readonly string[] | undefined, write: GateWrite): boolean {
  if (sections === undefined || sections.length === 0) return true
  const declared = moduleDeclarations(dir)
  if (sections.some(section => declared.has(section))) return true
  write(400, { ok: false, code: MODULE_NOT_DECLARED, message: `该模块未声明 ${sections.join(' 或 ')}，请先在模块定义里声明` })
  return false
}

/** 模块身份只作一致性检查，绝不用客户端 ID 构造写入路径；形状核由门口单独跑一次。 */
function guardModuleIdentity(tx: BridgeTransaction, dir: string): boolean {
  const expected = tx.record.expectedModuleId
  if (expected !== undefined && (typeof expected !== 'string' || expected.length === 0 || expected.length > 256)) {
    tx.write(400, { ok: false, code: MODULE_IDENTITY_INVALID, message: 'expectedModuleId 必须是非空模块 ID' })
    return false
  }
  const declared = readSubjectHeader(tx.req.headers[EDIT_TARGET_HEADER])
  if (declared.state === 'ok' && typeof expected === 'string' && expected !== declared.id) {
    tx.write(400, {
      ok: false,
      code: MODULE_SUBJECT_CONFLICT,
      message: `载荷主语与请求头声明不一致：请求头声明「${declared.id}」，载荷声明「${expected}」`,
    })
    return false
  }
  if (tx.editDir() !== dir || (typeof expected === 'string' && expected !== basename(dir))) {
    tx.write(409, { ok: false, code: 'module-changed', message: '目标模块已切换；旧草稿未写入，请重新读取后保存' })
    return false
  }
  return true
}

/**
 * 门。`needs.write` = 本次调用会把内容写进目标模块。
 *
 * `format` = 要不要核目标模块的形状（`loadModuleDefinition` + `readModuleLayerSettings`），
 * **默认核**；只有把编辑目标**只当身份用**的端点显式 `format: false`——`moduleDelete`
 * （目标是用在判据）与 `mutate`（目标只投影 `descriptor.moduleId`）：它们不读模块内容，
 * 坏掉的模块必须仍能删、仍能切总闸。豁免只作用于形状核，声明面与身份判据照跑。
 *
 * `declaration` = 要声明的节名，三态：缺省（`undefined`）按端点 key 查 `DECLARED_SECTIONS`（登记表是唯一
 * 名单，端点不在这里重复）；字符串 = 显式覆盖这个端点要的节；`false` = **显式跳过声明面检查**（与
 * `format: false` 同形），给「这次读的内容与模块声明无关」的调用用——今天只有 `/module-variables` 的
 * `scope: 'global'`（全局变量跨模块共享，不该被某个模块没声明 `variables` 挡住）。
 *
 * `write: true` 同时表达两件事：可写校验（403）与「这次是写，不查声明面」；早闸对**可能写**的请求
 * 用载荷算出的 `write` 传进来，读请求不传。
 */
export function subjectGate(
  tx: BridgeTransaction,
  key: BridgeEndpointKey,
  needs: { write?: boolean; format?: boolean; declaration?: string | false } = {},
): string | undefined {
  const dir = tx.editDir()
  if (BRIDGE_SUBJECT_POLICY[key] === 'required' && dir.length === 0) {
    tx.write(400, { ok: false, code: 'module-dir-unavailable', message: '该模块目录不可用' })
    return undefined
  }
  if (needs.write === true && !guardEditableModuleDir(dir, tx.write)) return undefined
  if ((needs.format ?? true) && !guardModuleFormat(dir, tx.write)) return undefined
  // 有主语、且这次是读，才判声明面：空目标没有可声明的东西，写会建立该节。
  const sections = needs.declaration === false ? undefined
    : needs.declaration === undefined ? DECLARED_SECTIONS[key] : [needs.declaration]
  if (needs.write !== true && dir.length !== 0 && !guardModuleDeclaration(dir, sections, tx.write)) return undefined
  if (!guardModuleIdentity(tx, dir)) return undefined
  return dir
}
