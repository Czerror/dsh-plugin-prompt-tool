/**
 * 归属门：一次读写属于哪个模块，只在这里判。
 *
 * 此前每个端点各自决定「要不要核形状／核可写／核身份」，外加各自的空目标早退；本模块把
 * 三个旧 guard（`guardModuleFormat`／`guardModuleWrite`／`guardModuleIdentity`）与空目标判据
 * 收成一个入口。端点只声明这次是不是写、要不要核形状；**是否要求主语由契约的主语策略表
 * `BRIDGE_SUBJECT_POLICY` 决定**——桥里不再留第二份端点名单。
 *
 * 顺序固定，拒绝时写响应并返回 `undefined`（调用点必须
 * `const dir = subjectGate(tx, key, …); if (dir === undefined) return`）：
 * 1. `required` 且 `tx.editDir() === ''` → 400 `module-dir-unavailable`（先于可写校验：无目标报 400，不是 403）；
 * 2. `needs.write` → 目标不在用户模块根下 → 403 `module-readonly`；
 * 3. 形状核（`loadModuleDefinition` + `readModuleLayerSettings`，**默认开**，只有显式 `format: false` 才豁免）；
 * 4. 身份一致拆两条判据——载荷主语 ≠ 请求头声明 → 400 `module-subject-conflict`（两个人声明了两个主语）；
 *    解析到的目录与载荷/当次目标不符 → 409 `module-changed`（处理期间目标被换掉）。
 * `format: false` 只跳过第 3 条，第 4 条照跑。
 *
 * `none` 策略的端点今天根本不解析目录，照旧不调用本门。
 */
import { basename, resolve, sep } from 'node:path'
import type { BridgeEndpointKey } from '../shared/bridge-contract.ts'
import {
  BRIDGE_SUBJECT_POLICY,
  EDIT_TARGET_HEADER,
  MODULE_IDENTITY_INVALID,
  MODULE_SUBJECT_CONFLICT,
  readSubjectHeader,
} from '../shared/bridge-contract.ts'
import type { BridgeTransaction } from './bridge-transaction.ts'
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
    tx.write(409, { ok: false, code: 'module-changed', message: '当前模块已切换；旧草稿未写入，请重新读取后保存' })
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
 * 坏掉的模块必须仍能删、仍能切总闸。豁免只作用于形状核，身份判据照跑。
 */
export function subjectGate(
  tx: BridgeTransaction,
  key: BridgeEndpointKey,
  needs: { write?: boolean; format?: boolean } = {},
): string | undefined {
  const dir = tx.editDir()
  if (BRIDGE_SUBJECT_POLICY[key] === 'required' && dir.length === 0) {
    tx.write(400, { ok: false, code: 'module-dir-unavailable', message: '当前模块目录不可用' })
    return undefined
  }
  if (needs.write === true && !guardEditableModuleDir(dir, tx.write)) return undefined
  if ((needs.format ?? true) && !guardModuleFormat(dir, tx.write)) return undefined
  if (!guardModuleIdentity(tx, dir)) return undefined
  return dir
}
