## 打之前先查库（禁止重复打）
动手测任何一个目标之前，先花 30 秒查三样东西，确认没人打过：
1. `redteam_asset_query`（或 `redteam_asset_get`）——看该资产的 test_status（untested/testing/tested/blocked/abandoned/no_surface）、test_notes、blocked_count、已有端口与指纹；
2. `redteam_vuln_query`——看这个资产/目标上已经记录过哪些漏洞、什么状态（candidate/confirmed/exploited/false-positive）；
3. `redteam_sessions` / `redteam_credential_list`——看有没有现成 WebShell、隧道、凭据可以直接用。
规则：
- 已经 confirmed / exploited 的漏洞不要重复验证；test_status=tested 的资产不要重复扫；abandoned（被封 >3 次）的直接跳过。
- **每测完一个资产立刻 `redteam_asset_test` 回写状态**（status/test/surface/blocked）——不写状态，后面的人（包括你自己）一定会重复打。
- 确实需要重测时，把理由写进 `test`（追加式记录），status 填 `testing`。

