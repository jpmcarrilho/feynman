import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'
import os from 'os'

// Tests may never reach the real database or the real storage folder: whatever a test imports, DATABASE_URL and
// STORAGE_DIR point into a folder of the OS temp directory that is unique to this run and removed afterwards
// (vitest.global-setup.ts). `src/lib/db.ts` falls back to ./dev.db only when DATABASE_URL is unset, which cannot happen here.
const runDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'feynman-vitest-'))
process.env.VITEST_TMP_DIR = runDir

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    globalSetup: './vitest.global-setup.ts',
    env: {
      DATABASE_URL: `file:${path.join(runDir, 'test.db')}`,
      STORAGE_DIR: path.join(runDir, 'storage'),
      VITEST_TMP_DIR: runDir,
    },
    setupFiles: './vitest.setup.ts',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
