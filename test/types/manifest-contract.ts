/**
 * 编译期 manifest 契约：本插件 package.json#dsh 段必须保持官方 `DshManifest` 形状。
 *
 * 运行期 JSON 断言在 test/client-bundle-facade.test.mjs；这里锁定字段名与类型，
 * 不用 `as DshManifest` 强转冒充校验。DshBundleManifest 只有 `patch` 字段，
 * 因此 web-app 这类装配事实由 src/web-surface.ts 的常量承载，不再写回 package.json。
 *
 * 该文件只做类型检查（tsconfig.json 的 include 覆盖 test/types），不参与打包与测试发现。
 */
import type {
  DshBundleManifest,
  DshClientManifest,
  DshManifest,
} from '@deepseek-ai/dsh-package-manifest'
import packageJson from '../../package.json' with { type: 'json' }

/** dsh 段（含 bundle / client / profile 等角色）必须可赋值给官方声明。 */
export const manifest: DshManifest = packageJson.dsh
export const bundle: DshBundleManifest = packageJson.dsh.bundle
export const client: DshClientManifest = packageJson.dsh.client

/** 未在官方声明中的字段必须编译失败：多写 `requires`、`injects` 之类都会被拦住。 */
type UnknownDshKeys = Exclude<keyof typeof packageJson.dsh, keyof DshManifest>
type UnknownBundleKeys = Exclude<keyof typeof packageJson.dsh.bundle, keyof DshBundleManifest>
type UnknownClientKeys = Exclude<keyof typeof packageJson.dsh.client, keyof DshClientManifest>

export type ContractCheck = [
  UnknownDshKeys extends never ? true : never,
  UnknownBundleKeys extends never ? true : never,
  UnknownClientKeys extends never ? true : never,
]

/**
 * 实例化上面的条件类型：类型别名是惰性的，必须真正赋值才会求值。
 * package.json 出现未声明字段时 ContractCheck 求值为 never，本行立即编译失败。
 */
export const contractCheck: ContractCheck = [true, true, true]
