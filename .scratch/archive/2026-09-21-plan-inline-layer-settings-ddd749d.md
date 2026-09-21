# 参数设置仅内嵌真实配置卡

## 需求与授权

- 2026-09-21 用户纠正：「不应该存在该UI卡[子代理启动层配置]，所有参数设置应该内置在『子代理通用守则 / 子代理启动层 · 固定文本』，为空时不创建」。
- 本次纠正取代上一轮自动派生展示卡的决定。基线 ddd749d。
- 移除所有层的自动设置卡；参数继续内嵌真实提示词配置卡。无实例时保留空状态和显式模板创建入口，不自动创建规则或 UI 空卡。

## 审查结论

- P1：PromptConfigList 根据 hasLayerSettings 派生 layerConfigs，使空配置列表出现用户不需要的层级设置卡。
- P2：PromptConfigCard 的 layerSettingsOnly 分支和对应词条仅服务该派生卡，应随路径删除。

## 影响面、依赖与护栏

- 主线程独占客户端源码、Node 回归、UI 文档、PLAN 与本地修改记忆。
- 子代理独占 module-policy-smoke、import-smoke 及其必要 fixture，验证真实模板卡承载参数与空层不创建。
- 不改 host、engine、参数存储、bridge、模板正文、指令文件或在役 DSH 服务；保留未跟踪 skills/。

## Wave 1：删除自动卡并锁定实例内嵌设置

<task type="auto">
  <name>T1：参数设置只在真实提示词实例卡内呈现</name>
  <files>PromptConfigList.tsx、PromptConfigCard.tsx、EngineLayersPanel.tsx、ConfigListWithTemplates.tsx、PromptConfigsEditor.tsx、locales-prompts.ts、engine-module-cards.test.mjs</files>
  <action>删除派生设置卡与专用渲染分支，保留已有实例表单内的设置入口，同步注释。</action>
  <verify>Node 回归先红后绿：空配置有参数也不补卡；真实子代理通用守则内存在设置区；受众、筛选、搜索及批量启停保持。</verify>
  <security>不新增写盘路径；空列表不 patch/save，真实规则身份及保存载荷不变。</security>
  <done>自动卡与独立兜底卡均无生产渲染路径，定向回归通过。</done>
</task>

<task type="auto">
  <name>T2：浏览器交互、文档与完整交付</name>
  <files>module-policy-smoke.test.mjs、import-smoke.test.mjs、必要 fixture、docs/ui-architecture.md</files>
  <action>使用真实配置显式创建/加载的浏览器样本验证内嵌设置，替换上一轮自动补卡预期并同步稳定文档。</action>
  <verify>真实浏览器验证子代理通用守则内编辑参数、空层不创建；typecheck、lint、test、build、diff --check 全通过。</verify>
  <security>所有测试使用隔离 cwd 和随机端口，清理本轮临时目录；不修改既有用户文件或运行中的宿主。</security>
  <done>PLAN 归档，中文 Conventional Commit 推送 origin/dev。</done>
</task>

## 回滚与检查点

- 使用本轮提交的 git revert 回滚代码；不涉及数据迁移。
- 检查点：定向红绿、浏览器验证、完整门禁、暂存范围核对。

## 状态

- [✔] Wave 1 / T1：自动卡和专用分支已删除，实例卡内设置保持；Node 定向反例先红后绿。
- [✔] Wave 1 / T2：真实浏览器、稳定文档、完整门禁均完成；本 PLAN 与代码同批归档提交，推送凭据见交付回执。

## 验收记录

- 红：旧实现空配置列表仍出现派生设置卡；Node 反例失败，浏览器反例实际发现 6 张额外卡。
- 绿：engine-module-cards 28/28；规模、创建分离、表单与词典定向回归 43/43。
- 子代理 module-policy-smoke + import-smoke 真实 Edge 34/34、0 跳过；主线程完整测试重跑验证通过。夹具显式加载真实模板，展开 helper 不创建配置。
- 主线程：`pnpm --dir <repo> typecheck`、`lint`、`test`、`build`、`git -C <repo> diff --check` 均通过；完整 test 1248/1248、0 失败、0 跳过。
- `<repo>` 为 `D:/AI/GitHub/dsh-plugin-prompt-tool`；测试 cwd 与 TEMP/TMP 使用 `D:/AI/workspase/_temp`。
- 核心行为：子代理通用守则内编辑子代理模型温度与 maxDepth，工具链规则内编辑深思参数；保存不新增规则；空列表、层筛选、搜索都不派生卡；只读与批量写入范围保持。

## 实施取舍与已知边界

- 不恢复更早的独立兜底容器。没有真实配置的层从顶部模板菜单显式创建后，再在实例卡内编辑参数。
- lib 已重新构建；组合与 YAML 快照输入未变化。刷新页面加载客户端更新，无需重建预设；在役 DSH 未重启。

## 测试现场与清理限制

- 本轮临时目录、隔离浏览器 profile 均由测试 helper 清理；没有本轮残留，历史临时目录与未跟踪 skills/ 未动。
