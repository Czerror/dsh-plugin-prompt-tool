# 两份九层计划复审问题修复 PLAN

## 需求与授权

- 日期：2026-09-21；实施基线：`dev / bd5ea6f`。
- 用户授权原话：`根据.scratch\plan\2026-09-21-plan-review-two-plans-a34eed1.md执行修复`。
- 范围：[源审查计划](2026-09-21-plan-review-two-plans-a34eed1.md)的全部 N1/N2/V1—V6（T2—T9），含回归、文档、归档、中文提交与推送 `origin/dev`；本次授权取代候选未授权状态。
- 不改两份 2026-09-20 历史归档，保留原有未跟踪 `skills/`。

## 审查结论

沿用源计划八项已复核发现：V1 投递缓存混用 plugin/kind；V2 官方组装提前执行未命中 ST setter；V3 来源锁定忽略显式覆盖；N1 工具创建依赖挂载；N2 搜索未接入层设置；V4 变量/预设模型只读缺口；V5 无参数层空设置壳；V6 变量折叠不重渲染。

### 实施后双轴复核

- 规范轴确认1项P2：资产中文名称未进入匹配（模板变量/自定义工具/人设），技术键能匹配。沿既有标题映射补词条；主线程新增生产装配反例先红后绿。
- 需求轴确认2项：P1同类遗漏为无eligible时仅排除pre-step，其他事件层的ST setter仍可能被官方assembly预求值；另确认同一中文资产漏搜P2。前者收紧为system-section/runtime-context允许列表，并补其他六层真实官方assembly回归。
- 两项均在原N2/V2授权范围内修复，不新增搜索服务或全局调度器；规范轴和需求轴复核未闭合发现均为0。
- 主线程另补N2真实CSS反例：参数组hidden被原display:flex覆盖，先红（flex≠none）后增加同类选择器守卫；最终全测覆盖其生效。

## 影响面、依赖与护栏

- 引擎继续使用共享执行器，保持接纳、scope、epoch、disposer与跨层变量帧；来源保留现有最终覆盖优先级。
- 页面复用草稿池、编辑组匹配、bridge和资产保存通道，不新增状态框架或全局调度。
- 独立写区：引擎代理负责engine及其测试/文档；来源代理负责host/shared/来源字段UI及其测试/参数文档；主线程负责页面/工具/变量/模型/搜索及客户端回归、交付文档。共享文件先协调。
- 并行期间不构建；集成后由主线程统一构建和复跑。所有测试 cwd 为 `D:\AI\workspase\_temp`，独立临时 DSH_HOME/TEMP/TMP 后清理。
- 不修改宿主，不安装依赖，不启停现有 DSH，不写真实用户资产。

## Wave 1：引擎和来源事实

```xml
<task type="auto">
  <name>T1：修复V1/V2</name>
  <files>engine执行器与ST渲染；对应engine/host测试；docs/engine-reuse.md</files>
  <action>分别保留身份字段命名空间；统一ST入口资格，禁止未命中配置提前赋值。</action>
  <verify>冷热投递碰撞；官方assembly先于pre-step；命中/未命中、受众/晋升/去重/epoch/重复组装。</verify>
  <security>仅宿主接纳记去重，不绕过外层门控，不保存用户正文。</security>
  <done>反例转绿，跨层变量帧和生命周期回归通过。</done>
</task>
<task type="auto">
  <name>T2：修复V3</name>
  <files>writer来源链；shared契约；来源字段UI；对应host/client测试；docs/architecture-params.md</files>
  <action>按最终合并事实区分预设投影与局部覆盖，开放真实owner。</action>
  <verify>GLOBAL/LOCAL、真实spec覆盖、bridge保存/writer重读、清空/只读/过期预设。</verify>
  <security>保持覆盖优先级与元数据白名单，不下发任意路径或行配置。</security>
  <done>说明与生效值一致，两类来源可往返。</done>
</task>
```

## Wave 2：界面入口和交互

