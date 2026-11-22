# Settings Bridge 契约

## 端点和载荷

[bridge-contract.ts](../../src/shared/bridge-contract.ts) 持有 `/api/prompt-tool/settings`、`BRIDGE_ENDPOINTS`、`BridgeRequestMap`、`BridgeValueMap` 和 `BridgeExtrasMap`。`BridgeResponse<K>` 将端点的扩展字段与 `value` 平铺。`bootstrap` 和 `describe` 扩展字段不同，`describe` 不带 `meta`、`promptConfigs` 等会话段。条件存在的扩展键标 `?` 并记录缺席条件。

客户端用 `data/bridge-client.ts` 的 `bridgeCall(endpoint, body, subject?)` 和 `bridgeUpload`，按端点键声明每次调用目标。新增或改名先改共享契约，再同步服务端注册、客户端调用和 [契约测试](../../test/shared/bridge-contract.test.mjs)。

[bridge-request-shape.ts](../../src/shared/bridge-request-shape.ts) 的 `BRIDGE_REQUEST_FIELDS` 与请求类型双向对齐，JSON 顶层未知字段统一拒绝为 400 `bridge-request-invalid`，错误点名多余字段。`body: 'none'` 对应 `undefined`，事务不读也不排空原始流，文件上传端点自行读取。领域 handler 持有类型、枚举、互斥、身份、版本、读写组合与嵌套校验。`ruleDiagnostics` 接 JSON，但拒绝任何顶层字段。Agent 工具单用自己的字段集，斜杠命令使用 TUI 语法。

`paramOverrides` 的 `expectedModuleId` 由归属门读取。退役的 `triggers` 保留 410 路由。

## 模块主语策略

`x-module-id` 是唯一目录目标。`readSubjectHeader` 区分合法 ID、完全缺席及非法值；空白、重复头、非字符串、超长及非法字符均为非法值。`bridge-runtime.ts` 在事务边界通过后统一返回 400 `module-identity-invalid`，覆盖任一端点策略。

[BRIDGE_SUBJECT_POLICY](../../src/shared/bridge-contract.ts) 驱动客户端类型与服务端归属判定。`required` 调用必须给模块 ID，服务端缺头返回 400 `module-dir-unavailable`；`optional` 允许省略，按各端点处理；`none` 的合法主语头会被忽略。声明不到有效目标时，模块端点不回退到启用集合首项或包内同名模块。

空主语的 `bootstrap` 只返回全局段、指令卡和会话事实；`moduleParams`、`moduleFacts`、`variables` 整键缺席，`overrides` 为空，`templatePreStepCount` 为 0。`paramOverrides` 的空主语选择存储根 `config.yml` 的 `layerSettings`。全局层不可解析时，读取与装配按无全局层继续并从 `meta.moduleWarnings` 暴露诊断，写入返回 400 并保留原文件。

`subjectGate` 按顺序执行主语要求、用户目录写权限（拒绝为 403 `module-readonly`）、定义及层配置形状、读取声明和两次身份校验。`moduleDelete` 与 `mutate` 跳过形状校验以允许删除坏模块及调整总闸。头与载荷不一致返回 400 `module-subject-conflict`，解析目录或载荷与当次目标不符返回 409 `module-changed`。形状豁免仍执行身份校验。

按 `DECLARED_SECTIONS` 约束有主语的读取，未声明节返回 400 `module-not-declared`，坏定义沿既有错误返回。全局变量读取可跳过声明校验。写入建立所需节，不要求既有声明。客户端读取 `meta.modules[].declares` 与 `/bootstrap` 的声明投影，按节决定发不发读请求，未声明时渲染空内容并提供创建。写入身份确认由 `expectedModuleId` 承担，目录仍按请求头选择。

Agent 模块工具声明显式 `moduleId`。TUI 的 `/prompt-tool module <模块id>` 及单命令的 `module <模块id> …` 设定发起命令的 Agent 内存主语，单命令前缀覆盖并建立新主语。无主语时拒绝；`src/runtime/tui.ts#sessionSubjects` 持有值，按 Agent 隔离。

## 传输与信任边界

bridge-transport.ts 只负责 HTTP/Blob 传输和结果 shape guard：

    成功：{ ok: true, value, ...可选扩展 }
    失败：{ ok: false, code?, message?, conflicts? }

全部端点经 [`bridge-transaction.ts`](../../src/runtime/bridge-transaction.ts) 注册。事务核对 loopback、Host、Origin、POST 和请求体形状。若提供 Origin，须为 HTTP 或 HTTPS 的 loopback 来源且端口与 Host 一致。事务先判 403 与 405，再校验主语头；通过后由领域 handler 执行业务判断。新增端点继承同一边界，拒绝用例覆盖全表。

JSON bridge 的统一上限为 32 MiB；原始文件上传独立限制为 64 MiB，避免 base64 膨胀。transport 不解析 feature 数据，也不拥有 Fields。

宿主尚未就绪或路由未注册时，HTTP 层可能返回空体或非 JSON 响应；transport 统一转成 `ok: false` 的可诊断桥接错误（含 HTTP 状态码），不把原生 `response.json()` 异常透传给 UI。

写入后的磁盘和发布结果见[客户端保存保护](ui-editing.md#保存保护)。桌面转发和版本证据见[桌面插件接口契约](../desktop-plugin-contract.md)。
