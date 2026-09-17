# 测试归一精简（B 档）执行计划

## 授权与基线

- 用户授权：2026-09-17 在「测试项目过多是否可以归一精简」评估后选择 **B 档（标准整理）**，并批准按 **engine → host → client** 三批执行；每批独立验证与提交，可随时叫停。
- 基线：`dev@f669c501791e3986ee9017b474b92fe05a5c0fd4`，开始时工作树干净。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-ui-v2-f669c50-20260917.md)，Git blob 与基线 `f669c50:PLAN.md` 一致：`faad8853564782326eddc665d7b7cd563a47e92d`。
- 参考项目（只读评估，结论见下）：`D:\AI\GitHub\dsh-tavern`、`D:\AI\GitHub\dsh-web`、`D:\AI\GitHub\dsh-mnemon`。

## 目标与不变量

| 指标 | 现状 | 目标 |
|---|---|---|
| `*.test.mjs` 文件 | 135 | **88** |
| 运行用例 | 967 | **967（不减）** |
| engine / host / client+shared+根 | 25 / 60 / 50 | 17 / 36 / 35 |
| `test/types/*.ts` 编译期契约 | 2 | 2（不动） |

不变量（每批都必须成立）：

1. **覆盖不减**：表驱动只压缩重复断言壳，每条原用例必须仍以一条用例存在；不得删除或弱化断言。
2. **NEVER-TOUCH 零改动**：指令文件读写（授权/白名单/版本冲突/读取失败）、导入预览与回滚、路径穿越、大小上限、桥端点安全面、晋升门控/epoch/disposer、子代理策略、子进程脚手架文件，整文件不参与合并。
3. **不新增测试框架或依赖**：继续用 Node 内置 test runner；不引入 vitest / jsdom / happy-dom / Testing Library（`AGENTS.md`「优先使用 Node 内置 test runner」、`docs/ui-architecture.md` §12.1）。
4. **每批门禁**：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`git diff --check` 全绿，且用例总数不少于上一批，才提交推送 `origin/dev`。
5. 测试仍在隔离 cwd（`D:\AI\workspase\_temp`）执行，临时目录自建自清。

## 参考项目结论（已评估，写入本计划以免重复调研）

| 借鉴 | 出处 | 落地 |
|---|---|---|
| 一个模块/主题一个文件，大文件是常态 | dsh-mnemon（`subagent.spec.ts` 83 用例/2526 行）、dsh-tavern（`inline-message-renderer` 81 用例/2238 行）、dsh-web（`host-ledger.spec.ts` 34 用例/724 行） | 合并单位=主题，不按行数设上限 |
| harness 集中在 fixtures | dsh-tavern `tests/fixtures/helper-*.mjs`（30+）、dsh-mnemon `scripts/fixtures/` | 新增 `test/fixtures/host-harness.mjs`、`test/client/support/*.mjs`，不新建顶层 helpers 目录 |
| 验证 lane 分离 | dsh-mnemon `verify:build` / `verify:headless` / `verify:package` / `verify:docs` | 沿用既有 `verify:host` 与 `scripts/run-tests.mjs`，不新建 lane |
| 浏览器/e2e 与单测分离 | dsh-web `tests/e2e/mount.e2e.ts` + 独立 playwright 配置 | 8 个 Edge smoke 合为 4 个并按 `*-smoke.test.mjs` 命名，仍留在 `node:test` 内 |
| **不采用** vitest / jsdom / RTL / 每包 tests/ | dsh-web、dsh-mnemon | 单包集中 `test/{engine,host,client}`，SSR 渲染 + Edge smoke 替代 jsdom |

## Wave 拆解

### Wave 1：engine 合并（25 → 17）[✔]

7 个合并组，全部为等价搬迁；engine 分片静态断言升级为 0（25 个文件本就走真实模块行为断言）。

| 组 | 成员 → 目标 | 用例 |
|---|---|---|
| E1-1 | anchor-match → `st-world-book.test.mjs` | 26+7=33 |
| E1-2 | meta → `prompt-config-engine.test.mjs` | 62+1=63 |
| E1-3 | tool-git-bash → `preset-engine-modules.test.mjs` | 21+2=23 |
| E2-1 | st-macros + st-render → 新建 `st-render-macros.test.mjs`（表驱动压缩） | 22 |
| E2-2 | session-vars → `interpolate.test.mjs`（表驱动 16→≈10） | 17 |
| E3-1 | skill-search + tool-modules → 新建 `tool-module-mount.test.mjs` | 12 |
| E3-2 | anchor-turn + deliberation-gate + progress-reminder → 新建 `injection-gates.test.mjs` | 10 |

