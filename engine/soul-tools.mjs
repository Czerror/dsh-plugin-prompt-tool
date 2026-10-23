// 项目级 soul 工具行：实现原样放在 ./soul/（与 dsh-agent-soul 同源移植，MIT）。
// 只注册工具，不挂行为钩子；工具面由启用模块的 modules: [soul-tools] 决定。
export { name, inject, apply } from './soul/index.js'