```xml
<task type="auto">
  <name>T3：修复N1/N2/V4/V5/V6</name>
  <files>两页面；EngineLayersPanel；PromptConfigList；工具/变量/模型组件；对应client回归</files>
  <action>创建由常驻owner处理；搜索接入编辑组匹配；按真实可写性禁用；按层能力传设置回调；折叠立即渲染并保留。</action>
  <verify>真实React与Edge：重复创建、切页保留、中文/技术键/能力名搜索、有无实例、只读三态、无设置层、变量折叠。</verify>
  <security>不自动保存半成品，不隐式建配置，保留筛选和独立会话模型操作。</security>
  <done>五项反例转绿，生产装配链回归通过。</done>
</task>
```

## Wave 3：复核与交付

```xml
<task type="auto">
  <name>T4：完整验收和归档</name>
  <files>稳定文档；CHANGELOG；本PLAN和源审查PLAN；本地.ai-memory日志</files>
  <action>主线程复跑反例与完整门禁，双轴审查，填写状态后归档提交推送。</action>
  <verify>typecheck、lint、test、build、git diff --check；3080只读探测与产物核对；归档链接。</verify>
  <security>不暂存skills或本地日志，不提交lib，不启停DSH，不将401当交互通过。</security>
  <done>修复证据可核对，代码与归档同次提交并推送origin/dev。</done>
</task>
```

## 回滚与检查点

使用本轮提交的git revert回滚代码，不改用户配置或重写历史。恢复以本PLAN、工作树和代理回执为准；未验证不能标完成。

## 状态

- [✔] Wave 1 / T1：V1/V2及复核补丁完成；独立/管理、冷热恢复、官方assembly及其他六层资格回归通过。
- [✔] Wave 1 / T2：V3完成；实际来源读回、可编辑覆盖、清空、只读、过期身份与元数据剥离通过。
- [✔] Wave 2 / T3：N1/N2/V4/V5/V6完成；两页真实浏览器与真实CSS回归通过。
- [✔] Wave 3 / T4：双轴复核闭合，完整门禁通过；本PLAN与源审查PLAN归档并随代码提交。提交/推送凭据以交付回执及git历史为准，不预写成功。

## 验收记录

- 所有命令通过PowerShell7执行，测试cwd为 `D:\AI\workspase\_temp`，独立DSH_HOME/TEMP/TMP并finally清理。
- 引擎五文件定向160/160；来源三文件50/50；主线程客户端契约51/51；新生产页面回归5/5；中文资产搜索反例0/1→1/1；真实CSS隐藏反例flex→none。
- 主线程最终执行 `pnpm --dir $Repo typecheck`、`lint`、`test`、`build` 和 `git diff --check`，全部退出0；完整测试 **1240/1240**，0失败、0跳过。test入口构建与单独build均通过。
- 类型检查、静态检查、构建均针对最终生产补丁；仅后续PLAN状态与本地记录未影响源码。
- 在役 `http://127.0.0.1:3080` 返回401，无boot上下文；未验证登录后的实际页面，隔离Edge证明组件行为和真实CSS，不宣称等同真实部署。

## 实施取舍与已知边界

- 保留现有逐插入点语义：已组装系统段不因后到pre-step赋值回溯重算；后到获准模板在同一帧补求值一次。
- 工具加载/读取失败或只读时拒绝创建并给提示；不排队重放。已加载后的创建立即产生独立草稿，不自动保存半成品。
- 来源事实只写生成配置的白名单元数据；旧生成物无此字段时不按ID推定来源，正常重建后获得事实。
- 未启停DSH或修改宿主。需要用户重启DSH服务后让宿主修复生效，刷新页面读取新客户端；预设下一次正常重建更新生成引擎和来源事实。
- 用户追加的baseline-ui界面重构另起下一修复轮次，基于本轮提交，不混进本次行为修复。

## 测试现场与清理限制

本轮独立测试根和Edge profile均已清理；临时门禁日志收尾删除。未修改真实用户资产，原有未跟踪 `skills/` 保留，本地.ai-memory不入库。
