# 提示词工具（dsh-plugin-prompt-tool）

把「Anchored Standard + dsh-router-standard 最优组合」做成 DSH 全家桶里的一键安装插件：插件启动时生成并维护 `~/.dsh/.agent-presets/prompt-tool/` 预设，首轮模型请求只看到官方 Minimal 精确双工具——持久 `bash` 与 `str_replace_editor`——和正确的 persona，没有运行时上下文与指令注入；锚定建立后进入 resident 目录，恢复常规注入，并在确认轨迹后注入 `preset.md`。同时提供 Web 界面在线编辑 `preset.md` / `AGENTS.md`、切换全部开关，以及可开关的 skills 技能层（含一键打开技能目录、设置自定义技能目录）。全部通过官方插件接口实现，不修改 DSH 源码。

## 原理

DeepSeek V4 会强烈依赖 API 中可见的**首轮工具目录与 persona** 选择执行轨迹。完整 Standard 目录与自动注入在场会破坏 Minimal 轨迹，而全程 Minimal 又会失去重型工具。本项目把「首次轨迹选择」与「后续完整工具能力」拆开：

1. **干净首轮**：`context-gate` 清空首轮 runtime-context 并剥离自动注入；`tool-bootstrap` 只暴露 Minimal 双工具；`router-first-turn` 按主会话模型替换 persona——Pro 使用训练原句，Flash 自动采用 dsh-router-standard 的 Flash 弱路由人设（build/fix 分类 + 回顾锚 + 反跑题锚 + 先深想再产出）。
2. **晋升**：首次持久 `tool/call` 或 `assistant/message`（先到者为准）落地后，按 `usePtcMode` 开关选择 wire 形态——默认开启时切换为 Code Mode（PTC，单一 `run_code`），完整插件工具经生成 SDK 调用；关闭时恢复原生完整工具目录。
3. **任务引导**：可选 `near-anchor` 在首条真实用户消息后追加一次近距离首句引导（we/let 按任务自动选择）；Flash 主会话晋升后 `router-guide` 按任务复杂度追加每轮深度引导。
4. **提示词注入**：we 锚定确认后把 `preset.md` 作为用户消息注入一次；we 未确认最多等一轮兜底，绝不卡死。
5. **子代理**：目录直接全量放行（仍受调用方工具白名单过滤）；可选 `subagentFlash` 固定 Flash 路由 + 任务分类人设 + 三锚。

阶段全部从持久 session events 推导，resume / reload 不丢失状态。

## 稳定化控制

全部在生成 preset 的 `agent.cordis.yml` 行中配置：

- `bootstrapMaxTokens`：首轮输出封顶。`0` = 本项目默认不设封顶（Web 界面显示 256000，即不设上限）；正整数 = 请求 #1 的 `maxTokens`，晋升后自动剥离，不会焊进后续请求。不锁定 1024，任意正整数均可。
- `context-gate`：未晋升期间关闭两条统一注入路径，pre-step 只保留 claimed 批次 + `allowKinds`（放行用户技能手势与 `near-anchor` / `router-guide`）；晋升后差分恢复一条 runtime-context 消息。
- `tool-bootstrap`：`promoteOn: either` 避免纯文字首答永久困在双工具；compaction 后回到 bootstrap + `compactionTools` 受控阶段。
- `usePtcMode`（默认开启）：晋升后把 wire 切换为 Code Mode（PTC，单一 `run_code`），完整插件工具经生成 SDK 调用；关闭时恢复原生完整工具目录。两种模式都不再依赖 `dev_tool_search`，生成 preset 时直接移除该行且不复制 `dev-tool-search.mjs`。
- `router-first-turn`：只替换 persona 段，保留 plan-mode 段与第三方 section；首轮隐藏 `mnemon:*` 自动注入段，晋升后恢复。
- `near-anchor`：行为引导放在真实用户消息之后（近距离零衰减），只要求首句一次；复杂规划任务放行 Let 深度路径，日常任务锚 We。
- `router-guide`：简单任务快速收敛，复杂任务深度引导；子代理不注入，首轮不注入。
- `prompt-injector`：注入状态以持久事件为准，跨进程重启 / 插件热重载不重复注入。
- `injectAgentsPrompt`：开启时用 `AGENTS.md` 内容替换本地 instruction-hint 的默认提示文本；关闭时使用本地默认 hint（列出参考文件、按需读取）。
- `skillSwitches`：扫描 `skills/*/SKILL.md` 注册可开关技能，未列出的技能默认开启。
- `subagentFlash`：检测不到 DeepSeek 模型路由时 Web/TUI 禁用并强制降级为关闭。

## 安装

依据官方[《打包与安装插件》](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)准则：
`dsh plugin add` 只把**声明了 `dsh.bundle` 的直接依赖**追加进
`dsh.profile.bundles`；`@deepseek-ai/dsh-web-app` 是随 DSH 安装自带的 in-box
bundle（从 dsh 安装目录解析，不需要也不应写进 `dependencies`）。

### npm 安装与源码安装

两种安装源等价，后续初始化流程相同：

```sh
# 方式 A：npm / registry 安装
dsh plugin --profile prompt-tool add dsh-plugin-prompt-tool

# 方式 B：本地源码安装（link 会覆盖 registry 依赖）
dsh plugin --profile prompt-tool add link:<本仓库绝对路径>
```

### 初始化：启动一次即可

```sh
dsh --profile prompt-tool
```

第一次启动只负责完成初始化。首次进程尚未挂载 Web 表面，这是预期行为；
自愈完成后**插件会自动退出（exit 0）**，无需手动停止：

