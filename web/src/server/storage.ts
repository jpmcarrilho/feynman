// Server-side file access rules. Nothing a client sends may reach the filesystem except through these helpers.
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { isValidSummaryKey, isValidFileId } from '@/lib/fileLinks'
import { PagesFileSchema, type PagesFile } from '@/server/ingest/schemas'

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

// --- Uploaded sources -------------------------------------------------------

/** Storage key (relative to STORAGE_DIR) of a source's original bytes. Pure; throws on invalid ids or extension. */
export function sourceStorageKey(courseId: string, sourceId: string, ext: string): string {
  if (!isValidFileId(courseId) || !isValidFileId(sourceId)) throw new Error('Invalid source id')
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw new Error('Invalid file extension')
  return `sources/${courseId}/${sourceId}/original${ext}`
}

/** Storage key of the extracted pages of a source. Pure. */
export function pagesStorageKey(courseId: string, sourceId: string): string {
  if (!isValidFileId(courseId) || !isValidFileId(sourceId)) throw new Error('Invalid source id')
  return `sources/${courseId}/${sourceId}/pages.json`
}

/** Absolute directory of a source (not created). */
export function sourceDir(courseId: string, sourceId: string): string {
  const full = resolveInside(storageDir(), `sources/${courseId}/${sourceId}`)
  if (!isValidFileId(courseId) || !isValidFileId(sourceId) || !full) throw new Error('Invalid source id')
  return full
}

/** Creates the directory of `key` under STORAGE_DIR (if needed) and returns the absolute file path; refuses symlink escapes. */
async function preparePath(key: string): Promise<string> {
  const root = storageDir()
  const full = resolveInside(root, key)
  if (!full) throw new Error('Invalid storage key')
  const dir = path.dirname(full)
  await fs.promises.mkdir(/* turbopackIgnore: true */ dir, { recursive: true })
  const realDir = await fs.promises.realpath(/* turbopackIgnore: true */ dir)
  const realRoot = await fs.promises.realpath(/* turbopackIgnore: true */ root)
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) throw new Error('Invalid storage key')
  return path.join(realDir, path.basename(full))
}

/**
 * Writes `data` to `storage/<key>` atomically: a temporary file in the same directory is flushed and renamed over the
 * target, so a reader sees the old file or the complete new one, never a partial write.
 */
export async function atomicWriteStorageFile(key: string, data: string | Uint8Array): Promise<void> {
  const target = await preparePath(key)
  const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  let handle: fs.promises.FileHandle | undefined
  try {
    handle = await fs.promises.open(/* turbopackIgnore: true */ tmp, 'wx')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.promises.rename(/* turbopackIgnore: true */ tmp, target)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await fs.promises.rm(/* turbopackIgnore: true */ tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Same as atomicWriteStorageFile, but the bytes come from a stream (a File from `request.formData()`), so the content is
 * not copied into a second in-memory buffer on its way to disk.
 */
export async function atomicWriteStorageStream(key: string, source: Readable | ReadableStream<Uint8Array>): Promise<void> {
  const target = await preparePath(key)
  const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  try {
    const input = source instanceof Readable ? source : Readable.fromWeb(source as import('stream/web').ReadableStream<Uint8Array>)
    await pipeline(input, fs.createWriteStream(/* turbopackIgnore: true */ tmp, { flags: 'wx' }))
    const handle = await fs.promises.open(/* turbopackIgnore: true */ tmp, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.promises.rename(/* turbopackIgnore: true */ tmp, target)
  } catch (error) {
    await fs.promises.rm(/* turbopackIgnore: true */ tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** Saves an uploaded Blob/File as the original of a source without buffering it a second time; returns the storage key. */
export async function writeSourceBlob(courseId: string, sourceId: string, ext: string, blob: Blob): Promise<string> {
  const key = sourceStorageKey(courseId, sourceId, ext)
  await atomicWriteStorageStream(key, blob.stream() as ReadableStream<Uint8Array>)
  return key
}

/** Deletes the folder of one source (original, pages.json). A missing folder is fine. */
export async function removeSourceFiles(courseId: string, sourceId: string): Promise<void> {
  await fs.promises.rm(/* turbopackIgnore: true */ sourceDir(courseId, sourceId), { recursive: true, force: true })
}

/**
 * Deletes everything a studyspace keeps under STORAGE_DIR: its source files, its summaries and the session index files of
 * `sessionIds`. The tracked legacy folder `summaries/` of the repository is never touched.
 */
export async function removeCourseStorage(courseId: string, sessionIds: string[] = []): Promise<void> {
  if (!isValidFileId(courseId)) throw new Error('Invalid course id')
  const root = storageDir()
  for (const rel of [`sources/${courseId}`, `summaries/${courseId}`]) {
    const full = resolveInside(root, rel)
    if (full) await fs.promises.rm(/* turbopackIgnore: true */ full, { recursive: true, force: true })
  }
  for (const id of sessionIds) {
    const file = newSessionIndexPath(id)
    if (file) await fs.promises.rm(/* turbopackIgnore: true */ file, { force: true })
  }
}

/** Removes leftover `*.tmp` files of crashed atomic writes in a source directory. */
export async function removeStaleTempFiles(courseId: string, sourceId: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.promises.readdir(/* turbopackIgnore: true */ sourceDir(courseId, sourceId))
  } catch {
    return
  }
  for (const name of names) {
    if (name.endsWith('.tmp')) {
      const full = resolveInside(sourceDir(courseId, sourceId), name)
      if (full) await fs.promises.rm(/* turbopackIgnore: true */ full, { force: true }).catch(() => {})
    }
  }
}

/** Saves the uploaded bytes of a source and returns the storage key to store in `Source.storageKey`. */
export async function writeSourceFile(courseId: string, sourceId: string, ext: string, bytes: Uint8Array): Promise<string> {
  const key = sourceStorageKey(courseId, sourceId, ext)
  await atomicWriteStorageFile(key, bytes)
  return key
}

/** Atomically writes pages.json of a source. */
export async function writePages(courseId: string, sourceId: string, file: PagesFile): Promise<void> {
  await atomicWriteStorageFile(pagesStorageKey(courseId, sourceId), JSON.stringify(file))
}

/** Reads and validates pages.json; null when it does not exist or is not a valid pages file. */
export async function readPages(courseId: string, sourceId: string): Promise<PagesFile | null> {
  let raw: Buffer
  try {
    raw = await readSourceFile(pagesStorageKey(courseId, sourceId))
  } catch {
    return null
  }
  try {
    const parsed = PagesFileSchema.safeParse(JSON.parse(raw.toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
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
