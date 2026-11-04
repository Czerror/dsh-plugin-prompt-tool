/** 真实载荷与规则事实帧共用的步骤模型归一化入口；不持有模型状态。 */
export function modelOf(payload: unknown, agent?: unknown, allowFallback?: boolean): string | undefined
