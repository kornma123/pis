// Node.js 22+ experimental sqlite module type declarations
// @types/node v20 does not include these yet

declare module 'node:sqlite' {
  export interface DatabaseSyncOptions {
    open?: boolean
  }

  export class DatabaseSync {
    constructor(location?: string, options?: DatabaseSyncOptions)
    close(): void
    exec(sql: string): void
    prepare(sql: string): StatementSync
    transaction<T extends unknown[]>(fn: (...args: T) => unknown): (...args: T) => unknown
  }

  export interface StatementSync {
    get(...params: unknown[]): unknown
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    all(...params: unknown[]): unknown[]
    sourceSQL(): string
    expandedSQL(): string
    setReadBigInts(enabled: boolean): void
  }
}
