import { rewindEnabled } from './rewind-control.mjs'

/** Require the live official projection only when this Agent enables todo rewind. */
export function checkRewindTodos(agent) {
  if (!rewindEnabled(agent, 'session-rewind-todos')) return
  const todos = agent.ctx.get('sessionProjections')?.snapshot(agent.session, ['todos']).values.todos
  if (todos === undefined) throw new Error('官方待办所有者不可用，未提交待办回退')
  return todos
}

/** Use the official standing-plan projection and its durable whole-list event. Never replay writes. */
export function rewindTodos(agent) {
  const todos = checkRewindTodos(agent)
  if (!Array.isArray(todos) || !todos.some(todo => todo.status === 'completed')) return
  agent.session.append('todo/write', { todos: todos.map(todo => todo.status === 'completed' ? { ...todo, status: 'pending' } : todo) })
}
