# 本层引擎设置 baseline-ui 重构 PLAN

## 需求与授权

- 日期：2026-09-21；基线：`dev / affd09d`（八项复审修复已验证并推送）。
- 用户原话：`完成修复后,继续使用 mcp ui-skills (baseline-ui 技能)重构 本层引擎参数的设置的UI`。
- 已通过MCP读取baseline-ui；范围限定本层设置的布局、层次与可访问性。用户已明确要求执行该UI重构；沿用仓库CSS Modules、clsx及官方组件/主题变量，按已有自定义样式约定落地，不新增样式或交互依赖。

## 审查结论

- 层设置内容直接作为12列配置网格子项，分组没有明确列跨度，短参数与长文本宽度缺少区分。
- 参数分组、已装配能力和资产编辑器使用相同弱标题，设置层级难辨；移除按钮与能力名称缺少独立对齐。
- 验收要覆盖真实CSS与窄容器，不能只用替换CSS的React行为夹具证明布局。
- 实施后双轴复核：规范轴0项、需求轴0项未闭合发现；共享草稿键、订阅、保存回调、搜索与只读均保持。需求轴隔离复跑13项通过，主线程继续完整门禁。

## 影响面、依赖与护栏

- 只改变EngineLayersPanel设置布局与EngineParamFields呈现属性，保持值、草稿键、只读、搜索、保存、默认折叠、实例身份和九层运行时语义。
- 复用原生details、官方Switch/Menu、现有ConfirmDialog；不加动画、渐变、状态库、API或依赖。
- UI执行代理独占EngineLayersPanel.tsx、专属CSS及EngineParamFields.tsx；主线程独占测试、文档、PLAN、记录与提交。
- 测试cwd及临时根为 `D:\AI\workspase\_temp`，不触碰真实DSH配置，不启停在役服务；源码通过既有build更新lib，不手工编辑产物。

## Wave 1：设置布局与层次

```xml
<task type="auto">
  <name>T1：重构设置呈现</name>
  <files>EngineLayersPanel.tsx；本层设置专属CSS；EngineParamFields.tsx（必要呈现属性）</files>
  <action>设置根占满容器，分组标题明确；宽容器短控件双列、长文本/列表/阶段整行，窄容器单列；能力操作独立对齐，复用主题、焦点和错误状态。</action>
  <verify>类型检查；既有搜索/只读/折叠/镜像草稿行为测试保持；主线程真实CSS验证布局。</verify>
  <security>不改保存、授权与执行边界；保留hidden显示守卫、无障碍名称、键盘操作和现有删除确认。</security>
  <done>布局符合baseline-ui并保持全部行为契约。</done>
</task>
```

## Wave 2：验收与交付

```xml
<task type="auto">
  <name>T2：真实样式与完整门禁</name>
  <files>真实CSS浏览器回归；必要夹具；docs/ui-architecture.md；CHANGELOG；本PLAN；本地记录</files>
  <action>复用现有Edge与CSS编译夹具，测宽窄容器、无横向溢出、隐藏参数、键盘折叠、就地错误；复核截图及差异后同步文档并归档提交推送。</action>
  <verify>隔离执行typecheck、lint、test、build、git diff --check；真实CSS与截图检查。</verify>
  <security>隔离临时环境后清理；不提交lib/.ai-memory/用户skills，不重启DSH，不把401当GUI验收。</security>
  <done>行为和布局证据通过，中文提交推送origin/dev。</done>
</task>
```

## 回滚与检查点

使用本轮提交git revert，不回退affd09d的功能修复。过程以本PLAN和工作树为准，不保留额外整理进度系统。

## 状态

- [✔] Wave 1 / T1：3个源码文件完成，沿用宿主组件和主题；默认折叠、只读、搜索、草稿与保存语义保持。
- [✔] Wave 2 / T2：双轴复核均0项未闭合问题，主线程真实CSS和完整门禁通过；本PLAN归档随代码提交。提交推送凭据以git历史和交付回执为准。

## 验收记录

- 执行环境：PowerShell7；测试cwd为 `D:\AI\workspase\_temp`，独立DSH_HOME/TEMP/TMP并finally清理。
- 子代理类型检查及原有表单/层设置46项通过；主线程新增阶段DOM身份回归、生产表单真实CSS回归。
- 真实CSS通过860/420/320px容器的双列/单列、整行文本、无横向溢出、隐藏组守卫；原生details用完整CDP键盘事件展开；非法数字就地提示且0保存，改为合法值后1次保存。
- 深浅色最终截图828×776已由主线程读取复核：分组、短控件双列、文本整行、能力操作对齐；隔离主题补足官方Switch所需令牌，未修改宿主主题。
- 主线程 `pnpm --dir $Repo typecheck`、`lint`、`test`、`build`、`git diff --check` 全部退出0，完整测试 **1241/1241**、0失败、0跳过；host/client均重建。
- 首次新增键盘验收未使用完整char事件而失败，复用既有测试的rawKeyDown/char/keyUp序列后通过；未将夹具输入问题当作产品缺陷。

## 实施取舍与已知边界

- 在役3080无登录上下文，未声称真实已登录GUI验收；使用隔离生产组件、真实CSS和最小深浅色主题验证。
- 保持既有CSS Modules/clsx/官方组件及主题令牌；不因baseline-ui引入新依赖、动画、渐变或新的交互实现。
- 源码改动限层设置呈现和必要无障碍身份，未改参数存储或运行语义；旧8项修复保留在affd09d。
- 构建已更新lib；本会话不启停DSH。前轮宿主修复仍需要用户重启DSH服务后生效，再刷新页面读取新UI。

## 测试现场与清理限制

临时测试根和浏览器profile已清理；主线程复核截图后删除本轮及前轮门禁日志、临时截图。原有未跟踪skills/保留；.ai-memory本地追加不入库。
