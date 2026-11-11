import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { processDefaultsState as state } from './process-defaults.mjs'
import { transformApprovalService, approvalDecisionsState } from './approval-decisions.mjs'

for (const [name, owner, digest] of [
  ['@deepseek-ai/dsh-sandbox-policy', 'SandboxPolicyService', '8eb1674f9c3c2e336efae7ecc734d5197dc8b80bc29f1f1d61bfe0b5a1472188'],
  ['@deepseek-ai/dsh-user-approval', 'ApprovalService', '45b7c170b6897f15a338037b1951997a1b99018c30b5fc95f7e08ad798075be2'],
]) {
  let target
  try {
    target = pathToFileURL(resolveHostPackage(name)).href
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(target)), '../package.json'), 'utf8'))
    if (pkg.name !== name || pkg.version !== '0.2.2-rc.1') throw new Error('unsupported process default owner package/version')
  } catch (error) {
    state.ownerUnavailable(name, String(error.message))
    if (owner === 'ApprovalService') { approvalDecisionsState.autoGrant.available = false; approvalDecisionsState.autoGrant.reason = String(error.message) }
    continue
  }
  registerHooks({ load(url, context, next) {
    const result = next(url, context)
    if (url !== target) return result
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
    if (createHash('sha256').update(source).digest('hex') !== digest) {
      if (owner === 'ApprovalService') {
        approvalDecisionsState.autoGrant.available = false
        approvalDecisionsState.autoGrant.reason = `${name} constructor artifact fingerprint mismatch`
      }
      state.ownerUnavailable(name, `${name} constructor artifact fingerprint mismatch`); return result
    }
    const transformed = owner === 'ApprovalService' ? transformApprovalService(source) : source
    return { ...result, source: transformed + `\nglobalThis[Symbol.for("prompt-tool:process-defaults")]?.markOwner(${JSON.stringify(name)}, ${owner});\n` }
  } })
}

let loaderTarget
try {
  loaderTarget = pathToFileURL(resolveHostPackage('@deepseek-ai/cordis-plugin-loader')).href
  const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(loaderTarget)), '../package.json'), 'utf8'))
  if (pkg.name !== '@deepseek-ai/cordis-plugin-loader' || pkg.version !== '1.1.0') throw new Error('unsupported Loader package/version')
} catch (error) { loaderTarget = undefined; state.configReason = String(error.message) }
if (loaderTarget !== undefined) registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (url !== loaderTarget) return result
  const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString()
  const from = 'return interpolate(fiber.ctx, config);'
  if (createHash('sha256').update(source).digest('hex') !== '4f0a93a1ef5bb09bd6e1c64b30df11be25efd46c316b9505c5ddf308974367a6'
    || source.split(from).length !== 2) {
    state.configAvailable = false; state.configReason = 'Loader artifact fingerprint or raw config structure mismatch'; return result
  }
  state.configAvailable = true; state.configReason = ''
  return { ...result, source: source.replace(from,
    'return interpolate(fiber.ctx, globalThis[Symbol.for("prompt-tool:process-defaults")]?.rawConfig(fiber, config) ?? config);') }
} })
