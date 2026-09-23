# PLAN：profile 解析失败的独立修复器

## 需求与授权

- **用户指令（2026-09-23）**：先确认策略「**只用私有层 + 官方 install 通道**」（不写 `<DSH_HOME>/profiles/node_modules` 这一 dsh 运行时拦截层），随后授权实现 `scripts/repair-profile.mjs`。
- **起始基线**：`070192a`。
- **触发事件**：06:30 实例——`profiles/web/node_modules/dsh-plugin-prompt-tool` 的目标为 `..\..\..\..\..\..\GitHub\…`（上溯 6 级，正确为 5 级）→ 悬空 → dsh 打印 `skipping profile bundle` 并跳过整个 bundle。

## 审查结论

| # | 事实 | 依据 |
|---|---|---|
| 1 | **插件无法自愈零号故障**：bundle 解析失败 → dsh 不加载该 bundle → 插件的 `web-surface` 自愈、种子补建、注册全部不执行 | `web-surface.ts` 的自愈挂在插件 `ctx.effect` 上；`skipping profile bundle` 由 dsh 在加载前打印 |
| 2 | dsh 的判定口径是「`createRequire(profile/package.json).resolve.paths(name)` 中任一 `join(search,name)/package.json` 存在」 | `packages/boot/app-boot/src/profile.ts` 的 `packageDirFromAnchor`/`resolveBundleDir` |
| 3 | 只判 `existsSync(linkPath)` 会漏掉本次故障（**链接在、目标不在**） | 实测：`Test-Path` 为 True，`resolve` 失败 |
| 4 | `<DSH_HOME>/profiles/node_modules` 是 dsh 的**运行时解析拦截层**（entry 在该层「占名」、有投影与移除路径），非中立共享目录 | `profile.ts:128`、`profile-resolution/resolver.ts:186`、`profile.ts:116/276`、`profile.spec.ts:769` |
| 5 | 既有 `scripts/link-profile.mjs` 覆盖的是 `@linxin666/*` 家族 + 共享层，**不含本插件、也不写私有层** | 该脚本 `LINK_DIR = <dsh-home>/profiles/node_modules/@linxin666/` |

⇒ 需要一个**独立于插件**、**只写 profile 私有层**的体检/修复器；缺依赖时不自动安装，只提示官方通道。

## 影响面与护栏

| 项 | 内容 |
|---|---|
| 新增 | `scripts/repair-profile.mjs`（含 `--dsh-home` / `--profile` / `--dry-run`）、`test/host/profile-repair.test.mjs`、`package.json` 的 `repair:profile` |
| 复用 | `scripts/link-profile.mjs` 导出的 `resolveDshHomeArg` 与 Windows junction 处理手法（不重复实现） |
| 文档 | README 增「插件未加载时的自查与修复」 |

**硬约束**

- 只写 `<profiles>/<name>/node_modules/`（私有层）；**绝不**写 `profiles/node_modules` 拦截层。
- 真实文件或目录**绝不删除**，只报告并计入退出码。
- 不重装依赖、不调用包管理器；缺依赖只提示 `dsh plugin --profile <name> install`。
- 判据与 dsh 一致（见审查结论 2），并额外报出「链接目标是否存在」这一本次故障的直接原因。
- 幂等：健康项不动；`--dry-run` 零写入。

## Wave 1：修复器

<task type="auto">
  <name>T1：实现 repair-profile.mjs</name>
  <files>scripts/repair-profile.mjs（新增）、package.json（新增 `repair:profile`）</files>
  <action>导出纯函数：`resolveDshHomeArg`（复用）、`dshResolvable(anchor, name)`（照 dsh 口径返回命中的包目录）、`classifyEntry(linkPath)`（missing/symlink/dir/file + 目标是否存在）、`planRepairs(profile)`（逐 bundle 与 `link:` 依赖产出 ok/broken-link/missing/blocked/unresolvable 诊断与建议动作）、`repairProfiles(options)`（执行并可注入 log）。CLI 支持 `--dsh-home`、`--profile`、`--dry-run`，退出码 0/1。</action>
  <verify>见 T2；另跑 `node scripts/repair-profile.mjs --dsh-home <临时目录> --dry-run` 确认零写入。</verify>
  <security>写盘仅限私有层 node_modules 与 `link:` 声明目标；删除只针对链接（junction 用 rmdir、symlink 用 unlink），真实条目跳过；不触碰共享层、其它 profile、dsh 安装目录。</security>
  <done>能对「悬空链接 / 缺链接 / 被真实目录挡住 / 无法解析」给出确切诊断并修复可自动修复者。</done>
</task>

## Wave 2：测试与文档

