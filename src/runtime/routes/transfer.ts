/** transfer 域端点：上传暂存、模块包导入/导出。 */
import type { IncomingMessage } from 'node:http'
import { userModulesDir } from '../../host/module-dirs.ts'
import { assertModuleId } from '../../host/module-install.ts'
import { expandModuleSource, exportModulePackage, installModulePackage, moduleImportPreview } from '../../host/module-package.ts'
import type { ModuleExportRequest } from '../../shared/asset-transfer.ts'
import { BRIDGE_ENDPOINTS } from '../../shared/bridge-contract.ts'
import {
  isRecord,
  readBridgeFiles,
  readImportRequestParams,
  SHA256_HEX_RE,
  type BridgeRuntime,
} from '../bridge-runtime.ts'

function uploadFileName(req: IncomingMessage): string {
  const value = req.headers['x-file-name']
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 1024) throw new Error('缺少合法 X-File-Name 上传文件名')
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new Error('上传文件名编码无效')
  }
}

/** 本域用到的运行时面：只用这些，不加宽（新域照此声明自己的面）。 */
type TransferRuntime = Pick<BridgeRuntime,
  'deps' | 'register' | 'descriptor' | 'assetSources' | 'finishModuleChange'>

export function registerTransfer(runtime: TransferRuntime): Array<() => void> {
  return [
    runtime.register(BRIDGE_ENDPOINTS.assetUpload, { body: 'none', handle: async (tx) => {
      try {
        const value = await runtime.assetSources.upload(uploadFileName(tx.req), tx.req)
        tx.write(200, { ok: true, value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        tx.write(message.includes('64 MiB') ? 413 : 400, { ok: false, code: 'asset-upload-rejected', message })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.assetRelease, { handle: async (tx) => {
      const record = tx.record
      if (typeof record.sourceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(record.sourceId)) {
        tx.write(400, { ok: false, code: 'asset-release-rejected', message: 'sourceId 必须是有效上传来源标识' })
        return
      }
      try { tx.write(200, { ok: true, value: { released: runtime.assetSources.release(record.sourceId) } }) }
      catch (error) { tx.write(400, { ok: false, code: 'asset-release-rejected', message: String(error) }) }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.importModulePackage, { handle: async (tx) => {
      const record = tx.record
      // refreshOnly：只重建已安装模块，不读取来源、不重新安装。
      if (record.refreshOnly === true) {
        const targetId = typeof record.targetId === 'string' ? record.targetId : ''
        if (targetId.length === 0 || Object.keys(record).some(key => key !== 'targetId' && key !== 'refreshOnly')) {
          tx.write(400, { ok: false, code: 'module-package-invalid', message: 'refreshOnly 只接受已安装模块 id' })
          return
        }
        try { assertModuleId(targetId) } catch (error) {
          tx.write(400, { ok: false, code: 'module-package-invalid', message: error instanceof Error ? error.message : String(error) })
          return
        }
        const publication = await runtime.finishModuleChange(() => runtime.deps.moduleInstalled?.(targetId))
        tx.write(200, { ok: true, value: { id: targetId, ...publication } })
        return
      }
      // 入口校验先于任何转换与写盘：非法 preview/摘要/顺序组类型一律 400，
      // 不静默回落到"直接写入"，也不在拒绝前创建目录或备份。
      const request = readImportRequestParams(record)
      if (!request.ok) {
        tx.write(400, { ok: false, code: 'module-package-invalid', message: request.message })
        return
      }
      try {
        const files = await expandModuleSource(request.params.sourceId === undefined ? readBridgeFiles(record.files) : runtime.assetSources.read(request.params.sourceId))
        const preview = moduleImportPreview(userModulesDir(), files, request.params)
        if (!('prepared' in preview)) {
          if (!request.params.preview) throw new Error('请先选择内容类型或提示顺序组并重新预览')
          tx.write(200, { ok: true, value: { preview: true, ...preview } })
          return
        }
        const { prepared, summary, sourceDigest, previewRevision } = preview
        if (request.params.preview) {
          tx.write(200, { ok: true, value: { preview: true, state: 'ready', summary, sourceDigest, previewRevision, ...(prepared.report === undefined ? {} : { report: prepared.report }) } })
          return
        }
        const installed = await installModulePackage(userModulesDir(), files, request.params)
        runtime.descriptor.invalidate()
        const publication = await runtime.finishModuleChange(() => runtime.deps.moduleInstalled?.(installed.id))
        tx.write(200, { ok: true, value: { ...installed, sourceDigest, ...(prepared.report === undefined ? {} : { report: prepared.report }), ...publication } })
      } catch (error) {
        const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'module-package-invalid'
        tx.write(code === 'module-preview-stale' ? 409 : 400, { ok: false, code, message: error instanceof Error ? error.message : String(error) })
      }
    } }),
    runtime.register(BRIDGE_ENDPOINTS.exportModule, { handle: async (tx) => {
      const record = tx.record
      try {
        assertModuleId(record.id)
        if (record.id.length > 128) throw new Error('模块 ID 过长')
        if (record.mode !== undefined && record.mode !== 'definition' && record.mode !== 'zip') throw new Error('mode 必须是 definition 或 zip')
        if (record.preview !== undefined && typeof record.preview !== 'boolean') throw new Error('preview 必须是布尔值')
        if (record.expectedRevision !== undefined && (typeof record.expectedRevision !== 'string' || !SHA256_HEX_RE.test(record.expectedRevision))) throw new Error('expectedRevision 必须是 SHA-256 摘要')
        if (record.memoryChoices !== undefined && (!isRecord(record.memoryChoices) || Object.keys(record.memoryChoices).length > 2048
          || Object.entries(record.memoryChoices).some(([key, value]) => key.length === 0 || key.length > 256 || (value !== 'include' && value !== 'exclude')))) throw new Error('memoryChoices 必须包含合法条目 ID 和 include/exclude 选择')
        const value = await exportModulePackage(userModulesDir(), record as unknown as ModuleExportRequest)
        tx.write(200, { ok: true, value })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code) : 'module-export-failed'
        tx.write(code.includes('stale') ? 409 : 400, { ok: false, code, message })
      }
    } }),
  ]
}
