# 前端 UI V2 重构执行总管

## 授权与基线

- 用户授权：使用 artifacts 中三份 V2 方案执行重构；PLAN.md 只总管，不复制设计细则。
- 基线：`dev@0bbe9869dca212e73c9fef5872c6a659861e1930`，开始时工作树干净。
- [旧 PLAN 原文归档](.scratch/prompt-tool-framework/archive/plan-review-f01-f15-0bbe9869-20260917.md)，Git blob 与基线一致：`ba26ae91efebed332949d2dfe3bdcf44882cf572`。
- 具体目标、取舍和验收直接读取下表方案；仓库安全、宿主与持久化边界仍遵循 AGENTS.md 和 docs/ui-architecture.md。

## 方案路由与分工

| 执行面 | 唯一设计输入 | 写区负责人 |
|---|---|---|
| 通用视觉、控件复用、主题与响应式 | [前端 V2](artifacts/dsh-plugin-prompt-tool-前端设计方案.md) §§2–9 | 视觉代理：全部 CSS；主线程：跨域控件集成 |
| 六页布局、导航、浏览状态、草稿和资源页 | [页面 V2](artifacts/dsh-plugin-prompt-tool-页面设计方案.md) §§3–10 | 页面代理：app/workspace、PromptConfigsEditor/List；主线程：资源页、业务草稿与本地化 |
| 模块卡、菜单、确认、表单与排序 | [模块卡 V2](artifacts/dsh-plugin-prompt-tool-模块卡布局设计.md) §§2–7 | 卡片代理：单卡、共享交互、字段与排序 helper |

每个任务直接按所路由 V2 的验收清单执行和验证。可选迁移按方案门槛决定；有依据的偏差记在下方，不复制一份新规格。代理写区互斥，跨区接口先协调；主线程统一构建、全量验证和交付。

## 执行顺序

1. Wave 0：归档、基线与调用链确认。
2. Wave 1：草稿/危险操作/焦点保护优先；页面、卡片、CSS 按互斥写区并行，主线程完成资源与草稿集成。
3. Wave 2：真实浏览器验证三稿验收项、独立 diff 复核、同步稳定行为至 UI 权威文档。
4. Wave 3：完整门禁、更新本计划和本地项目记忆，只暂存本次文件，中文 Conventional Commit，推送 origin/dev。

## 验证与回滚

所有命令使用 PowerShell 7，测试和脚本 cwd 为 `D:/AI/workspase/_temp`：

```powershell
$Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
Set-Location 'D:\AI\workspase\_temp'
pnpm --dir $Repo typecheck
pnpm --dir $Repo lint
pnpm --dir $Repo test
pnpm --dir $Repo build
git -C $Repo diff --check
```

每项非平凡交互以最小行为反例验证；浏览器复用现有 Edge/CDP fixture、独占 profile 和随机端口。截图与详细测试产物放临时目录，计划只索引结果。运行中的 DSH 不停止或重启。

回滚以任务差异的反向补丁或后续 revert 为单位，不回滚用户预设/指令正文，不覆盖用户新改动。客户端构建后刷新生效；若实际涉及服务重载只在交付说明中标注。

## 进度、证据与偏差

- 基线 `pnpm --dir $Repo test`：986/986 通过，0 失败/跳过；包括构建。
- 2026-09-17 用户纠正：PLAN 仅路由与总管，设计细则以 artifacts V2 为准；已执行。
- 用户追加截图问题：长预设名挤压「使用中」胶囊；修复共享徽章收缩与换行，实际CSS浏览器回归覆盖原图两个名称、160/240px容器与200%文字放大，先红后绿。
- 用户视觉取舍：恢复状态圆点原有6px核心和3px柔和静态光晕，覆盖V2去光晕建议；胶囊不收缩/不换行的修复保留，不恢复循环动画。
- 用户追加主题问题：模块列表吸顶操作区在透明背景主题下难辨识；改为系统Canvas不透明基底叠宿主表面，透明/半透明/缺省变量在明暗配色下均有真实CSS回归，先红后绿。
- 用户追加过滤问题：真实鼠标focusout后的微任务提前卸载菜单，使选项click丢失。MenuSelect识别菜单内relatedTarget，卡片/策略离焦延后一帧确认逻辑归属；新增原生鼠标按下/抬起回归，选择不再固定为「全部」。
- 已实现三稿路由中的卡片、页面、草稿、资源与视觉改造；可选Input/DisclosureRow/Modal/StateDot整体迁移未强行采用，保留已有行为并复用官方Switch、Menu、Tag与按钮。
- 最终typecheck、lint、test、build与diff --check均通过；静态光晕恢复后的test为992/992，0失败/跳过。指令文件保存链路31/31；真实页面、草稿、卡片与胶囊回归通过。
- 真实样式证据：`D:/AI/workspase/_temp/ui-v2-visual/report.json`及同目录截图，64个明暗/窄宽/短视口/中英文/文字放大/触控/forced-colors/reduced-motion场景；主线程已回读截图并修正定位导致外层容器滚动的问题。使用实际CSS Modules及0.1.6-alpha.1主题/primitives；不将此覆盖称为屏幕阅读器或所有平台认证。
- 门禁环境适配：pnpm当前提供原生exe的npm_execpath，测试入口补原生启动分支，避免Node把exe当脚本；测试/生产行为不变。
- 三份artifacts/V2输入随本轮纳入版本控制，保证PLAN路由链接可复现；不改变artifacts其他生成物的忽略规则。源码无需重启DSH，客户端刷新加载新构建。

## Wave 状态

- [✔] Wave 0：旧 PLAN 完整归档、基线验证、设计路由与写区明确。
- [✔] Wave 1：卡片交互与排序。
- [✔] Wave 1：工作台、列表与浏览上下文。
- [✔] Wave 1：业务草稿、资源页与文案。
- [✔] Wave 1：视觉与响应式。
- [✔] Wave 2：集成、浏览器验收、独立复核与权威文档。
- [ ] Wave 3：完整门禁、项目记忆、中文提交与推送。
