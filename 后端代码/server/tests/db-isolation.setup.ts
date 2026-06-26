/**
 * 每文件数据库隔离（消除跨文件测试污染）
 *
 * 背景：DatabaseManager 在模块加载时把 `DB_PATH` 固化为
 * `process.env.DATABASE_PATH || data/coreone.db`，而 vitest forks 池会在同一 worker
 * 进程中顺序复用执行多个测试文件，`process.env` 在文件间共享。绝大多数测试文件已在
 * 文件首行（静态 import 之前，配合动态 import app）设置 `:memory:` 实现隔离；但只要有
 * 一个文件遗漏（例如用静态 `import app`、其 import 被 ESM 提升到首行赋值之前），就会落到
 * 共享的磁盘库 `data/coreone.db`——该文件同时被 globalSetup 启动的常驻服务器（主进程）
 * 打开，两个进程并发对同一 SQLite 文件做 DDL/查询会产生不确定的 schema 竞争
 * （表现为偶发 `no such table: outbound_abc_details` 以及跨文件污染导致的偶发误红）。
 *
 * setupFiles 在“测试文件自身的 import 求值之前”执行，因此在这里强制 `:memory:` 能保证：
 *   1. 即使是静态 import app/DatabaseManager 的测试文件，DatabaseManager 读取 DATABASE_PATH
 *      时也已是 `:memory:`，永不落到磁盘库；
 *   2. 归一化任何从同 worker 上一个文件泄漏过来的路径，使每个文件起点一致；
 *   3. node:sqlite 的每个 `new DatabaseSync(':memory:')` 都是私有库，配合 vitest 的
 *      文件级模块隔离（isolate:true，每文件重置 DatabaseManager 单例）即得到独立连接。
 *
 * ⚠️ 本文件必须保持“纯环境变量赋值、不 import DatabaseManager”：一旦在此静态 import
 *    DatabaseManager，其 `DB_PATH` 常量会在本赋值之前被 ESM 提升求值并固化为默认磁盘路径，
 *    反而使 `:memory:` 失效。
 */
process.env.DATABASE_PATH = ':memory:'
// 测试环境标记：app.ts 据此跳过 app.listen（测试用 supertest 的 request(app)，无需常驻端口）
process.env.NODE_ENV = 'test'
