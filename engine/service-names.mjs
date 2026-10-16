/** pre-step 协调服务名：插件 provide、引擎 getService 读取，两侧共用这一个名字。 */
export const PRE_STEP_COORDINATOR_SERVICE = 'promptToolPreStep'

/** 四个模块工具外壳的服务名：`pt-<引擎模块 id>`。前缀是本函数的内部细节。 */
export function toolServiceName(engineModuleId) {
  return `pt-${engineModuleId}`
}