```text
prompt-tool: auto-added @deepseek-ai/dsh-web-app to dsh.profile.bundles for profile "prompt-tool"; next launch will mount the Web surface ...
prompt-tool: initialization complete — exiting so the repaired profile can be launched
```

这一次启动会自动完成：

1. **prompt-tool profile**：把 `@deepseek-ai/dsh-web-app` 补进
   `dsh.profile.bundles`，最终为
   `base → web-app → dsh-plugin-prompt-tool`；
2. **web profile**：若存在，把 `dsh-plugin-prompt-tool` 写进它的
   `dependencies` + `bundles`（dependency 写法复用当前 profile 的安装
   spec）。**只写 package.json，不手工创建 node_modules 链接**；
3. **dsh-tui profile**：若存在且确实装有
   `@deepseek-harness-tui/dsh-tui`，同样写进 `dsh-plugin-prompt-tool`；
   **没有 dsh-tui 则整体跳过，不写入本插件**。dsh-tui 不需要
   `@deepseek-ai/dsh-web-app`，因此不会给它补 web-app。

所有写入幂等：文件已正确时不做任何改动。

### 初始化之后直接使用

```sh
# Web：官方内置 profile，本插件已自动写入
dsh web

# TUI：dsh-tui 的安装流程已经物化过其 profile 依赖
dsh-tui
```

`dsh web` 随 dsh 安装必然存在；`dsh-tui` 则在其自身安装说明中已经执行过
profile 依赖物化。因此初始化只需写入 package.json，不需要额外 `install`。

如果还想直接使用 `prompt-tool` 这个 profile 本身，再运行一次即可
（第二次启动时 web-app 已由官方装配路径加载）：

```sh
dsh --profile prompt-tool
```

> TUI 前提：先安装/初始化过 `@deepseek-harness-tui/dsh-tui` 并已生成
> `dsh-tui` profile，再执行上面的初始化启动；否则按设计会跳过 dsh-tui
> profile。之后补装 dsh-tui 时，重新执行一次
> `dsh --profile prompt-tool` 即可把本插件补进 dsh-tui profile。

### 备选：直接把本插件装进官方 `web` 模板 profile

`web` 是官方内置模板，初始 bundles 已含
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`：

```sh
# registry 安装
dsh plugin --profile web add dsh-plugin-prompt-tool
# 本地开发安装
dsh plugin --profile web add link:<本仓库绝对路径>

# 启动
dsh --profile web
```

完成初始化后，用 `dsh web`、`dsh-tui` 或 `dsh --profile prompt-tool` 启动，
新建空 session，预设选择 **prompt-tool**。插件会在启动时生成并刷新
`~/.dsh/.agent-presets/prompt-tool/`（升级插件后重启即自动更新）。

### 卸载

```sh
dsh plugin --profile prompt-tool remove dsh-plugin-prompt-tool
```

首次启动还会把包内 `skills/` 增量复制到**本插件自己的 profile** 目录下的
`$DSH_HOME/profiles/prompt-tool/skills`，并优先使用这份副本（从 `dsh web`
或 `dsh-tui` 启动也一样写这里，不会写到 web/dsh-tui profile）：已有同名文件不覆盖，
用户对副本的编辑会保留；包内新增技能文件会在下次启动补齐。想改回包内原始
skills，删除该 `skills` 目录后重启即可（或在配置里显式设置 `skillsDir`）。

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
- 需要 DSH 0.1.0-rc.7+（preset 机制、`system-prompt/assemble` 钩子与 keyed `settings.plugin.item` 插槽）。

## 构建与上游管理

```sh
pnpm install
pnpm build          # 生成 lib/
pnpm prepare        # npm publish / git install 前自动触发
pnpm sync:anchored  # 从上游 main 刷新内联快照（可加 ref 参数）
```

上游 `dsh-anchored-standard` 以内联快照形式固化在 `upstream/dsh-anchored-standard/`（含 `LICENSE`、`NOTICE`、`REVISION`），对应提交见 `REVISION`。本项目运行时不直读上游任何文件：`preset/` 已自有化全部 `agent.cordis.yml` 与预设 JS 脚本（shared / context-gate / compaction-epoch / custom-bash / instruction-hint / skill-search / tool-bootstrap），生成时只注入 `usePtcMode` / `bootstrapMaxTokens` / `subagentFlash` 动态项；`upstream/` 仅用于溯源与 sync 对照。上游已转入维护期（2026-08-17）；其 Project2 的 98/99/99 成绩来自当前实现之前的旧配置（issue #60），轨迹锚定有独立复现（#65），能力增益在小样本下未决（#51）。

## 许可

插件本体 MIT（Czerror）。首轮锚定机制源自 [xiaobright/dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard)（MIT），任务引导与 Flash 方案参考 [yjh051108/dsh-router-standard](https://github.com/yjh051108/dsh-router-standard)（MIT），缓存与工具面成本原则参考 [yjh051108/dsh-super-injector](https://github.com/yjh051108/dsh-super-injector)（MIT）。本地 `preset/` 下的 cordis 模板与 JS 脚本基于 DeepSeek Harness Standard 预设与上游 anchored-standard 修改，原始 DeepSeek 版权与 MIT 声明保留在 `upstream/dsh-anchored-standard/NOTICE` 与 `LICENSE`。

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
        usePtcMode: true  # 使用 PTC 模式：true=晋升后切换为 Code Mode（run_code）；false=恢复原生完整目录
        skillsDir: ''       # 用户自定义技能目录；空 = 自动使用 prompt-tool profile 下 skills/ 副本
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
