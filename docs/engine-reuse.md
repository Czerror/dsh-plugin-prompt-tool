# 统一规则引擎复用指南

模块定义经规则编译器校验，再在官方宿主的作用域内绑定条件、注册来源并执行。模块拥有规则、正文和配置，宿主拥有会话、官方预设和各执行点。模块启停沿来源装配，运行状态和释放责任随真实 Agent 或进程的作用域。

| 要查的问题 | 入口 |
| --- | --- |
| 保存后怎样发布，失败怎样恢复，怎样在别的项目装配引擎？ | [装配、发布与跨项目复用](subsystems/engine-assembly.md) |
| 会话压缩后，带会话去重的规则会再注入吗？ | [历史读取与去重](subsystems/engine-rules.md#历史读取与去重)及同页的晋升重建 |
| 条件何时求值，插入点和同点顺序怎样决定？ | [规则条件与动作边界](subsystems/engine-rules.md#规则条件与动作边界)。官方载荷与求值窗口见[插入点契约](injection-point-contracts.md) |
| 宿主动作由哪个作用域接收，何时生效？ | [宿主控制动作](subsystems/engine-host-controls.md) |
| 工具怎样呈现和执行，Team 如何管理子任务？ | [工具呈现、执行与 Team 委派](subsystems/engine-tools.md) |
| 检索如何授权，SELF 如何投递和维护？ | [授权检索、上下文溯源与 SELF](subsystems/engine-context.md) |

参数定义与磁盘保存见[参数架构](architecture-params.md)。

## 原章节链接

- <a id="规则编译与发布"></a> [规则编译与发布](subsystems/engine-assembly.md#规则编译与发布)
- <a id="编译与作用域绑定"></a> [编译与作用域绑定](subsystems/engine-assembly.md#编译与作用域绑定)
- <a id="保存热更新与失败恢复"></a> [保存、热更新与失败恢复](subsystems/engine-assembly.md#保存热更新与失败恢复)
- <a id="原生运行与工具面"></a> [原生运行与工具面](subsystems/engine-assembly.md#原生运行与工具面)
- <a id="工具能力与公开入口"></a> [工具、能力与公开入口](subsystems/engine-assembly.md#工具能力与公开入口)
- <a id="内置资产与用户覆盖"></a> [内置资产与用户覆盖](subsystems/engine-assembly.md#内置资产与用户覆盖)
- <a id="执行状态与接入"></a> [执行状态与接入](subsystems/engine-assembly.md#执行状态与接入)
- <a id="统一入口与模块职责"></a> [统一入口与模块职责](subsystems/engine-assembly.md#统一入口与模块职责)
- <a id="插件侧怎么引入引擎类型边界"></a> [插件侧怎么引入引擎（类型边界）](subsystems/engine-assembly.md#插件侧怎么引入引擎类型边界)
- <a id="引擎契约加载器视角"></a> [引擎契约（加载器视角）](subsystems/engine-assembly.md#引擎契约加载器视角)
- <a id="默认身份接管"></a> [默认身份接管](subsystems/engine-assembly.md#默认身份接管)
- <a id="复制协议跨项目复用"></a> [复制协议（跨项目复用）](subsystems/engine-assembly.md#复制协议跨项目复用)
- <a id="重建与验证"></a> [重建与验证](subsystems/engine-assembly.md#重建与验证)
- <a id="规则条件与动作边界"></a> [规则条件与动作边界](subsystems/engine-rules.md#规则条件与动作边界)
- <a id="字词句确认与动作关联"></a> [字词句确认与动作关联](subsystems/engine-rules.md#字词句确认与动作关联)
- <a id="条件判定与事件载荷"></a> [条件判定与事件载荷](subsystems/engine-rules.md#条件判定与事件载荷)
- <a id="提示词配置插入点与顺序"></a> [提示词配置插入点与顺序](subsystems/engine-rules.md#提示词配置插入点与顺序)
- <a id="同-scope-内的注册顺序2026-09-22"></a> [同 scope 内的注册顺序（2026-09-22）](subsystems/engine-rules.md#同-scope-内的注册顺序2026-09-22)
- <a id="历史读取与去重"></a> [历史读取与去重](subsystems/engine-rules.md#历史读取与去重)
- <a id="晋升语义epoch-aware"></a> [晋升语义（epoch-aware）](subsystems/engine-rules.md#晋升语义epoch-aware)
- <a id="上下文激活与诊断"></a> [上下文激活与诊断](subsystems/engine-rules.md#上下文激活与诊断)
- <a id="pre-step-协调器与官方指令过滤"></a> [pre-step 协调器与官方指令过滤](subsystems/engine-rules.md#pre-step-协调器与官方指令过滤)
- <a id="宿主控制动作"></a> [宿主控制动作](subsystems/engine-host-controls.md#宿主控制动作)
- <a id="工具结果裁剪"></a> [工具结果裁剪](subsystems/engine-host-controls.md#工具结果裁剪)
- <a id="会话回退与待办"></a> [会话回退与待办](subsystems/engine-host-controls.md#会话回退与待办)
- <a id="messages-当前系统正文"></a> [Messages 当前系统正文](subsystems/engine-host-controls.md#messages-当前系统正文)
- <a id="请求身份与系统角色"></a> [请求身份与系统角色](subsystems/engine-host-controls.md#请求身份与系统角色)
- <a id="消息形状容错"></a> [消息形状容错](subsystems/engine-host-controls.md#消息形状容错)
- <a id="当前系统快照"></a> [当前系统快照](subsystems/engine-host-controls.md#当前系统快照)
- <a id="provider-hook-决定"></a> [Provider Hook 决定](subsystems/engine-host-controls.md#provider-hook-决定)
- <a id="沙箱升级请求"></a> [沙箱升级请求](subsystems/engine-host-controls.md#沙箱升级请求)
- <a id="审批决定"></a> [审批决定](subsystems/engine-host-controls.md#审批决定)
- <a id="进程直通与构造默认"></a> [进程直通与构造默认](subsystems/engine-host-controls.md#进程直通与构造默认)
- <a id="委派深度与等待上限"></a> [委派深度与等待上限](subsystems/engine-host-controls.md#委派深度与等待上限)
- <a id="文件读取上限"></a> [文件读取上限](subsystems/engine-host-controls.md#文件读取上限)
- <a id="agent-级能力声明的公共原语2026-10-22"></a> [Agent 级能力声明的公共原语（2026-10-22）](subsystems/engine-tools.md#agent-级能力声明的公共原语2026-10-22)
- <a id="工具结果与web功能段"></a> [工具结果与Web功能段](subsystems/engine-tools.md#工具结果与web功能段)
- <a id="工具与参数说明"></a> [工具与参数说明](subsystems/engine-tools.md#工具与参数说明)
- <a id="工具面收窄与按需解锁"></a> [工具面收窄与按需解锁](subsystems/engine-tools.md#工具面收窄与按需解锁)
- <a id="工具呈现present-as"></a> [工具呈现（present-as）](subsystems/engine-tools.md#工具呈现present-as)
- <a id="重复输出安全截断"></a> [重复输出安全截断](subsystems/engine-tools.md#重复输出安全截断)
- <a id="角色委派官方-team-单任务"></a> [角色委派（官方 Team 单任务）](subsystems/engine-tools.md#角色委派官方-team-单任务)
- <a id="自动派工编排官方-team-多任务"></a> [自动派工编排（官方 Team 多任务）](subsystems/engine-tools.md#自动派工编排官方-team-多任务)
- <a id="自定义工具与宿主契约"></a> [自定义工具与宿主契约](subsystems/engine-tools.md#自定义工具与宿主契约)
- <a id="证据准备与资源边界"></a> <a id="soul-证据准备与资源边界"></a> [证据准备与资源边界](subsystems/engine-context.md#证据准备与资源边界)
- <a id="授权与项目身份"></a> [授权与项目身份](subsystems/engine-context.md#授权与项目身份)
- <a id="证据操作与额度"></a> [证据操作与额度](subsystems/engine-context.md#证据操作与额度)
- <a id="授权检索与来源引用"></a> [授权检索与来源引用](subsystems/engine-context.md#授权检索与来源引用)
- <a id="上下文运行时与溯源"></a> [上下文运行时与溯源](subsystems/engine-context.md#上下文运行时与溯源)
- <a id="动态账本上下文与维护心跳"></a> <a id="self动态内容与维护心跳"></a> [动态账本上下文与维护心跳](subsystems/engine-context.md#动态账本上下文与维护心跳)
