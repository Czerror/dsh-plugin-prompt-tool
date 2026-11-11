const key = Symbol.for('prompt-tool:result-text')
export const resultTextOwners = globalThis[key] ??= { renderers: new WeakMap(), results: new WeakMap(), prepared: new WeakMap(), status: new Map(), handled: new WeakSet() }

resultTextOwners.mark = (definition, owner) => {
  const original = definition.output.render
  const execute = definition.execute
  const render = function (...args) {
    const content = Reflect.apply(original, this, args)
    if (args[1] !== null && typeof args[1] === 'object' && Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      resultTextOwners.results.set(args[1], { owner, render, execute, definition, args: args[0], text: content[0].text })
    }
    return content
  }
  const ownership = { owner, execute }
  resultTextOwners.renderers.set(render, ownership)
  definition.output.render = render
  const project = definition.projectContent
  definition.projectContent = function (exec, result) {
    resultTextOwners.project?.(exec, result, definition)
    const content = project === undefined ? undefined : Reflect.apply(project, this, [exec, result])
    return content
  }
  ownership.project = definition.projectContent
  const finalize = definition.finalizeContent
  definition.finalizeContent = function (exec, result) {
    let content
    try { content = finalize === undefined ? undefined : Reflect.apply(finalize, this, [exec, result]) }
    catch (error) { resultTextOwners.prepared.delete(exec); throw error }
    if (content !== undefined) { resultTextOwners.prepared.delete(exec); return content }
    return resultTextOwners.finalize?.(exec, result)
  }
  ownership.finalize = definition.finalizeContent
  return definition
}
