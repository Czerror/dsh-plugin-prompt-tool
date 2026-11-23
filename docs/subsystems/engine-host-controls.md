# 宿主控制动作

规则等待真实宿主 owner，依赖观测跟随当前来源、作用域与已接受步骤。字段、默认值和校验由 [宿主控制能力目录](../../engine/host-control-catalog.mjs) 持有。

## Agent 级控制

### 工具结果裁剪

`compaction-tool-result-pruner` 按宿主解析的官方构造器身份发现全部存活 Fiber，并在各 owner 自己的 Context 等待、门控原 Pruner；正式 standard 组合内层 isolate 不影响发现。就绪与停用资格按当前 Agent 的官方 scope 和真实 session 身份核对，其他 Agent 的 owner 不提供就绪。晚到或重挂后在后续正常装配重判，释放立即使旧门控失活。规则解除后下一次官方扫描恢复裁剪，仍在当前上下文里的旧工具结果也会被扫描。第三方外层包装保留。

### 系统段与上下文正文容错

`host-control / message-shape-guards` 的 `value` 为 `true`。普通装配只对受支持的系统段和上下文正文做局部容错，将缺失或非字符串正文归空。合法字符串与相对顺序保留，其余消息形状和持久格式由宿主校验。依赖缺失时暂停相关分支，独立分支继续。

### 进程控制与宿主权限

`command-confine-passthrough` 使用独立进程控制契约。规则 `executionScope` 缺省为 `agent`。进程贡献只接受支持的无条件动作，每模块贡献一次，即使没有活动 Agent 也初始化、观察保存并撤回。

沙箱和审批默认、权限预设、文件写入范围及审批决定由宿主管理。宿主按部署配置确定新会话默认权限，用户的显式选择与既有会话记录保留。

### 委派深度与等待上限

`host-control / delegation-limits` 的 `value.maxDepth` 为非负安全整数，`value.askTimeout` 为 1–2147483 秒的整数。至少声明一项。深度应用于官方委派工具省略该值时，显式值与由外部 provider 管理的子代理沿原路径处理。等待上限应用于官方提问工具显式传入 `timeout: -1` 时，省略和有限值沿宿主原语义。

插件在普通装配中观察真实官方工具的登记。对应工具缺失或已登记且无法验证所有者时，暂停显式依赖该字段的分支，独立分支继续。下次可验证登记后正常重判。参数随已接受的步骤固定，关闭只作用后续步骤。

## 已接受步骤与说明替换

普通 `assembly.target.sections.replace: [{ name, text }]` 原位替换第一个作者名称相同且正文非空的段，保留 order、complete 等官方元数据。目标缺失或没有非空正文时跳过。计划模式可据此编辑 `plan:policy` 全文，真实开关、日志、审批和退出工具仍归官方 planMode。

`sections.replace` 与 `contexts.replace` 都支持非空字面 `match`，要求名称和原文各自唯一匹配，歧义或原文缺失时透传并告警。`sections.keep/remove` 选择所有原名匹配的段，`sections.append` 命中首个原名匹配的段。`contexts.clear` 与上下文替换互斥。官方 `refreshContext` 调用原 provider 后复用该工具步骤已接受的替换，规则热更新只影响后续步骤。审批和沙箱说明属于运行上下文，计划说明属于系统段。文字说明沿原权限所有者执行。

普通请求字段仍由 `request-params.patch`、`unset` 和 `replace` 有序组合，包括 `patch.maxTokens`。旧的顶层 `request-params.maxTokens` 和 `persona.instructionsMaxBytes` 已退役，旧声明会被规则校验拒绝。内置模块已按当前契约更新，自定义模块作者需更新模块文件。

## 文件读取上限

`host-control` 动作可声明 `capability: file-read-limits`。`value` 至少声明 `maxLineLength`、`maxBytes`、`limit` 中一项，已声明值须为正安全整数；分别表示UTF-16代码单元计数的每行长度、包含行间换行和截断后缀的UTF-8输出字节、默认及最大读取行数。未声明字段及 `readStreamMinSize` 保持原owner配置。

额度沿普通条件、受众、完整候选及数字草稿进入当前 Agent 的工具步骤。同一 Agent 的同字段同值共存，不同字段组合。异值候选拒绝，动态冲突拒绝新步骤，已接受步骤保留快照。插件复用官方读取工具工厂、原 owner 及其有效配置，原官方路径、流式读取、解码、资源校验、结果渲染和观测契约继续生效。

插件观察普通装配中真实官方工具的登记。工具已登记且来源无法验证，或依赖服务缺失时，沿原官方读取配置并暂停显式依赖的分支。下次可验证登记后正常重判。关闭只作用于后续步骤，已接受的调用保留其额度快照。
