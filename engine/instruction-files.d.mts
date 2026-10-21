/** 宿主依赖面：只声明 src/ 用到的符号，引擎全貌不在此（见 docs/engine-reuse.md 的类型边界）。 */
export declare const PROJECT_INSTRUCTION_CANDIDATES: readonly string[]
export declare const USER_GLOBAL_INSTRUCTION_FILE: string
export declare function ancestorDirs(cwd: string): string[]
export declare function instructionPlan(cwd: string, markerDirs: ReadonlySet<string>): { root: string; dirs: string[] }
