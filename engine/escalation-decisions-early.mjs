import { registerHooks } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveHostPackage } from './host-package.mjs'
import { escalationDecisionsState as state, transformEscalationOwner } from './escalation-decisions.mjs'

const targets = new Map()
for (const [owner, name, digest] of [
  ['sandbox', 'sandbox', 'dcf74e4cea1a0dbd8bfeaa1b454619b55aab83f3b3b761f0534165f0ac05f138'],
]) {
  try {
    let entry
    try { entry = resolveHostPackage(`@deepseek-ai/dsh-${name}`) }
    catch { entry = resolveHostPackage(`@deepseek-ai/dsh-${name}`, resolveHostPackage('@deepseek-ai/dsh-tool-executor-ptc')) }
    const pkg = JSON.parse(readFileSync(join(dirname(entry), '../package.json'), 'utf8'))
    if (pkg.name !== `@deepseek-ai/dsh-${name}` || pkg.version !== '0.2.2-rc.2') throw new Error(`unsupported escalation ${owner} package/version`)
    targets.set(pathToFileURL(entry).href, { owner, digest })
    state.status.set(owner, { available: false, reason: `escalation ${owner} not loaded through early entry; restart DSH` })
  } catch (error) { state.status.set(owner, { available: false, reason: error.message }) }
}
registerHooks({ load(url, context, next) {
  const loaded = next(url, context)
  const target = targets.get(url)
  if (target === undefined) return loaded
  const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString()
  if (createHash('sha256').update(source).digest('hex') !== target.digest) {
    state.status.set(target.owner, { available: false, reason: `escalation ${target.owner} artifact fingerprint mismatch` })
    return loaded
  }
  return { ...loaded, source: transformEscalationOwner(source) }
} })
