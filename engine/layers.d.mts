import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** 已有提示词引擎通知消息；使用宿主当前的插件来源契约。 */
export function pluginMessage(prefix: string, text: string, summary: string): UserMessage
