# 提示词工具（dsh-plugin-prompt-tool）

把「Anchored Standard + dsh-router-standard 最优组合」做成 DSH 全家桶里的一键安装插件：插件启动时生成并维护 `~/.dsh/.agent-presets/prompt-tool/` 预设，首轮模型请求只看到官方 Minimal 精确双工具——持久 `bash` 与 `str_replace_editor`——和正确的 persona，没有运行时上下文与指令注入；锚定建立后进入 resident 目录，恢复常规注入，并在确认轨迹后注入 `preset.md`。同时提供 Web 界面在线编辑 `preset.md` / `AGENTS.md`、切换全部开关，以及可开关的 skills 技能层。全部通过官方插件接口实现，不修改 DSH 源码。

## 原理

DeepSeek V4 会强烈依赖 API 中可见的**首轮工具目录与 persona** 选择执行轨迹。完整 Standard 目录与自动注入在场会破坏 Minimal 轨迹，而全程 Minimal 又会失去重型工具。本项目把「首次轨迹选择」与「后续完整工具能力」拆开：

1. **干净首轮**：`context-gate` 清空首轮 runtime-context 并剥离自动注入；`tool-bootstrap` 只暴露 Minimal 双工具；`router-first-turn` 按主会话模型替换 persona——Pro 使用训练原句，Flash 自动采用 dsh-router-standard 的 Flash 弱路由人设（build/fix 分类 + 回顾锚 + 反跑题锚 + 先深想再产出）。
2. **晋升**：首次持久 `tool/call` 或 `assistant/message`（先到者为准）落地后，目录进入 resident 集——bootstrap 双工具 + 发现工具 + 已解锁工具；上下文与注入恢复，重型工具经 `dev_tool_search` 按需解锁。
3. **任务引导**：可选 `near-anchor` 在首条真实用户消息后追加一次近距离首句引导（we/let 按任务自动选择）；Flash 主会话晋升后 `router-guide` 按任务复杂度追加每轮深度引导。
4. **提示词注入**：we 锚定确认后把 `preset.md` 作为用户消息注入一次；we 未确认最多等一轮兜底，绝不卡死。
5. **子代理**：目录直接全量放行（仍受调用方工具白名单过滤）；可选 `subagentFlash` 固定 Flash 路由 + 任务分类人设 + 三锚。

阶段全部从持久 session events 推导，resume / reload 不丢失状态。

## 稳定化控制

全部在生成 preset 的 `agent.cordis.yml` 行中配置：

- `bootstrapMaxTokens`：首轮输出封顶。`0` = 本项目默认不设封顶（Web 界面显示 256000，即不设上限）；正整数 = 请求 #1 的 `maxTokens`，晋升后自动剥离，不会焊进后续请求。不锁定 1024，任意正整数均可。
- `context-gate`：未晋升期间关闭两条统一注入路径，pre-step 只保留 claimed 批次 + `allowKinds`（放行用户技能手势与 `near-anchor` / `router-guide`）；晋升后差分恢复一条 runtime-context 消息。
- `tool-bootstrap`：`promoteOn: either` 避免纯文字首答永久困在双工具；compaction 后回到 bootstrap + `compactionTools` 受控阶段。
- `router-first-turn`：只替换 persona 段，保留 plan-mode 段与第三方 section；首轮隐藏 `mnemon:*` 自动注入段，晋升后恢复。
- `near-anchor`：行为引导放在真实用户消息之后（近距离零衰减），只要求首句一次；复杂规划任务放行 Let 深度路径，日常任务锚 We。
- `router-guide`：简单任务快速收敛，复杂任务深度引导；子代理不注入，首轮不注入。
- `prompt-injector`：注入状态以持久事件为准，跨进程重启 / 插件热重载不重复注入。
- `injectAgentsPrompt`：开启时用 `AGENTS.md` 内容替换上游 instruction-hint 提示文本；关闭时保留上游原版 hint。
- `skillSwitches`：扫描 `skills/*/SKILL.md` 注册可开关技能，未列出的技能默认开启。
- `subagentFlash`：检测不到 DeepSeek 模型路由时 Web/TUI 禁用并强制降级为关闭。

## 安装

```sh
# 1. 先安装宿主服务（提供 webServer 等本插件依赖的服务）
dsh plugin --profile prompt-tool add @deepseek-ai/dsh-web-app
# 或使用 dsh-tui：dsh plugin --profile prompt-tool add @deepseek-harness-tui/dsh-tui

# 2. 安装本插件（官方插件指令，自动加入 profile bundles）
dsh plugin --profile prompt-tool add dsh-plugin-prompt-tool

# 3. 本地开发安装（任选其一，会覆盖 registry 依赖）
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>

# 4. 启动
dsh --profile prompt-tool
dsh web
dsh-tui

# 卸载
dsh plugin --profile prompt-tool remove dsh-plugin-prompt-tool
```

装完**完整重启 `dsh web`**，新建空 session，预设选择 **prompt-tool**。插件会在启动时生成并刷新 `~/.dsh/.agent-presets/prompt-tool/`（升级插件后重启即自动更新）。

## 验证

