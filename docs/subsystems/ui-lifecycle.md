# 工作台宿主接入与生命周期

## 入口装配

`src/client/index.ts` 在宿主上下文安装样式与 locale，装配 ConfigForms、会话适配、工作台数据及手动诊断 owner。样式模块求值只收集样式数据，`ctx.effect` 安装样式并在释放时移除本次创建的节点。连接重置只触发一次 `models` 缓存刷新，失败静默且不阻塞启动。

ConfigForms 的 `mutate` 返回 `false` 时显示失败并保留保存基线。当前会话来自 `ctx.uiSession.adapter.current` 的作用域绑定；模型从官方 sessions 投影读取，通过 `selectModel` 写回。模块编辑主语由每次请求声明，独立于宿主会话预设。目录选择使用 `ctx.uiWorkspace.pickDirectory()`，打开路径使用 `remote.session.openWorkspacePath`。

## Slot 契约

| 官方注册面 | id / key | 位置 | owner | 作用 |
|---|---|---|---|---|
| main + sidebar.panellist | prompt-tool | 侧栏 order 60 | register-workbench | 左侧原生导航与完整主面板成对注册 |
| conversation.view | prompt-tool-workbench | order 20 | register-workbench | 当前会话的提示词工具分页 |
| sidebar.right.pane.tab / .title | prompt-tool | keyed | register-workbench | sidebarRightTabs 注册的右侧工作台及标题 |
| shell.overlay | prompt-tool-data | 无可见内容 | NativeWorkspaceData | 唯一插件级数据 owner；不渲染 DOM、图标或抽屉 |

slot 使用 ctx.slots.inject() 等待声明，再调用 ctx.slots.register()。右侧服务通过 ctx.inject 动态等待，其注册与释放归注入上下文；晚到不阻塞另外两个入口。左侧导航与 main 使用同 key，由宿主选择主面板。模块运行总闸只在画布模块侧栏设置，不另设 settings tab。

注册先通过 `ctx.slots.inject()` 等待槽位声明，再调用 `ctx.slots.register()`。右侧服务通过 `ctx.inject` 延迟接入和释放，左侧主面板与会话分页独立注册。左侧导航与主面板使用同 key，由宿主选择主面板。模块运行总闸 `modulesEnabled` 由 ConfigForms 持有，设置位于画布模块侧栏。

`ctx.workspaceFiles` 的路径域是 workspace，模块的路径域是 DSH_HOME。模块资源由工作台就地编辑。

## 入口与关闭行为

- 左侧栏由宿主选择同 key 的主面板，可沿用宿主最后选中的会话；会话分页与右侧槽位使用宿主传入的真实 `sessionId`。
- 右侧工作台使用官方 tab 注册，以 `useTabInfo().tab.visible` 判断可见性。`NativeWorkspace` 合并宿主与文档可见性，隐藏时卸载编辑视图。草稿与保存应答留在独立 `WorkspaceStoreOwner`，隐藏右侧 tab 不改变操作会话。未打开工作台时不读取完整编辑数据，页面刷新会释放内存草稿。
- 三个入口共享辅助面板、筛选、选中节点、画布视角及滚动位置，按会话在内存保留浏览状态，不写 URL 或 localStorage。指令正文按操作会话的 `contextId` 隔离，指令策略沿用工作台共享版本与保存队列。

### 手动诊断

关闭入口、切页、挂载和筛选均不触发诊断。诊断侧栏的「运行诊断」按钮每次调用规则诊断一次，并在有 `sessionId` 时调用上下文诊断一次；无会话时只读规则并提示上下文不可用。同一连接共享 busy、结果及成功时间。在途点击不排队，配置或连接变化只标记失效，无补刷、计时器和自动重试。

规则统计覆盖全仓，上下文快照按请求会话展示。失败保留同目标上次成功结果，其他会话的结果不会回填；缺少 `configs` 时提示不可用，`dropped` 非零时显示未保留条目数。释放或连接重置后旧响应失效。面板分区默认折叠，规则记录按模块分组，上下文记录按激活阶段分组。展开才挂载明细，定位节点后可从「诊断」返回原记录。

### 规则卡上的运行观测

默认身份接管通过人设动作的 `stripDefaultIdentity` 声明。规则卡使用手动诊断的 `/rule-diagnostics` 装配观测，按动作、真实 Agent、已保存版本与正文草稿状态匹配，并显示最近成功时间。成功来源发布、释放及启停哈希回环使旧观测失效；正常未选分支不抵消有效成功，失败保持可见。关闭、未经验证与匹配失效均不显示成功，匹配失效不计为条件缺事实。结果规则的 `tool:results` 诊断同样检查当前目标、已保存 `definitionRevision` 和草稿状态；保存确认只代表编辑意图。

## 桌面接入

工作台使用同一 Slot 与客户端服务。装配缺席时核对[桌面插件装配与客户端 roster](../desktop-plugin-contract.md#2-插件在桌面版的装配链)；桌面路径与原生选择器适配见[桌面适配约束](../desktop-plugin-contract.md#7-适配约束)。
