import { rewindEnabled } from './rewind-control.mjs'

/** Use the official standing-plan projection and its durable whole-list event. Never replay writes. */
export function rewindTodos(agent) {
  if (!rewindEnabled(agent, 'session-rewind-todos')) return
  const todos = agent.ctx.sessionProjections.snapshot(agent.session).values.todos
  if (!Array.isArray(todos) || !todos.some(todo => todo.status === 'completed')) return
  agent.session.append('todo/write', { todos: todos.map(todo => todo.status === 'completed' ? { ...todo, status: 'pending' } : todo) })
}
