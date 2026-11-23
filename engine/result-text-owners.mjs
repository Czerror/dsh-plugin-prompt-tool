export const resultTextOwners = { renderers: new WeakMap(), results: new WeakMap(), prepared: new WeakMap(), handled: new WeakSet() }

resultTextOwners.mark = (definition, owner, isActive) => {
  definition = Object.defineProperties({}, Object.getOwnPropertyDescriptors(definition))
  const original = definition.output.render
  const execute = definition.execute
  const failures = new WeakMap()
  if (owner === '@deepseek-ai/dsh-tool-fs' || owner === '@deepseek-ai/dsh-tool-str-replace-editor') {
    definition.execute = async function (args, exec) {
      try { return await Reflect.apply(execute, this, [args, exec]) }
      catch (error) {
        if (isActive() && error?.code === 'FS_SANDBOX_DENIED') failures.set(exec, error.message)
        throw error
      }
    }
  }
  const render = function (...args) {
    const content = Reflect.apply(original, this, args)
    if (isActive() && args[1] !== null && typeof args[1] === 'object' && Array.isArray(content) && content.length === 1
      && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      resultTextOwners.results.set(args[1], { render, execute: definition.execute, args: args[0], text: content[0].text })
    }
    return content
  }
  const ownership = { owner, execute: definition.execute, isActive, failures }
  resultTextOwners.renderers.set(render, ownership)
  definition.output = { ...definition.output, render }
  const project = definition.projectContent
  definition.projectContent = function (exec, result) {
    if (isActive()) resultTextOwners.project?.(exec, result, definition)
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
