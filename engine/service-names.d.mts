/** `service-names.mjs` 的手写声明：只声明 `src/` 消费的导出。 */

/** pre-step 协调服务名：插件 provide、引擎 getService 读取，两侧共用这一个名字。 */
export const PRE_STEP_COORDINATOR_SERVICE: string

/** 发现引擎注册表服务名：宿主 root provide，adapter 行按 agent 注册，动作按 agent 解析。 */
export const DISCOVERY_SERVICE: string
export const SOUL_SELF_SERVICE: string
export const SOUL_MAINTENANCE_SERVICE: string

/** 模块清单 checks 事实：宿主提供，宿主装配读取后经挂载 options 传给谓词。 */
export const MANIFEST_CHECK_SERVICE: 'promptToolManifestCheck'

/** 四个模块工具外壳的服务名：`pt-<引擎模块 id>`。前缀是本函数的内部细节。 */
export function toolServiceName(engineModuleId: string): string
