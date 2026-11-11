// File links shared by prompts, services and UI. Pure and client-safe: no fs, no server imports.
//
// Canonical forms:
//   /api/files/topic/<topicId>[?highlight=<quote>][#page=N]
//   /api/files/source/<sourceId>[?highlight=<quote>][#page=N]
//   /api/files/summary?course=<courseId>&key=<key>      or   /api/files/summary?session=<sessionId>
// Legacy (only parsed so saved diagnoses and chat logs keep working; never produced):
//   /api/file?path=<absolute path>[&highlight=<quote>][#page=N]

export type FileLink = {
  /** Canonical URL to fetch, without hash and without highlight. */
  url: string
  page: number | null
  highlight: string | null
  kind: 'topic' | 'source' | 'summary' | 'legacy'
}

/** Ids of topics, sources, courses and sessions (uuid / cuid shaped). */
export const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** Summary keys: a file name without directories. */
export const SUMMARY_KEY_RE = /^[A-Za-z0-9._-]{1,120}$/

export function isValidFileId(id: string): boolean {
  return FILE_ID_RE.test(id)
}

/** The regex alone also matches "." and ".."; hidden names are refused as well. */
export function isValidSummaryKey(key: string): boolean {
  return SUMMARY_KEY_RE.test(key) && !key.startsWith('.')
}

type LinkOpts = { page?: number; highlight?: string }

function suffix(opts?: LinkOpts): string {
  let s = ''
  if (opts?.highlight) s += `?highlight=${encodeURIComponent(opts.highlight)}`
  if (opts?.page && Number.isInteger(opts.page) && opts.page > 0) s += `#page=${opts.page}`
  return s
}

export function topicFileLink(topicId: string, opts?: LinkOpts): string {
  return `/api/files/topic/${encodeURIComponent(topicId)}${suffix(opts)}`
}

export function sourceFileLink(sourceId: string, opts?: LinkOpts): string {
  return `/api/files/source/${encodeURIComponent(sourceId)}${suffix(opts)}`
}

export function summaryLink(courseId: string, key: string): string {
  return `/api/files/summary?course=${encodeURIComponent(courseId)}&key=${encodeURIComponent(key)}`
}

export function sessionSummaryLink(sessionId: string): string {
  return `/api/files/summary?session=${encodeURIComponent(sessionId)}`
}

function parsePage(hash: string): number | null {
  const m = hash.match(/(?:^#|&)page=(\d{1,6})(?:&|$)/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  return n > 0 ? n : null
}

/**
 * Recognizes the four link forms. Returns null for anything else (external links, other paths, malformed ids).
 * Relative hrefs are resolved against `origin`; an absolute href on another origin is not a file link.
 */
export function parseFileLink(href: string, origin?: string): FileLink | null {
  if (!href) return null
  const base = origin || 'http://localhost'
  let u: URL
  try {
    u = new URL(href, base)
  } catch {
    return null
  }
  if (u.origin !== new URL(base).origin) return null

  const page = parsePage(u.hash)
  const highlight = u.searchParams.get('highlight') || null

  const idForm = u.pathname.match(/^\/api\/files\/(topic|source)\/([^/]+)\/?$/)
  if (idForm) {
    let id: string
    try {
      id = decodeURIComponent(idForm[2])
    } catch {
      return null
    }
    if (!isValidFileId(id)) return null
    const kind = idForm[1] as 'topic' | 'source'
    return { url: `/api/files/${kind}/${encodeURIComponent(id)}`, page, highlight, kind }
  }

  if (u.pathname === '/api/files/summary') {
    const session = u.searchParams.get('session')
    if (session) {
      if (!isValidFileId(session)) return null
      return { url: sessionSummaryLink(session), page, highlight, kind: 'summary' }
    }
    const course = u.searchParams.get('course')
    const key = u.searchParams.get('key')
    if (!course || !key || !isValidFileId(course) || !isValidSummaryKey(key)) return null
    return { url: summaryLink(course, key), page, highlight, kind: 'summary' }
  }

  if (u.pathname === '/api/file') {
    const p = u.searchParams.get('path')
    if (!p) return null
    return { url: `/api/file?path=${encodeURIComponent(p)}`, page, highlight, kind: 'legacy' }
  }

  return null
}
