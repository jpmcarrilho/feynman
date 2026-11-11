// A throwaway SQLite database built from the real migrations, for tests that need real transactions and cascades.
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'

/** Creates `<dir>/test.db` with the schema of prisma/migrations applied in order and returns the directory. */
export function createTestDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't22-db-'))
  const migrations = path.join(process.cwd(), 'prisma', 'migrations')
  const db = new Database(path.join(dir, 'test.db'))
  for (const name of fs.readdirSync(migrations).sort()) {
    const file = path.join(migrations, name, 'migration.sql')
    if (fs.existsSync(file)) db.exec(fs.readFileSync(file, 'utf8'))
  }
  db.close()
  return dir
}

/**
 * A PrismaClient on a fresh test database plus its directory (also usable as STORAGE_DIR). Use it inside
 * `vi.mock('@/lib/db', ...)` so that no import order can ever reach the real database.
 */
export async function createTestPrisma() {
  const dir = createTestDb()
  const { PrismaClient } = await import('@prisma/client')
  const { PrismaBetterSqlite3 } = await import('@prisma/adapter-better-sqlite3')
  const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dir}/test.db` }) })
  return { dir, prisma }
}
