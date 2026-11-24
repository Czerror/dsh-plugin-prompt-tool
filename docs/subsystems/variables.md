# 持久变量与模板求值

变量窗口中的空字符串会覆盖低优先级的同名值。删除键才会回退。模板可以读取多个域，每次求值只向一个持久域提交；提交前校验所有实际读取域的版本。

## 持久变量事务

变量是扁平字符串。module 覆盖 global；模块值 `''` 是有效覆盖，删除模块键才回落全局。global 只在同一 DSH_HOME 共享；不同安装隔离。`variables` 与共享参数允许同名但互不清理。

裸引用与 `effective` 条件按 session→module→global 取值，空串保留、删除才回落。显式 module/global 只在其约定范围内取值。session 按模块规范目录与真实 sessionId 隔离，主子与不同会话各自持有。工作台和 bridge 只编辑 module/global，不接受任意会话 ID。

session 的唯一 owner 使用官方 `storageDomain`（`@deepseek-ai/dsh-storage-domain`），同步读已校验快照，异步写等待持久化。一条记录拥有完整变量表、CAS revision 与逐键更新时间；首次写复用目标队列，跨域依赖仍按全局→模块锁顺序持锁至写入完成。同步 module/global 提交也校验实际读取的 session 版本。域不随模块导出或 Session 日志导出，不自动从父会话继承；官方后端不承诺多进程同时写同一域。

宿主须提供 storageDomain 及其后端；插件通过可选注入等待，不自行更改 profile。缺失时 session 写入明确拒绝，旧 module/global 继续工作。卸载拒绝新写并等待已开始的持久写；提交开始后取消不能回滚已持久结果，不重放已提交赋值。

模板缓存复用与异步提交完成后均重核变量总闸和原owner身份；成功凭据保留，撤权只抑制正文。变量／mark工具已持久但失去发布资格时返回 `persisted: true, publicationSuppressed: true` 与版本，不附变量或mark正文，也不伪报未写入。

`readModuleVariables` 返回 `{ module, global, effective, revisions, enabled }`；版本域是 global、module、settings。全局文件缺失为空且 revision:null，损坏 YAML、非法 UTF-8、链接或读取错误必须报告，不能当成空表覆盖。模块值仍通过完整定义事务提交。

`editModuleVariables` 每次只写一个 scope，支持完整 values 或局部 changes，二者不混用。changes 中 null 删除，字符串（包括空串）写入。更新内容要求目标域 revision，开关要求 settings；模板额外校验所有实际读取域。锁顺序固定全局→模块，单域原子提交，不创建跨文件 journal。

例如 module.inc 从 global=10 回落计算11，提交前也须核对 global revision；不能仅校验模块版本。变量名拒绝原型键、保留名及非法空白，值/总量有界；具体上限由存储校验器拥有。

`/module-variables` 接受 scope、完整 variables、enabled、expectedModuleId、expectedRevisions。工具 `module_variables` 提供 list/get/set/delete；set 必须显式字符串 value，delete 只删除指定域键。全局写同样需要实际装配工具权限和受控目标。

模块变量随本地提交版本保存，保留独立的值与开关版本。纯值更新从来源动态读取，继续使用既有装配。开关只控制所属模块的求值和模板写入，保留持久值。开关变化登记运行发布。发布失败时保留 `publicationPending`，通过 `refreshOnly` 重试发布。

bridge 的变量保存与重试由 `BridgeRuntime` 统一组织，开关变化进入装配通道的同一后台调度器；路由只负责授权、载荷校验与响应。普通读取和 bootstrap 共享变量视图，读取不触发开关重试，也不新增 `persisted`；仅值更新不顺带重试此前失败的开关发布。后台运行失败归入 `/meta` 的 `publicationFailures`，不写入变量草稿的待发布状态。

## 模板求值

普通规则只引用作者已建立的变量，不自动扫描创建；工作台变量卡手动添加空占位。ST 导入是自动登记的独立入口：正文/触发键的缺失裸引用登记为 `''`，不猜测业务值。原动作 config.variables 已退役，无冲突值可在显式转换时提升到模块 variables；同名不同值必须先解决。

`params.templateEvaluation: true` 启用原生 module/global/session 的 set/get/add/inc/dec。set/add 不输出，inc/dec 输出结果；裸引用与 session.get 按会话→模块→全局，module.get 按模块→全局，global.get 只访问全局。带非空默认值的 get 保留缺值写回扩展。session 值作为字面数据读取，不递归执行值中的模板；旧 module/global 的递归展开保持。

求值先得到正文和变更集，同卡读取看到暂存写入。一张模板可读多个域但只写一个持久域；双域赋值、非法解析、循环、保留名、原型键或展开预算错误整卡零提交。扫描/预览/SELF只读，不能执行赋值。session 赋值仅用于可等待持久化的规则执行和模型工具；官方同步人设 provider 支持读取新域，但拒绝 session 赋值，旧 module/global 赋值不变。输入/输出和嵌套工作量有界。

真实执行先判规则及动作资格。执行帧按运行 Agent、取消信号、turn/step 边界识别，assembly→pre-step→同执行重挂只提交一次；版本改变不触发同执行重放。成功前可有界重试当前卡且保留随机样本；提交后发布失败只重试发布。跨卡不承诺原子，跨进程任意崩溃不承诺 exactly-once。

同模块的主/子会话共享 module/global，session 独立；结束会话、压缩、卸载或重挂不清空。普通前后缀不改变 pick 的稳定选择。`runtime.get` 只读同源运行事实，不回落用户同名值，不接受赋值或写回默认值；不可用不冒充空串或零。未知普通引用的出口清洗不创建变量，具名空值则直接替换为空。
