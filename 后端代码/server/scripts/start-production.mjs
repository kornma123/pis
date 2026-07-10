#!/usr/bin/env node

// npm start is the production entrypoint on every platform. Set the mode before
// app.ts loads dotenv/config so a development .env cannot re-enable fixtures.
process.env.NODE_ENV = 'production'

await import('../dist/src/app.js')