<task type="auto">
  <name>T2：行为测试</name>
  <files>test/host/profile-repair.test.mjs（新增）</files>
  <action>隔离临时 `DSH_HOME`：造 profile manifest（bundles + `link:` 依赖）与四种链接状态（健康 / 悬空 / 缺失 / 真实目录占用），断言诊断分类、修复后 `dshResolvable` 命中、真实目录未被删除、`--dry-run` 不写入、退出码语义。</action>
  <verify>`node --test test/host/profile-repair.test.mjs` 全绿；`pnpm test` 全量不回归。</verify>
  <security>独立临时目录 + 临时 `DSH_HOME`，结束后清理；不依赖共享状态与执行顺序。</security>
  <done>四类状态各有确定性断言，含「链接在但目标不存在」这一本次故障的直接回归。</done>
</task>

<task type="auto">
  <name>T3：文档与交付</name>
  <files>README.md、CHANGELOG.md</files>
  <action>README 增「插件未加载时的自查与修复」：① 看启动日志的 `skipping profile bundle`；② `pnpm --dir $Repo repair:profile -- --dsh-home <dir> --dry-run` 体检；③ 修复或走官方 `dsh plugin --profile <name> install`。CHANGELOG 记新增脚本。</action>
  <verify>`git -C $Repo diff --check`；文档内命令逐条核对。</verify>
  <security>不写入 secrets。</security>
  <done>文档与该策略（私有层 + 官方通道）一致。</done>
</task>

## 回滚与检查点

- 纯新增（脚本 + 测试 + 文档 + 一个 npm script），`git revert` 即完全回退；无数据侧影响（脚本默认只读，写操作需显式非 `--dry-run`，且仅限私有层链接）。
- 中断检查点：T1+T2 完成即可提交。

## 状态

- [✔] Wave 1：修复器（T1）—— `scripts/repair-profile.mjs` + `repair:profile` 入口；判据对齐 dsh 的 `resolveBundleDir`，并额外报出「链接在、目标不在」
- [✔] Wave 2：测试与文档（T2 / T3）—— `test/host/profile-repair.test.mjs` 8/8；README「排障：插件未加载时」+ CHANGELOG。**范围增补（用户指示）**：移除外来脚本 `scripts/link-profile.mjs` 与 `link:profile`（服务 `@linxin666/*` 家族包、写 `profiles/node_modules` 兜底层，不属本仓库内容）；其 `resolveDshHomeArg` 内联进修复器、用例迁入 `profile-repair.test.mjs`，`profile-assembly.test.mjs` 只保留本插件 web 表层自愈的 5 个契约用例

## 验收记录

- `node --test test/host/profile-repair.test.mjs` → **8/8**，含：`dshResolvable` 与 dsh 同口径、**「链接在但目标不存在」被诊断 broken-link 并修复**（本次故障的直接回归）、缺链接补建、`--dry-run` 零写入、`link:` 声明被真实条目占位时报告 blocked 且不删除、普通依赖真实目录不误判、健康项幂等、`resolveDshHomeArg` 四分支。
- `node --test test/host/profile-assembly.test.mjs` → **5/5**（web 表层自愈契约原样保留）。
- `pnpm test` → **1565/1565**；`pnpm typecheck`、`pnpm lint`（0 warnings / 0 errors）、`pnpm build`、`git diff --check` 通过。
- **真实 profile 只读体检**（`node scripts/repair-profile.mjs --profile web --dry-run`，零写入）：
  - `dsh-plugin-prompt-tool` → `ok`（07:00 手工修复的绝对 junction 已被脚本确认解析正常）；
  - `@linxin666/dsh-perf`、`@linxin666/dsh-web-all` → `broken-link`，目标同为相对深度算错的 `D:\GitHub\dsh-web\packages\…`（与本插件故障同一根因，脚本判定可修复）；
  - `@deepseek-ai/dsh-base`、`dsh-web-app` → `ok-via-ancestor`（私有层未命中，由 `profiles/node_modules` 兜底层解析，不计失败）；
  - 退出码 0，`2 would be repaired, 0 need attention`。

## 实施取舍与已知边界

- **不写共享层**：该层是 dsh 运行时解析拦截层，语义归官方；手放条目与拦截器「占名」的交互（谁优先、是否被投影清理）**尚未实测**，故按用户裁定回避。
- 不自动安装依赖：安装属包管理器职责，脚本只提示官方通道，避免在用户环境里产生第二套安装语义。
- 覆盖范围是「当前 profile 声明的 bundles 与 `link:` 依赖」；被真实文件/目录占位、或声明了非 `link:` 版本却缺失的项，报告后交用户处理。

## 测试现场与清理限制

- 测试与临时环境位于 `D:\AI\workspase\_temp` 与系统临时目录，运行后清理。
- 用户实例只读探测；脚本在用户环境执行需用户显式运行（默认 `--dry-run` 友好）。
