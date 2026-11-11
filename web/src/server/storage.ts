// Server-side file access rules. Nothing a client sends may reach the filesystem except through these helpers.
import fs from 'fs'
import path from 'path'
import { isValidSummaryKey, isValidFileId } from '@/lib/fileLinks'

/** Root of uploaded files and generated summaries of new spaces. Gitignored. */
export function storageDir(): string {
  // Runtime locations (not build-time assets): keep the bundler from tracing the whole project
  return path.resolve(/* turbopackIgnore: true */ process.env.STORAGE_DIR || path.join(/* turbopackIgnore: true */ process.cwd(), 'storage'))
}

/** Tracked legacy summaries (summaries/<code>/*.md, summaries/session_*_index.md). */
export function legacySummariesDir(): string {
  return path.join(/* turbopackIgnore: true */ process.cwd(), 'summaries')
}

/** Join `rel` under `root`; null when the result is not strictly inside `root` (absolute rel, "..", NUL). Pure. */
export function resolveInside(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0')) return null
  if (path.isAbsolute(rel)) return null
  const base = path.resolve(/* turbopackIgnore: true */ root)
  const full = path.resolve(/* turbopackIgnore: true */ base, rel)
  return full.startsWith(base + path.sep) ? full : null
}

/** True when `target` is strictly inside `root` once both are resolved. Pure. */
export function isInside(root: string, target: string): boolean {
  const base = path.resolve(/* turbopackIgnore: true */ root)
  return path.resolve(/* turbopackIgnore: true */ target).startsWith(base + path.sep)
}

/** Reads `storage/<storageKey>`. Rejects keys that escape STORAGE_DIR, including through symlinks. */
export async function readSourceFile(storageKey: string): Promise<Buffer> {
  const root = storageDir()
  const full = resolveInside(root, storageKey)
  if (!full) throw new Error('Invalid storage key')
  const real = await fs.promises.realpath(/* turbopackIgnore: true */ full)
  const realRoot = await fs.promises.realpath(/* turbopackIgnore: true */ root)
  if (!real.startsWith(realRoot + path.sep)) throw new Error('Invalid storage key')
  return fs.promises.readFile(/* turbopackIgnore: true */ real)
}

export function contentTypeForPath(p: string): string {
  switch (path.extname(p).toLowerCase()) {
    case '.pdf': return 'application/pdf'
    case '.md': return 'text/markdown; charset=utf-8'
    case '.txt': return 'text/plain; charset=utf-8'
    case '.json': return 'application/json'
    case '.csv': return 'text/csv; charset=utf-8'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    default: return 'application/octet-stream'
  }
}

/** Media types a Source row may be served as; anything else is sent as an opaque download type. */
const SOURCE_TYPES = ['application/pdf', 'text/plain', 'text/markdown']
export function safeSourceContentType(mime: string): string {
  const base = (mime || '').split(';')[0].trim().toLowerCase()
  if (!SOURCE_TYPES.includes(base)) return 'application/octet-stream'
  return base === 'application/pdf' ? base : `${base}; charset=utf-8`
}

// --- Summaries -------------------------------------------------------------

type SummaryCourse = { id: string; code: string }

/** Where NEW summaries of a course are written: storage/summaries/<courseId>. */
export function storageSummaryDir(courseId: string): string {
  return path.join(/* turbopackIgnore: true */ storageDir(), 'summaries', courseId)
}

/** Plan 3.4: `summaries/<code>` if that tracked legacy directory exists, else storage/summaries/<courseId>. */
export function summaryDirFor(course: SummaryCourse): string {
  if (isValidSummaryKey(course.code)) {
    const legacy = path.join(legacySummariesDir(), course.code)
    if (fs.existsSync(/* turbopackIgnore: true */ legacy)) return legacy
  }
  return storageSummaryDir(course.id)
}

/** Key of a module summary file: the module name without whitespace; null if it cannot be a valid key. */
export function summaryKey(moduleName: string): string | null {
  const key = moduleName.replace(/\s+/g, '_')
  return isValidSummaryKey(key) ? key : null
}

function stripMd(key: string): string {
  return key.endsWith('.md') ? key.slice(0, -3) : key
}

/** Existing summary file for (course, key): the legacy tracked directory first, then storage. Null when none. */
export function findSummaryFile(course: SummaryCourse, key: string): string | null {
  if (!isValidSummaryKey(key) || !isValidFileId(course.id)) return null
  const file = `${stripMd(key)}.md`
  const dirs = [summaryDirFor(course), storageSummaryDir(course.id)]
  for (const dir of dirs) {
    const full = resolveInside(dir, file)
    if (full && fs.existsSync(/* turbopackIgnore: true */ full)) return full
  }
  return null
}

/** Where a new summary file of (course, key) is written (always under storage/). Null for an invalid key. */
export function newSummaryFilePath(course: SummaryCourse, key: string): string | null {
  if (!isValidSummaryKey(key)) return null
  return resolveInside(storageSummaryDir(course.id), `${stripMd(key)}.md`)
}

export function sessionSummariesDir(): string {
  return path.join(storageDir(), 'summaries', 'sessions')
}

/** Where a NEW session index file is written. Null for an invalid session id. */
export function newSessionIndexPath(sessionId: string): string | null {
  if (!isValidFileId(sessionId)) return null
  return resolveInside(sessionSummariesDir(), `${sessionId}_index.md`)
}

/** Existing session index file: storage first, then the tracked legacy summaries/session_<id>_index.md. */
export function findSessionIndexFile(sessionId: string): string | null {
  if (!isValidFileId(sessionId)) return null
  const candidates = [
    resolveInside(sessionSummariesDir(), `${sessionId}_index.md`),
    resolveInside(legacySummariesDir(), `session_${sessionId}_index.md`),
  ]
  for (const c of candidates) if (c && fs.existsSync(/* turbopackIgnore: true */ c)) return c
  return null
}

// --- Legacy /api/file?path= ---------------------------------------------------

/** Directories whose .md files the legacy route may serve. */
export function legacyAllowedRoots(): string[] {
  return [legacySummariesDir(), path.join(storageDir(), 'summaries')]
}

/**
 * Pure allow-list of the legacy route. A path is allowed when
 *  - it is exactly a stored Topic.localPath (`topicPathExists`, the caller's exact DB lookup), or
 *  - it is absolute, has no NUL, ends in .md and, after path.resolve (so ".." cannot escape),
 *    lies strictly inside one of `roots`.
 * Everything else is refused. Symlinks need the filesystem and are checked by the route.
 */
export function isLegacyPathAllowed(p: string, roots: string[], topicPathExists: boolean): boolean {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return false
  if (topicPathExists) return true
  if (!path.isAbsolute(p)) return false
  if (path.extname(p).toLowerCase() !== '.md') return false
  return roots.some((r) => isInside(r, p))
}
