# 指令文件注入按每文件开关控制

ADR-0003 把指令文件的注入资格记成两层：策略顶层 `enabled` 缺省 `false`（部署级硬关），单文件的 `enabled: true` 无法在部署级关闭下单独开启。该设计在真实使用中暴露两个问题：

- **与协调器已有的自动抑制重复**：`pre-step-coordinator` 已经从装配事实里认出"预设组合仍挂着官方 `@deepseek-ai/dsh-agent-instructions` 行"并整体跳过文件注入，部署级开关因此只在"预设没有官方行"时才有实际效果；
- **开关的可用性与它能否生效脱钩**：官方行仍在时总开关照样能打开，打开后没有任何效果，只有文件卡上一句说明。用户对着一个注定不生效的开关，无法判断是自己没配对还是它本来就不参与。

本 ADR 重定注入闸门：**废除部署级开关**（策略顶层 `enabled` 不再存在），注入默认开启，由**指令文件卡上的每文件开关**逐个关闭（`files[fileId].enabled: false`）。装配事实仍是上位约束：预设组合里仍挂着官方指令行、或该 Agent 的 scope 里没有任何已注册 preset 来源（装配未知）时，独立来源整体不参战，经 `instructions.owner.officialInstructions`（`true` / `false` / `null`）上报工作台，并由文件卡就地说明「官方指令行仍装配在本预设里：这个文件本次不注入，卡片开关不会生效」——不让用户对着没反应的开关猜。

策略文件（`$DSH_HOME/.prompt-tool/instructions.yml`）保持「只承载行为与展示名、不存正文」的边界。读取与写入共用同一个归一化层：已知键（顶层 `defaults` / `files`，以及 `files` 下的 `order` / `position` / `promotion` / `audience` / `modelScope` / `enabled` / `name`）按白名单取用并校验取值，**未知键一律舍弃**——不报错、不进 patch、不写盘。旧文件里残留的顶层 `enabled` 因此在读取时被丢弃、在首次写入时被清掉，不需要逐键兼容分支；正文与版本键也仍然进不了策略文件。

默认值的迁移面是显式的：升级后**所有探测到的指令文件默认参与注入**，除非用户在卡片上逐个关闭。这与 ADR-0003 的「缺省不参战」相反，是本次有意接受的变更——它把「是否注入用户磁盘上的文件」从一次性授权改成逐文件可见、可回退的开关。

## 取代关系

- 取代 ADR-0003 中「缺省 `enabled: false`，需在工作台显式开启」与「总开关关闭是硬关」两条实现约束；
- ADR-0003 其余部分继续有效：正文始终归属用户原文件、策略独立于预设与 settings、注入资格按 `(fileId, revision, surface epoch)` 与会话可见面判定、官方指令行仍挂载时不注入。

代码入口：`src/host/instructions-policy.ts`（归一化与有效值解析）、`src/runtime/pre-step-coordinator.ts`（装配事实与文件采集）、`src/client/data/instruction-policy.ts`（客户端有效值解析与卡片字段）。
