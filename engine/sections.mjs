import { createHash } from 'node:crypto'
import { z } from 'zod'
import { getService } from './shared.mjs'

const prefix = 'prompt-tool:section-add:'
const injectedPrefix = 'prompt-tool:section:'
const explicitPrefix = prefix + 'id:'
const added = Symbol('added section')
export const filteredSections = Symbol('filtered sections')
const fingerprint = text => createHash('sha256').update(text.trim()).digest('base64url')
const encode = values => Buffer.from(JSON.stringify(values)).toString('base64url')
const compareName = (a, b) => a < b ? -1 : a > b ? 1 : 0
const compareSection = (a, b) => a.order - b.order || compareName(a.name, b.name)

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
  stateVersion: 1,
  stateSchema: z.array(z.object({ name: z.string(), order: z.number(), body: z.string().optional() })),
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
        ...(contributed && section.name.startsWith(prefix + 'auto:') ? { body: fingerprint(text) } : {}) })
    }
    return next === undefined ? source.reset && state.length > 0 ? [] : state : [...next.values()]
  },
}

function nameContributions(list, previous, authored, hidden) {
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
    return entry === known || known?.delivered === entry.body ? known : undefined
  }
  for (const [key, sections] of groups) {
    const before = (candidates.get(key) ?? []).sort((a, b) =>
      (acceptedAuthor(a)?.order ?? a.order) - (acceptedAuthor(b)?.order ?? b.order) || compareName(a.name, b.name))
    const matches = new Map()
    let sequence = 0
    for (let index = before.length - 1; index >= 0; index--) {
      const entry = before[index]
      sequence = Math.max(sequence, Number.parseInt(entry.name.slice(key.length), 10) + 1)
      const body = acceptedAuthor(entry)?.body ?? entry.body
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

export function finalizeSections(assembly, names = [], previous = [], authored = new Map(), withdraw = false) {
  const list = assembly?.sections
  if (!Array.isArray(list)) return { assembly, authored }
  const hidden = assembly[filteredSections]
  const hasContributions = list.some(isAddedSection)
  const named = hasContributions ? nameContributions(list, previous, authored, hidden) : { sections: list, authored }
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
  let projectionHandle
  const authors = new WeakMap()
  let authoredWithoutSession = new Map()
  let off
  let active = true
  const bind = () => {
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
      const final = finalizeSections(result, ordered, committed ?? [], authored, session !== undefined)
      if (session === undefined) authoredWithoutSession = final.authored
      else authors.set(session, final.authored)
      return final.assembly
    }, { prepend: true })
  }
  return { bind, dispose() { active = false; off?.(); void projectionHandle?.then(handle => handle.dispose()).catch(() => {}) } }
}
