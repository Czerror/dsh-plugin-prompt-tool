/**
 * env 事实的安全边界：env-facts 只能读白名单里的环境变量，不能把任意 `process.env` 搬进提示词。
 * 白名单与凭据形态判据是导出常量，供填充器与测试共用同一份事实。
 */

/** 疑似凭据的名字一律不放行。 */
export const SENSITIVE_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i

/** env-facts 可读取的键：run-code-env 默认白名单 + 路径类事实（CWD/WORKSPACE）。 */
export const SAFE_ENV_KEYS = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'USERNAME', 'COMPUTERNAME', 'OS', 'TEMP', 'TMP',
  'SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA',
  'DSH_HOME', 'DSH_WORKSPACE', 'DSH_SESSION_ID', 'CWD', 'WORKSPACE',
])