导出 session JSONL，检查 `request/header`：

- 第一份 header 的 `tools` 应恰好是 `["bash", "str_replace_editor"]`；
- 第一轮只包含用户消息与首句锚点：没有 workspace 指令 baseline、运行时快照、skill 目录消息；
- 首次工具调用或首次助手回复后，下一份变更 header 应包含 resident 目录：bootstrap 双工具 + `dev_tool_search` / `skill_search` / `skill_load` + 已解锁工具；
- 此后的请求保持 resident 集，只经 `dev_tool_search` 显式解锁增长；
- `we` 锚定确认后，事件流出现一次 `source.plugin === 'prompt-injector'` 的消息；未确认时最多等一轮兜底。

本项目测试：

```sh
pnpm test        # pnpm build + node --test
pnpm typecheck   # Host 与 Client 两个 tsc program
pnpm lint        # oxlint
```

## 行为与限制

- Windows：DSH 的 PTY 后端仅支持 linux/darwin，持久 shell 组禁用；phase-1 的 `bash` 切换为 `custom-bash`——同名且 schema 与 Minimal 兼容，经普通跨平台子进程通道调起 Git Bash（运行时探测安装路径，不硬编码）。
- Linux/macOS：持久 shell 的 `shellPath` 自适应——`/bin/bash` 存在时保持默认，不存在（如 NixOS）回退 PATH 里的 `bash`。
- 首轮能力类提问可能基于被裁剪的双工具视图作答，晋升后由后续工具纠正；需要时可开启任务引导或直接首轮问任务类问题。
- 工具目录只变化一次（晋升点），因此第一、二次请求之间发生一次前缀缓存变化；之后每次 `dev_tool_search` 解锁再变化。
- preset 与 shell 访问具有相同信任等级，安装前可自行审阅 `upstream/` 与生成目录。
- 插件只监听本机回环设置桥，不发起网络请求，也不增加遥测。
- 不要在已经产生内容的会话中途切换 preset。
- 需要 DSH 0.1.0-rc.5+（preset 机制与 `system-prompt/assemble` 钩子）。

## 构建与上游管理

```sh
pnpm install
pnpm build          # 生成 lib/
pnpm prepare        # npm publish / git install 前自动触发
pnpm sync:anchored  # 从上游 main 刷新内联快照（可加 ref 参数）
```

上游 `dsh-anchored-standard` 以内联快照形式固化在 `upstream/dsh-anchored-standard/`（含 `LICENSE`、`NOTICE`、`REVISION`），对应提交见 `REVISION`。上游已转入维护期（2026-08-17）；其 Project2 的 98/99/99 成绩来自当前实现之前的旧配置（issue #60），轨迹锚定有独立复现（#65），能力增益在小样本下未决（#51）。

## 许可

插件本体 MIT（Czerror）。首轮锚定机制源自 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT），任务引导与 Flash 方案参考 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（MIT），缓存与工具面成本原则参考 [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)（MIT）。上游 `agent.cordis.yml` 基于 DeepSeek Harness Standard 预设修改，原始 DeepSeek 版权与 MIT 声明保留在 `upstream/dsh-anchored-standard/NOTICE` 与 `LICENSE`。

## 配置参考

挂载配置（cordis.patch.yml / profile patch）：

```yaml
- insert:
    - id: prompt-tool
      name: dsh-plugin-prompt-tool
      config:
        text: ''            # 覆盖 preset.md 文本；默认读项目文件
        agentsText: ''      # 覆盖 AGENTS.md 文本；默认读项目文件
        injectAgentsPrompt: false  # 用 AGENTS.md 替换 instruction-hint 提示文本
        writeAgents: true   # 写 ~/.dsh/AGENTS.md 受管块
        writePreset: true   # 启用锚定预设（总开关）
        injectPrompt: true  # we 确认后注入 preset.md
        skillSwitches: {}   # 按 skills/* 目录名开关，未列出默认开启
        anchorFirstTurn: false  # 追加任务引导
        anchorText: ''      # 自定义引导文本（首句）
        anchorCustom: false # 使用自定义引导（首句）
        guideText: ''       # 自定义引导文本（每轮）
        guideCustom: false  # 使用自定义引导（每轮）
        subagentFlash: false    # 子代理固定 Flash 模型
        subagentFlashProvider: 'deepseek-official'
        subagentFlashModel: 'deepseek-v4-flash'
        bootstrapMaxTokens: 0   # 首轮输出封顶：0=关闭；正整数=请求 #1 maxTokens
        skillsDir: ''       # 可选技能目录（默认包内 skills/）
        skillRankBase: 250  # 技能候选排序基数
        residentAgentsPath: ''  # 默认 ~/.dsh/AGENTS.md
        presetDir: ''       # 默认 ~/.dsh/.agent-presets/prompt-tool/
        presetOrder: 5      # preset 显示顺序
        fallbackText: ''    # preset.md 缺失或不可读时的回退文本
```

TUI 命令：

```text
/prompt-tool status
/prompt-tool on|off|toggle <开关>
/prompt-tool skill <技能目录名> on|off|toggle
/prompt-tool bootstrapMaxTokens <正整数|0>
```
