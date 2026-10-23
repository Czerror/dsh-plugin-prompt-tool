/**
 * `source-kind.mjs` 的手写声明：只声明 `src/` 消费的导出，形状按实现写实。
 */

/** 拼接 v4 生产者身份。 */
export declare const pluginKind: (owner: string) => string

/** 从 v4 `plugin:<owner>` 解析 owner；裸 `plugin` 与其他形态返回 undefined。 */
export declare const pluginOwner: (kind: unknown) => string | undefined
