/**
 * node:sqlite 加载垫片（仅测试用）
 *
 * 背景：node:sqlite 是 Node 22+ 的实验性内置模块，但 vite 5 的 isBuiltin 在剥离 `node:` 前缀后
 * 于 builtinModules 中找不到 'sqlite'（该模块只以 `node:sqlite` 前缀形式存在），于是把它当成
 * 待解析的源文件并报 "Failed to load url sqlite"。
 *
 * 解决：vitest.config 把对 `node:sqlite` 的导入 alias 到本垫片。本垫片是真实文件，vite 能正常加载；
 * 内部用 Node 原生 createRequire 拿到真正的内置模块（worker 侧已带 --experimental-sqlite），再原样 re-export。
 */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const sqlite = require('node:sqlite')

export const DatabaseSync = sqlite.DatabaseSync
export const StatementSync = sqlite.StatementSync
export const constants = sqlite.constants
export default sqlite
