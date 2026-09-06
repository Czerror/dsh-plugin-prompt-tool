# dsh-plugin-prompt-tool 仓库规则

本文件只保留跨任务的仓库边界、工具约束、验证和交付规则。具体框架说明按任务路由到对应文档，不在这里复制。

## 全局规则

- 思维链和回答使用简体中文。
- 所有 shell 指令使用 PowerShell 7：D:\App\PowerShell\7\pwsh.exe；禁止调用系统 Windows PowerShell 5.1。
- 只能使用 Codex 内置编辑器直接编辑文件；禁止用脚本做文本替换。
- 只有用户明确要求“查经验/recall/记一下/remember”等记忆操作时，才读取 mnemon 技能并执行记忆读写；不得保存 token、密码、密钥等秘密。
- 不修改 DeepSeek Harness 源码仓库；插件只通过本仓库的 cordis.patch.yml、package.json#dsh、已发布的 @deepseek-ai/* 包和 DSH profile 装配。

## 任务路由

开始修改前，按触发条件读取唯一权威文档：

| 触发条件 | 权威文档 |
|---|---|
| 修改 src/client、SlotRegistry、SettingsScope、工作台、客户端 bridge、状态、共享 UI、CSS 或 UI 测试 | [docs/ui-architecture.md](docs/ui-architecture.md) |
| 修改 params、preset.yml、预设存储、writePreset、迁移、空值或参数生成链路 | [docs/architecture-params.md](docs/architecture-params.md) |
| 修改 engine、晋升门控、PTC、插入点、组合来源或重建 | [docs/engine-reuse.md](docs/engine-reuse.md)；组合编辑同时读 [preset/creative/skills/editing-cordis-compositions/SKILL.md](preset/creative/skills/editing-cordis-compositions/SKILL.md) |
| 修改 SillyTavern、角色卡或世界书转换 | [docs/SillyTavern.md](docs/SillyTavern.md) |
| 涉及宿主 API、Cordis 生命周期、Settings、Slot 或官方预设契约 | 先在 `D:\AI\GitHub\deepseek-harness\docs` 搜索对应服务或 API；本地文档缺失或与已安装包版本不符时，再查 [在线镜像](https://github.com/deepseek-ai/deepseek-harness/tree/master/docs) |

## 产品边界

项目是位置、时机与受众可配置的提示词注入引擎。promptConfigs 按自身声明的官方插入点按需注册，预设组合行为；不同插入点没有插件自定义的全局运行顺序。PTC、首轮锚定、router-guide、Flash 路由及其他模型增强保持可选或 opt-in。

## 环境与验证

测试和脚本从隔离 cwd 执行，不能把仓库目录作为测试 cwd：

    $Repo = 'D:\AI\GitHub\dsh-plugin-prompt-tool'
    Set-Location 'D:\AI\workspase\_temp'

常用命令以 package.json scripts 为准；交付前至少运行：

    pnpm --dir $Repo typecheck
    pnpm --dir $Repo lint
    pnpm --dir $Repo test
    pnpm --dir $Repo build
    git -C $Repo diff --check

只改文档时运行 `git -C $Repo diff --check`，并核对文档中的路径、链接和命令。

- 非平凡分支、解析器、状态迁移、文件写入和安全边界必须有最小确定性回归测试。
- 测试优先使用 Node 内置 test runner 和现有 helper；仅有明确收益时新增框架或依赖。
- 文件系统测试使用独立临时目录和临时 `DSH_HOME`，结束后清理，且不依赖共享状态或执行顺序。
- 修改参数、bridge、UI slot、engine、预设或生成器时，运行对应的 shared/client/engine/host/presets 契约测试；最终交付仍执行完整 test。
- 共享门控、提示词引擎或组合的验收覆盖主会话、子代理、压缩后重晋升和 disposer。
- 验收以注入层、位置、时机、次数、受众和 epoch 断言为准，不用模型措辞或分数代替行为测试。

## 仓库级硬约束

### 入口与生命周期

- src/index.ts 只做编排和宿主适配；host、runtime、client、shared 的细节放回所属模块。
- inject 只使用字符串数组；可选或晚到服务用 ctx.inject([...], callback) 等待。
- agentPresets 负责官方会话预设切换与同步；webServer 不放入静态入口 inject，按现有 ensureWebSurface() 路径处理。
- 监听器、工具、watcher 和动态服务挂在 ctx.effect 或 disposer 上；重挂前释放旧实例。
- 仅依赖已发布的官方包和 node_modules 类型；相对 TypeScript import 保留显式扩展名，纯类型依赖使用 import type。
- Skills、SillyTavern、角色卡、世界书和自定义工具复用既有 provider、host 工厂和 rebuildPreset()，不在 UI 复制转换或热装配通道。
- 修改源文件后通过 package scripts 重新生成 `lib/`、`engine/compositions/library/` 和 `engine/vendor/yaml/`；这些生成目录不手工编辑或提交。

### 配置、写盘与安全

- preset.yml 是具体预设行为的单一来源；settings 只承载部署轴，复杂数据和大文本走文件或 loopback bridge。
- 所有 YAML 修改使用 yaml Document API 保留注释和未知字段；写盘先完整生成临时目录，再原子 rename，system 目录保持只读。
- 只写 DSH_HOME 下本插件拥有的状态、生成目录、.engine 指纹和 .characters；不得清理其他用户或官方文件。
- 生成到用户目录的 AGENTS.md 只更新受管块并保留其余内容。
- bridge 路径和载荷先改 src/shared/bridge-contract.ts，再同步 host、client 和契约测试；成功/失败载荷保持统一包装，写入端点先做白名单、类型、数值和大小校验。
- secrets、token 和大文本不进入 settings descriptor；保留 loopback、Host/Origin 校验和请求体上限。

## 运行中的 DSH 服务

- 会话期间不停止、重启或终止当前 dsh / dsh web，也不抢占其端口。
- cordis.patch.yml、bundle 或 profile manifest 变化若需重启，只在交付说明标注“需要用户重启 DSH 服务后生效”，由用户决定。
- 可以刷新页面、做只读 HTTP 探测，或用隔离 DSH_HOME 与随机端口启动独立 smoke 环境。

## Git 与交付

- 保留用户已有改动和现有历史，不执行 reset --hard、clean、checkout 覆盖或其他破坏性操作。
- 每次完成修改并通过验证后，在同一轮创建中文 Conventional Commit，并推送 origin/dev；未经明确要求不切换或推送 main，不创建 PR。
- 提交前只暂存本次任务文件，检查 diff、验证结果和工作树；本地记忆不入库。
- 行为变化同步 README 或对应权威文档；长期文档只记录稳定行为。
- 推送失败时保留本地提交和现有历史，并报告原因。
- 交付结论用简体中文列出修改内容、验证命令、提交 SHA 和推送分支；若需重启 DSH、重新链接 profile 或重建预设，明确标注。

## Agent skills

### Issue tracker

Issue：创建、读取、拆分或推进任务时，先读 [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md)。

### Triage labels

Triage：分类 Issue 或变更 triage 状态时，先读 [docs/agents/triage-labels.md](docs/agents/triage-labels.md)。

### Domain docs

Domain：探索代码、维护领域词汇或记录架构决策前，先读 [docs/agents/domain.md](docs/agents/domain.md)。