- 验收：engine 目录 17 个 `*.test.mjs`；engine 运行用例 275 条不减；全量门禁绿。
- 调整说明：原方案把 helper 抽取放在批 1；实际以「helper 主要服务 host 分片」为由移到 Wave 2，使 Wave 1 成为**零新增抽象**的纯合并，便于独立验证与回滚。

### Wave 2：host 合并（60 → 36）[ ]

- 新建 `test/fixtures/host-harness.mjs`：`isolatedHome` / `tempDir` / `fakeReq`·`fakeRes` / `bridgeHarness` / `readBridge` / `seedPreset` / `pluginCtx` / `expectUnchanged` / `readPresetYaml`；re-export 既有 `fixtures/preset-template.mjs` 以免改 7 处 import。
- 14 个合并组：write-preset（吸收 writepreset-off）、preset-render-variants、preset-prompt-configs、composition-library、engine-params-bridge、preset-capabilities、subagent-tool-policy、pre-step-injection、pre-step-wiring、skills-provider、sillytavern-convert、model-routing、profile-assembly、preset-content-assets。
- 4 个 KEEP（st-preview-report / tui / version-contract / preset-default-sync）+ **18 个整文件 NEVER-TOUCH**。
- 2 条静态断言升级为行为断言：`models` 的 `llm/adapters-updated` 接线、`web-surface` 的 web-app 常量来源。
- 2 处文档引用同步：`docs/architecture-params.md`（param-contract → engine-params-bridge）、`docs/SillyTavern.md`（st-compatibility → sillytavern-convert）。
- 技术风险与要求：40+ 文件在模块顶层设 `process.env.DSH_HOME`，合并后每文件只能设一次，必须由 helper 统一设置并在 `after()` 还原原值；子进程脚手架（rematerialize / rebuild-composition / official-preset / skills-watcher）原样搬运。

### Wave 3：client 合并（50 → 35）[ ]

- 结构契约 4→1（`client-structure-contract`）、接线契约 5→1（`client-wiring-contract`）、CSS 断言并入 `style-ownership`、编辑态 3→1（`editor-state`）、`hint-tooltip` 2→1、根目录 4→1（`host-publish-contract`）。
- 8 个 Edge smoke → 4（`ui-v2-page-smoke` / `import-smoke` / `module-policy-smoke` / `real-css-smoke`），先合 import 与 module+policy 两组，再合 ui-v2 三合一；每个成员的高风险流程逐条保留。
- SSR 升级（用已有 6 个文件的 `react-dom/server` 范式）：`workspace-navigation`、`menu-select` 用例 1/3、`prompt-config-form-layout` 用例 1/2/3/5、`template-picker-anchor`、`review-fixes` 4 条、`scope-create-separation` 第 11 条；portal / 真实 CSS / 真实鼠标与焦点保留 Edge。
- 保留独立：`style-ownership`、`locale-contract`、禁令类断言（无原生 select、无 `title`/`data-tip`、无宿主 DOM 选择器、依赖方向）。

## 风险与回滚

- 合并后单文件断言量与等待步骤上升（smoke 超时预算需叠加），**失败定位粒度变粗**；Edge 缺失时 `skip` 粒度由单文件变整组。
- 表驱动与 SSR 升级属于"等价重写"，是本计划唯一需要逐条核对覆盖的环节；核对方式：合并前后各跑定向 `node --test`，比较运行用例数与失败信息可定位性。
- 回滚：每批一个中文 Conventional Commit，`git revert <sha>` 即可整批回退；文件内容以拼接与 `git mv` 为主，diff 可逐条核对。

## 执行状态

| Wave | 状态 | 提交 |
|---|---|---|
| Wave 1：engine 25 → 17 | [✔] | `29a30e7` |
| Wave 2：host 60 → 36 | [ ] | — |
| Wave 3：client 50 → 35 | [ ] | — |

（Wave 内任务完成后即时更新为 `[✔]`，并在交付说明中给出提交 SHA。）
