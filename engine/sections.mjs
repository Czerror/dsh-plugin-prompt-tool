import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { symbols } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { cordisRoot, createWarnOnce, getService } from './shared.mjs'
import { resolveRealWithin } from './path-safety.mjs'
import { resolveDshHome } from './dsh-home.mjs'

const prefix = 'prompt-tool:section-add:'
const injectedPrefix = 'prompt-tool:section:'
const explicitPrefix = prefix + 'id:'
const added = Symbol('added section')
const standalonePresentations = new WeakMap()
const admissionServices = new WeakMap()
const admissionRoots = new WeakMap()
const presentationAuthors = new AsyncLocalStorage()
export const filteredSections = Symbol('filtered sections')
const fingerprint = text => createHash('sha256').update(text.trim()).digest('base64url')
const encode = values => Buffer.from(JSON.stringify(values)).toString('base64url')
const compareName = (a, b) => a < b ? -1 : a > b ? 1 : 0
const compareSection = (a, b) => a.order - b.order || compareName(a.name, b.name)
const sourceBodies = z.array(z.tuple([z.string(), z.string().regex(/^[\w-]{43}$/)]))
const maxRecordBytes = 1024 * 1024

function sectionRecord(messageId, mkdir = false) {
  const home = resolveDshHome()
  const storage = resolveRealWithin(join(home, '.prompt-tool'), [home], 'system section storage')
  if (mkdir) mkdirSync(storage, { recursive: true })
  const directory = resolveRealWithin(join(storage, 'section-admissions'), [storage], 'system section storage')
  if (mkdir) mkdirSync(directory, { recursive: true })
  return resolveRealWithin(join(directory, fingerprint(messageId) + '.json'), [directory], 'system section record')
}

function readSectionRecord(messageId, warnOnce) {
  try {
    const file = sectionRecord(messageId)
    const descriptor = openSync(file, 'r')
    try {
      const { size } = fstatSync(descriptor)
      if (size > maxRecordBytes) throw new Error('record exceeds size limit')
      const buffer = Buffer.alloc(size)
      let offset = 0
      while (offset < size) {
        const count = readSync(descriptor, buffer, offset, size - offset, offset)
        if (count === 0) throw new Error('incomplete record')
        offset += count
      }
      return new Map(sourceBodies.parse(JSON.parse(buffer.toString('utf8'))))
    } finally { closeSync(descriptor) }
  } catch (error) {
    if (error?.code !== 'ENOENT') warnOnce('prompt-tool: could not read section identity record; matching uses committed section text')
  }
}

