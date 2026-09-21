# 运行上下文异步填充与遗留模板按钮修复

## 需求与授权

- 2026-09-22 用户要求：“[插入本层模板] ui中这个遗留按钮没有删除,同时解决运行上下文异步填充 问题”。
- 基线：8b231b2，dev；保留用户未跟踪 skills/。
- 删除卡内遗留模板入口及无调用者回调；修复 runtime-context 的官方同步 provider 契约，保留动态策略、受众、门控和生命周期。
- 用户明确选择“同步本机预设生成产物”和“继续提交并推送”；同步到既有 DSH_HOME，保持定义和迁移备份不变。

## 审查结论

- engine/layers.mjs 的 wireRuntimeContexts 使用 text: async，官方 PromptContext.text 是同步函数；原测试 await provider 隐藏了真实装配问题。
- UI 真实配置卡内仍有“插入本层模板”按钮，应删除，顶部模板选择流程保留。
- 已发布 @deepseek-ai/dsh-system-prompt 0.1.6-alpha.2 的 assemble 同步求值 provider 后才运行异步 waterfall；真实 renderContextSections 反例报 TypeError: text.indexOf is not a function（5/5 红灯）。
- 按调用方 AssembleContext 对象缓存选择结果不能覆盖同对象并发复用；改用官方私有空变量占位，在当前 assembly 内按名称和占位匹配，不缓存正文或 Promise。

## 影响面、依赖与护栏

- UI 子任务独占 src/client 与对应 test/client；主线程负责 engine、test/engine、文档与 PLAN。
- 对照已安装官方包及本地 docs/subsystems/system-prompt；用 rg 核验 provider、策略和注册调用链。延续此前图谱工具落位冲突的降级，以 rg 实际引用为证据。
- 只用 apply_patch 编辑、pwsh 7 执行；测试/脚本 cwd 位于 D:/AI/workspase/_temp。
- 不修改宿主源码、不重启在役 DSH、不更改用户预设定义、不恢复空层自动卡；统一由主线程构建、提交和推送 origin/dev。

## Wave 1：两个独立修复

<task type="auto">
  <name>T1：删除卡内遗留模板按钮</name>
  <files>src/client 中按钮与回调链；test/client 对应现有检查</files>
  <action>沿按钮引用清理只为此入口服务的 props、文案与样式，保留顶部模板菜单。</action>
  <verify>现有客户端相关测试通过；UI 中没有卡内插入按钮，顶部仍可添加真实模板。</verify>
  <security>不涉及新增信任边界；只删除 UI 入口，不增加 bridge 写路径。</security>
  <done>按钮和无用回调清理完成且主线程验证。</done>
</task>

<task type="auto">
  <name>T2：按官方生命周期填充运行上下文</name>
  <files>engine/layers.mjs；策略相关必要文件；test/engine；docs/engine-reuse.md、docs/injection-point-contracts.md</files>
  <action>先用官方装配器证明异步 provider 失败，再复用官方异步准备阶段完成填充，同步 provider 返回当前装配的文本；同步稳定行为文档。</action>
  <verify>反例先红后绿，覆盖异步模板、主/子会话、并发隔离、空值/失败、门控/压缩和 disposer；完整 typecheck/lint/test/build/diff-check。</verify>
  <security>运行时状态必须按会话或装配隔离，失败不能泄露其他会话或旧装配文本；不写用户数据。</security>
  <done>真实官方装配得到文本且生命周期回归、完整门禁通过。</done>
</task>

## Wave 2：同步本机生成产物

<task type="auto">
  <name>T3：重建本机预设生成目录</name>
  <files>scripts/rematerialize-presets.mjs；DSH_HOME/.agent-presets 的插件生成产物</files>
  <action>调用既有离线重建脚本，核对定义和迁移备份 SHA256，确认共享引擎与仓库源码一致。</action>
  <verify>8 个预设扫描，7 个插件预设物化，手写 liangshen 跳过，0 失败；8 份定义与 4 份备份摘要保持一致。</verify>
  <security>不刷新内嵌 skills，不覆盖手写组合，不重启在役服务；仅更新插件拥有的生成产物。</security>
  <done>本机共享引擎已更新，用户配置原字节保持。</done>
</task>

## 回滚与检查点

- 修改均为代码与文档，可用 git revert 回滚交付提交；不需要迁移数据。
- 每个子任务完成后更新此 PLAN，最终原样归档并随代码提交。
- 生成产物回滚：回滚代码并构建后，重跑同一 rematerialize-presets 命令；不回滚或改写 preset.yml。

## 状态

- [✔] Wave 1 / T1：按钮、两级 props、两页回调和中英文词条删除；客户端定向检查由主线程复跑通过。
- [✔] Wave 1 / T2：官方同步注册 + 异步 waterfall 填充，真实装配与完整门禁通过。
- [✔] Wave 2 / T3：本机生成目录同步，定义/备份摘要及共享引擎一致性检查通过。

## 验收记录

- 证据类型：命令输出、真实官方装配行为断言、文件 SHA256 比对。
- 红灯：node --test --test-name-pattern 'runtime-context：' test/engine/official-variable-regression.test.mjs，初始 5/5 失败，均为官方渲染收到 Promise。
- 绿灯：node --test <绝对路径>/test/engine/{prompt-config-engine,official-variable-regression}.test.mjs，113/113 通过。新增 7 条真实官方回归：异步技能目录、并发主/子/同会话、异常/空值、两种门控注册顺序、压缩与重晋升、同名遮蔽/兄弟 scope/卸载、同上下文对象并发复用、取消/卸载清空已填正文。
- 客户端：engine-module-cards、scope-create-separation、locale-contract、client-wiring-contract、prompt-config-scale，66/66 通过，顶部模板创建链保留；小范围删除使用既有渲染与事件回归，不新增浏览器场景。
- pnpm --dir D:/AI/GitHub/dsh-plugin-prompt-tool typecheck / lint / test / build 全部退出 0；完整 test 1280/1280，0 失败、0 跳过。测试从 D:/AI/workspase/_temp 启动，TEMP/TMP 同时指向该隔离目录。
- git diff --check 通过。
- node D:/AI/GitHub/dsh-plugin-prompt-tool/scripts/rematerialize-presets.mjs --dsh-home 'D:/AI/DeepSeek harness/.dsh'：8 扫描、7 物化、1 手写预设跳过、0 stale skills、0 失败。全部 8 个 preset.yml 与 4 份 .layer-settings-backup.json 的前后 SHA256 一致。

## 实施取舍与已知边界

- 运行时变更需要用户重启 DSH 服务后生效。
- 使用现有官方 context/variable/waterfall；无新依赖、无预读工具阶段、无按会话缓存。动态规则保持逐条求值，不改变各注入点的时序。
- 所有检查使用实际已发布包；图谱工具的落位冲突沿用 rg 调用链核查替代，未生成知识图谱。

## 测试现场与清理限制

- 新增官方装配测试的临时 DSH_HOME 由 t.after 清理；完整测试脚本自行清理本次 pt-test-run 目录；核对 _temp 下无本轮 pt-official-vars/pt-test-run 残留。
- 既有 4 份迁移备份保留；用户 skills/ 未跟踪目录不纳入提交。在役 DSH 未停止或重启。
