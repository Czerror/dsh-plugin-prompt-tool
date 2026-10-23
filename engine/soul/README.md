# soul 工具（项目级引擎）

从 [dsh-agent-soul](https://github.com/cyanwell/dsh-agent-soul)（MIT）移植的宿主半与 kit：

- `index.js`：8 个工具（layers / manifest / doctor / plan / scaffold / check / verify / install）。
- `install.js`：profile 扫描与安装建议（只读，不执行安装）。
- `kit-bridge.mjs`：工具到 `kit/echo/*.mjs` 的桥（超时、stderr 回传、roots 校验）。
- `soul/`：判据语料（13 份，只读，每次请求重新读盘）。
- `kit/`：可独立运行的 ECHO 脚本与模板。

与上游的差异只有两处：
1. 入口由 `index.js` 原样再导出为 `engine/soul-tools.mjs`，走本项目的能力行。
2. `install.js` 优先读 `DSH_PROFILE_DIR`，读不到才按插件位置推断 profile。

工具名与上游一致（`agent_soul_*`）。同一 DSH 里再安装 dsh-agent-soul 插件会重名，二选一。