function writeSectionRecord(messageId, bodies) {
  const file = sectionRecord(messageId, true)
  const content = JSON.stringify(bodies)
  if (Buffer.byteLength(content) > maxRecordBytes) throw new Error('section identity record exceeds size limit')
  const temporary = file + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function bindAdmissionTracking(ctx) {
  const root = cordisRoot(ctx) ?? ctx
  if (admissionRoots.has(root) || typeof root.inject !== 'function') return
  const pending = new WeakMap()
  const off = root.on('session/event', (session, event) => {
    if (event.type !== 'system/message') return
    const message = event.data.message
    const writes = pending.get(session)
    const bodies = writes?.get(message.id)
    if (bodies === undefined) return
    writes.delete(message.id)
    try { writeSectionRecord(message.id, bodies) }
    catch (error) { root.logger?.warn(`prompt-tool: system section identity record unavailable: ${String(error?.message ?? error)}`) }
  }, { global: true })
  const dependency = root.inject(['systemPrompt'], child => {
    const service = child.systemPrompt[symbols.original] ?? child.systemPrompt
    if (admissionServices.has(service)) return
    const original = service.assemble
    let active = true
    const assemble = async function (context = {}) {
      if (!active || context.session === undefined) return Reflect.apply(original, this, [context])
      const authors = new Map()
      const result = await presentationAuthors.run(authors, () => Reflect.apply(original, this, [context]))
      if (authors.size === 0) return result
      return { ...result, systemUpdates(retry) {
        const updates = result.systemUpdates(retry)
        let writes
        for (const { message } of updates) {
          const bodies = []
          for (const section of message.source.sections ?? []) {
            const author = authors.get(section.name)
            if (author?.body === undefined || section.state !== 'active') continue
            const text = message.content[section.contentIndex].text
            if (text.length > 0 && author.body !== fingerprint(text)) bodies.push([section.name, author.body])
          }
          if (bodies.length > 0) (writes ??= new Map()).set(message.id, bodies)
        }
        if (writes !== undefined) pending.set(context.session, writes)
        return updates
      } }
    }
    service.assemble = assemble
    admissionServices.set(service, assemble)
    return () => {
      active = false
      if (service.assemble === assemble) service.assemble = original
      admissionServices.delete(service)
    }
  })
  admissionRoots.set(root, true)
  root.effect(() => () => { off(); void dependency.dispose(); admissionRoots.delete(root) }, 'prompt-tool section admissions')
}

export const authorSectionName = section => section?.[added]?.name ?? section?.name
export const isAddedSection = section => section?.[added] !== undefined

export function addedSection(entry, owner) {
  const identity = entry.id === undefined ? undefined : explicitPrefix + encode([...owner, entry.id])
  const group = identity === undefined ? prefix + 'auto:' + encode([...owner, entry.name]) + ':' : undefined
  return {
    name: entry.name, text: entry.text, order: entry.order,
    [added]: { name: entry.name, identity, group, originalText: entry.text, body: group === undefined ? undefined : fingerprint(entry.text) },
  }
}

const projection = {
  key: 'promptToolSections',
  stateVersion: 2,
  stateSchema: z.array(z.object({ name: z.string(), order: z.number(), body: z.string().optional(), messageId: z.string().optional() })),
  init: () => [],
  apply(state, event) {
    if (event.type !== 'system/message') return state
    const message = event.data.message
    const source = message.source
    if (source.sections === undefined) return state.length === 0 ? state : []
    let next
    for (const section of source.sections) {
      const contributed = section.name.startsWith(prefix)
      if (!contributed && !section.name.startsWith(injectedPrefix)) continue
      next ??= new Map((source.reset ? [] : state).map(entry => [entry.name, entry]))
      const text = section.state === 'active' ? message.content[section.contentIndex].text : ''
      if (text.length === 0) next.delete(section.name)
      else next.set(section.name, { name: section.name, order: section.order,
        ...(contributed && section.name.startsWith(prefix + 'auto:') ? { body: fingerprint(text), messageId: message.id } : {}) })
    }
    return next === undefined ? source.reset && state.length > 0 ? [] : state : [...next.values()]
  },
}

function nameContributions(list, previous, authored, hidden, records, warnOnce) {
  const assigned = new Map()
  const groups = new Map()
  const occupied = new Set(hidden?.map(section => section.name))
  for (const section of list) if (!isAddedSection(section)) occupied.add(section.name)
  const explicitAliases = new Map()
  for (const entry of [...previous, ...authored.values()]) {
    const separator = entry.name.indexOf('~')
    if (separator >= 0 && entry.name.startsWith(explicitPrefix) && !occupied.has(entry.name)) {
      explicitAliases.set(entry.name.slice(0, separator), entry.name)
    }
  }
  for (const section of list) {
    const contribution = section[added]
    if (contribution === undefined) continue
    if (contribution.identity !== undefined) {
      assigned.set(section, explicitAliases.get(contribution.identity) ?? contribution.identity)
      continue
    }
    const group = groups.get(contribution.group) ?? []
    group.push(section)
    groups.set(contribution.group, group)
  }
  const candidates = new Map()
  const collect = (entry, exclude) => {
    const group = entry.name.slice(0, entry.name.lastIndexOf(':') + 1)
    if (!groups.has(group) || exclude?.has(group) || occupied.has(entry.name)) return
    if (!/^(?:0|[1-9]\d{0,9})(?:~[1-9]\d*)?$/.test(entry.name.slice(group.length))) return
    const entries = candidates.get(group) ?? []
    entries.push(entry)
    candidates.set(group, entries)
  }
  for (const entry of previous) collect(entry)
  const committedGroups = new Set(candidates.keys())
  for (const entry of authored.values()) collect(entry, committedGroups)
  const acceptedAuthor = entry => {
    const known = authored.get(entry.name)
    return known !== undefined && (entry === known || known.delivered === entry.body) ? known : undefined
  }
  const originalBody = entry => {
    const known = acceptedAuthor(entry)
    if (known !== undefined) return known.body
    if (entry.messageId === undefined) return entry.body
    if (!records.has(entry.messageId)) records.set(entry.messageId, readSectionRecord(entry.messageId, warnOnce))
    return records.get(entry.messageId)?.get(entry.name) ?? entry.body
  }
  for (const [key, sections] of groups) {
    const before = (candidates.get(key) ?? []).sort((a, b) =>
      (acceptedAuthor(a)?.order ?? a.order) - (acceptedAuthor(b)?.order ?? b.order) || compareName(a.name, b.name))
    const matches = new Map()
    let sequence = 0
    for (let index = before.length - 1; index >= 0; index--) {
      const entry = before[index]
      sequence = Math.max(sequence, Number.parseInt(entry.name.slice(key.length), 10) + 1)
      const body = originalBody(entry)
      const bucket = matches.get(body) ?? []
      bucket.push(entry)
      matches.set(body, bucket)
    }
    const used = new Set()
    for (const section of sections) {
      const entry = matches.get(section[added].body)?.pop()
      if (entry === undefined) continue
      used.add(entry.name)
      assigned.set(section, entry.name)
    }
    const unclaimed = before.filter(entry => !used.has(entry.name))
    let next = 0
    for (const section of sections) {
      if (!assigned.has(section)) assigned.set(section, unclaimed[next++]?.name ?? key + sequence++)
    }
  }
  const next = new Map()
  const sections = list.map(section => {
    const identity = assigned.get(section)
    if (identity === undefined) return section
    let actual = identity
    const canonical = identity.split('~')[0]
    for (let suffix = 1; occupied.has(actual); suffix++) actual = canonical + '~' + suffix
    occupied.add(actual)
    const { [added]: contribution, ...rest } = section
    if (contribution.group !== undefined) {
      const body = contribution.body
      next.set(actual, { name: actual, order: next.size, body, delivered: section.text === contribution.originalText ? body : fingerprint(section.text) })
    } else if (actual !== contribution.identity) next.set(actual, { name: actual })
    return { ...rest, name: actual }
  })
  return { sections, authored: next }
}

function comparePlacement(a, b) {
  if (a.order === undefined) return b.order === undefined ? 0 : 1
  if (b.order === undefined) return -1
  return compareSection(a, b)
}

function placeSections(sections, names) {
  // Stable sort keeps declared order for entries whose order was omitted.
  if (sections.some((section, index) => index > 0 && comparePlacement(sections[index - 1], section) > 0)) {
    sections = sections.toSorted(comparePlacement)
  }
  const rank = new Map(names.map((name, index) => [name, index]))
  const movable = sections.filter(section => !section.retire && rank.has(section.name))
    .sort((a, b) => rank.get(a.name) - rank.get(b.name))
  let index = 0
  let previous
  let overflow = false
  const result = sections.map(slot => {
    const section = !slot.retire && rank.has(slot.name) ? movable[index++] : slot
    let order = slot.order ?? previous?.order ?? 0
    if (previous !== undefined && (slot.order === undefined || order < previous.order
      || order === previous.order && compareName(previous.name, section.name) >= 0)) {
      order = previous.order + Math.max(Number.MIN_VALUE, Math.abs(previous.order) * Number.EPSILON)
      if (!Number.isFinite(order)) { order = Number.MAX_VALUE; overflow = true }
    }
    return previous = order === section.order ? section : { ...section, order }
  })
  // At the upper end of the finite range move the tied predecessors down instead.
  if (overflow) for (let i = result.length - 2; i >= 0; i--) {
    const section = result[i], next = result[i + 1]
    if (compareSection(section, next) >= 0) {
      result[i] = { ...section, order: next.order - Math.max(Number.MIN_VALUE, Math.abs(next.order) * Number.EPSILON) }
    }
  }
  return result
}

function finalizeSections(assembly, names, previous, authored = new Map(), withdraw, records = new Map(), warnOnce) {
  const list = assembly?.sections
  if (!Array.isArray(list)) return { assembly, authored }
  const hidden = assembly[filteredSections]
  const hasContributions = list.some(isAddedSection)
  const named = hasContributions ? nameContributions(list, previous, authored, hidden, records, warnOnce) : { sections: list, authored }
  let sections = named.sections
  if (sections !== list || names.length > 1) sections = placeSections(sections, names)
  if (withdraw && (hidden?.length || previous.length)) {
    const visible = new Set(sections.map(section => section.name))
    const withdrawals = []
    for (const section of [...(hidden ?? []), ...previous]) {
      if (visible.has(section.name)) continue
      withdrawals.push({ name: section.name, order: section.order, text: '' })
      visible.add(section.name)
    }
    if (withdrawals.length > 0) sections = [...sections, ...withdrawals]
  }
  if (hidden === undefined) return { assembly: sections === list ? assembly : { ...assembly, sections }, authored: named.authored }
  const { [filteredSections]: _hidden, ...rest } = assembly
  return { assembly: { ...rest, sections }, authored: named.authored }
}

/** Reconcile after the rules but before the host sorts and admits the presentation. */
export function createSectionPresentation(ctx, names) {
  const warnOnce = createWarnOnce(ctx, 'prompt-tool sections')
  let projectionHandle
  const authors = new WeakMap()
  let authoredWithoutSession = new Map()
  const coldRecords = new WeakMap()
  let off
  let active = true
  const bind = () => {
    bindAdmissionTracking(ctx)
    off?.()
    off = ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const result = await next()
      if (!active) return result
      const session = context?.session
      if (session !== undefined && projectionHandle === undefined) {
        const registry = getService(ctx, 'sessionProjections')
        if (registry !== undefined) projectionHandle = Promise.resolve(registry.register(projection))
      }
      const handle = session === undefined ? undefined : await projectionHandle
      if (!active) return result
      const committed = handle?.stateOf(session)
      const ordered = names()
      if (result?.sections === assembly?.sections && ordered.length < 2 && (committed?.length ?? 0) === 0) return result
      const authored = session === undefined ? authoredWithoutSession : authors.get(session)
      let records
      if (session !== undefined && committed?.length) {
        records = coldRecords.get(committed)
        if (records === undefined) coldRecords.set(committed, records = new Map())
      }
      const final = finalizeSections(result, ordered, committed ?? [], authored, session !== undefined, records, warnOnce)
      const admissionAuthors = presentationAuthors.getStore()
      if (admissionAuthors !== undefined && final.authored !== authored) {
        for (const [section, author] of final.authored) admissionAuthors.set(section, author)
      }
      if (session === undefined) authoredWithoutSession = final.authored
      else authors.set(session, final.authored)
      return final.assembly
    }, { prepend: true })
  }
  return { bind, dispose() { active = false; off?.(); void projectionHandle?.then(handle => handle.dispose()).catch(() => {}) } }
}

/** Keep the reconciler alive for already-admitted sections after an action leaves. */
export function bindStandaloneSections(ctx) {
  const root = cordisRoot(ctx) ?? ctx
  let presentation = standalonePresentations.get(root)
  if (presentation === undefined) {
    presentation = createSectionPresentation(root, () => [])
    standalonePresentations.set(root, presentation)
    root.effect(() => () => presentation.dispose(), 'prompt-tool standalone sections')
  }
  presentation.bind()
}
