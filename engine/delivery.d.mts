/** 宿主使用的投递身份公开面。 */
export function identityOf(config: Record<string, unknown>): string
export function eventMessage(event: unknown): { source: Record<string, unknown> } | undefined
