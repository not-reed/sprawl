import React from 'react'
import { render } from 'ink'
import { App } from './App.js'
import { openDb } from './db.js'

const dbPath = process.argv[2] ?? process.env.DATABASE_URL ?? './data/cortex.db'
const db = openDb(dbPath)

process.on('exit', () => db.close())

const { waitUntilExit } = render(<App db={db} />)

await waitUntilExit()
db.close()
