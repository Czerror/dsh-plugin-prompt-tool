# 层级配置卡归一

## 需求与授权

- 2026-09-21：用户指出代理请求、工具链、子代理启动层仍通过筛选显示独立设置卡。
- 用户选择「复用层级配置卡：在全部列表直接显示，展开编辑该层设置，不生成提示词规则」，并要求「存在引擎参数时 自动生成该层级的卡片」。
- 基线：58afb9038d76d784fc5a5bea25c753879c6cb2cb；范围仅客户端呈现、对应回归与 UI 文档。

## 审查结论

- P1：PromptConfigList 的 standaloneLayers 在全部视图且无搜索时直接为空，导致有设置但无提示词配置的层没有入口。
- P2：兜底卡手写 article 且默认展开，未复用 PromptConfigCard 的层级卡交互。现有测试锁定旧行为。

## 影响面、依赖与护栏

- PromptConfigList → PromptConfigCard → engineLayerSlots / LayerSettingsContent；按现有共享归属判断设置是否存在。
- 主线程修改源码、Node 回归和文档；子代理独占 module-policy-smoke 与 import-smoke 浏览器测试。最后由主线程统一构建、完整验证、提交推送。
- 保持真实提示词配置的数量、启停、排序、创建、受众及保存载荷；不改 bridge、host、engine、指令文件与当前 DSH 服务。
- 保留既有未跟踪 skills/；本地 .ai-memory 不提交。

## Wave 1：统一卡片与行为回归

<task type="auto">
  <name>T1：自动生成无实例层的配置卡</name>
  <files>PromptConfigList.tsx、PromptConfigCard.tsx、EngineLayersPanel.tsx、locales-prompts.ts、engine-module-cards.test.mjs</files>
  <action>有设置且当前受众没有实例卡时派生层级卡，全部视图直接可见；复用配置卡展开与设置装配，删除独立兜底壳。</action>
  <verify>Node 回归先红后绿：三层默认可见、复用组件、惰性展开、筛选/搜索/受众、无写入、实例让位与空层。</verify>
  <security>只派生展示对象；不进入配置保存、复制、删除、拖拽和批量启停，保持既有写入边界。</security>
  <done>对应确定性回归通过，无独立设置卡渲染路径。</done>
</task>

<task type="auto">
  <name>T2：更新真实浏览器验收与稳定文档</name>
  <files>module-policy-smoke.test.mjs、import-smoke.test.mjs、docs/ui-architecture.md</files>
  <action>更新既有交互至统一层级卡，验证三层从全部视图可达，同步文档。</action>
  <verify>浏览器 smoke 与完整 typecheck、lint、test、build、diff --check 通过。</verify>
  <security>测试在隔离 cwd、随机端口和独立浏览器 profile 下执行，不停止或重启在役 DSH。</security>
  <done>全部门禁通过，现场清理，PLAN 归档，中文 Conventional Commit 推送 origin/dev。</done>
</task>

## 回滚与检查点

- 代码回滚使用本轮提交的 git revert；没有数据迁移。
- 检查点为定向红绿验证、完整门禁和提交前范围核对。

## 状态

- [✔] Wave 1 / T1：复用 PromptConfigCard 自动生成层级配置卡，28 项定向回归通过。
- [✔] Wave 1 / T2：浏览器验收、文档及完整门禁通过；本 PLAN 与代码同批归档提交，推送凭据见交付回执。

## 验收记录

- 红：旧实现的全部视图没有三个 data-layer-config 节点，Node 与新增浏览器回归均失败。
- 绿：`node --test <repo>/test/client/engine-module-cards.test.mjs`，28/28；规模、创建分离、表单与词典定向回归，43/43。
- 子代理：module-policy-smoke + import-smoke，真实 Edge 33/33、0 跳过；主线程完整 test 再次覆盖通过。
- 主线程：`pnpm --dir <repo> typecheck`、`lint`、`test`、`build` 均通过；完整 test 1247/1247、0 失败、0 跳过；`git -C <repo> diff --check` 通过。
- `<repo>` = `D:/AI/GitHub/dsh-plugin-prompt-tool`；测试 cwd 与浏览器 TEMP/TMP 均在 `D:/AI/workspase/_temp`。
- 三层在主/子页面默认可见、默认折叠，模型和工具参数真实保存；不生成提示词规则、不扩大批量启停；有实例让位、搜索、世界书与只读边界保持。

## 实施取舍与已知边界

- 自动层级卡仅为展示投影，不写入 preset.yml；沿用已发布组件、设置装配、字段草稿与保存端点，没有新增依赖或运行时行为。
- lib 已重新构建；组合与 YAML 快照输入未变，本轮没有分发快照差异。客户端更新后刷新页面加载；没有重启在役服务。

## 测试现场与清理限制

- 测试入口与浏览器 helper 自动清理本轮临时目录及 profile，无本轮残留。既有历史临时目录与未跟踪 skills/ 均未触碰。
