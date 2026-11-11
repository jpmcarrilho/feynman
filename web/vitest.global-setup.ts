import fs from 'fs'

// Removes the throwaway database and storage folder created for this run by vitest.config.ts.
export default function setup() {
  return () => {
    const dir = process.env.VITEST_TMP_DIR
    if (dir && dir.includes('feynman-vitest-')) fs.rmSync(dir, { recursive: true, force: true })
  }
}
