import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// The vitest config points DATABASE_URL and STORAGE_DIR at a per-run folder of the OS temp directory, so an unmocked
// import of `@/lib/db` or `@/server/storage` can never open the real dev.db or write to web/storage.
const inside = (root: string, target: string) => path.resolve(target).startsWith(path.resolve(root) + path.sep)
const tmp = fs.realpathSync(os.tmpdir())

describe('test environment isolation', () => {
  it('resolves the database used by src/lib/db.ts to a temp file outside the repository', () => {
    const url = process.env.DATABASE_URL
    expect(url).toBeTruthy()
    expect(url!.startsWith('file:')).toBe(true)
    // db.ts passes the url to the SQLite adapter, which resolves a relative path against the working directory
    const file = path.resolve(process.cwd(), url!.slice('file:'.length))
    expect(path.isAbsolute(url!.slice('file:'.length))).toBe(true)
    expect(inside(tmp, file)).toBe(true)
    expect(inside(process.cwd(), file)).toBe(false)
    expect(path.basename(file)).not.toBe('dev.db')
  })

  it('resolves the storage directory used by src/server/storage.ts to a temp folder outside the repository', async () => {
    const { storageDir } = await import('@/server/storage')
    const dir = storageDir()
    expect(inside(tmp, dir)).toBe(true)
    expect(inside(process.cwd(), dir)).toBe(false)
  })
})
