// Upload and extraction limits of plan section 4.1. Pure and client-safe (the dropzone and the upload route share them).

export const ALLOWED_EXTENSIONS = ['.txt', '.md', '.pdf'] as const
export type SourceExtension = (typeof ALLOWED_EXTENSIONS)[number]

/** Per-file upload limit. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024
/** Files per upload request. */
export const MAX_FILES_PER_REQUEST = 20
/** Extracted text per source. */
export const MAX_EXTRACTED_CHARS = 2_000_000
/** Gemini fallback bounds: the whole PDF is sent inline for every page range. */
export const MAX_OCR_BYTES = 20 * 1024 * 1024
export const MAX_OCR_PAGES = 300
/** Pages per Gemini call. */
export const OCR_RANGE_SIZE = 15
/** Synthetic page size of .txt / .md files. */
export const TEXT_PAGE_CHARS = 4000
/** Stored topic text above this size is not sent to the viewer (two imported topics hold ~40 MB of JSON as "content"). */
export const MAX_SERVED_CONTENT_CHARS = 2_000_000
export const CONTENT_TOO_LARGE_MESSAGE = 'This file could not be imported, so there is nothing to show.'
/** A topic's content is split into parts above this size (used by segmentation). */
export const MAX_TOPIC_CHARS = 120_000

// Sparse rule (4.4): few characters per page means a scan or an image-only deck.
export const SPARSE_AVG_CHARS_PER_PAGE = 200
export const SPARSE_PAGE_MIN_CHARS = 50
export const SPARSE_SHARE_OF_SHORT_PAGES = 0.4

export const TOO_LONG_MESSAGE = (chars: number) => `Document too long (${chars.toLocaleString('en-US')} chars, limit ${MAX_EXTRACTED_CHARS.toLocaleString('en-US')})`
export const OCR_TOO_LARGE_MESSAGE = 'Scanned PDF too large for the Gemini fallback (limit 20 MB / 300 pages)'

/** Lower-case extension including the dot, or '' when none. */
export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i <= 0 ? '' : fileName.slice(i).toLowerCase()
}

export function isAllowedExtension(ext: string): ext is SourceExtension {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext)
}

// --- Upload request (T23) ---------------------------------------------------------------------------------------------

/**
 * Bytes accepted in one upload request (all files plus form overhead). `request.formData()` holds the whole body in memory,
 * so the request is bounded as well as every file: a request over this size is refused while it is read, not after.
 */
export const MAX_REQUEST_BYTES = 200 * 1024 * 1024

// --- Starter exercises (plan 4.1, 4.6) ---------------------------------------------------------------------------------
/** Starter questions a topic is topped up to. */
export const STARTERS_PER_TOPIC = 2
/** Starter questions of one source (existing ones count). */
export const STARTERS_PER_SOURCE = 60
/**
 * Generation slots of one studyspace's starter run. A slot is one question the generator tries to produce; it makes at most
 * 3 attempts of one generation call plus one blind-solve call each, so a run makes at most STARTER_SLOTS_PER_RUN * 6 model calls
 * (typically about 2 per slot).
 */
export const STARTER_SLOTS_PER_RUN = 200
/** The run stops when this many slots in a row fail for a reason other than the topic itself (model unavailable, key invalid). */
export const STARTER_MAX_CONSECUTIVE_FAILURES = 5

/** Media type stored for each allowed extension (the client-supplied type is never trusted or stored). */
export function mimeTypeForExtension(ext: string): string {
  switch (ext) {
    case '.pdf': return 'application/pdf'
    case '.md': return 'text/markdown'
    default: return 'text/plain'
  }
}

/**
 * The file name as data: no path parts, no control or bidirectional-override characters, at most 200 characters (the
 * extension is kept). Untrusted: it is only ever stored and displayed, never used in a storage path.
 */
export function sanitizeFileName(raw: string): string {
  const last = (typeof raw === 'string' ? raw : '').split(/[\\/]/).pop() ?? ''
  const name = last.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '').trim()
  if (name.length <= 200) return name
  const ext = extensionOf(name)
  const keep = ext && ext.length <= 10 ? ext : ''
  return name.slice(0, 200 - keep.length) + keep
}

export type UploadProblem = { name: string | null; error: string; status: 400 | 413 | 415 }

const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`

/**
 * Checks a list of files before anything is read or written: count, extension, declared size, empty files, duplicate names.
 * Returns every problem found (empty list = acceptable), in that order. Pure and client-safe: the dropzone uses the same messages.
 */
export function checkUploadList(files: { name: string; size: number }[]): UploadProblem[] {
  const problems: UploadProblem[] = []
  if (files.length === 0) return [{ name: null, error: 'No files were sent. Choose at least one .txt, .md or .pdf file.', status: 400 }]
  if (files.length > MAX_FILES_PER_REQUEST) {
    problems.push({ name: null, error: `Too many files (${files.length}). Upload at most ${MAX_FILES_PER_REQUEST} files at a time.`, status: 413 })
  }
  for (const f of files) {
    if (!isAllowedExtension(extensionOf(f.name))) {
      problems.push({ name: f.name, error: `"${f.name || 'unnamed file'}" is not supported. Upload .txt, .md or .pdf files.`, status: 415 })
    }
  }
  for (const f of files) {
    if (f.size > MAX_FILE_BYTES) {
      problems.push({ name: f.name, error: `"${f.name}" is ${mb(f.size)}; the limit is ${mb(MAX_FILE_BYTES)} per file.`, status: 413 })
    } else if (f.size === 0) {
      problems.push({ name: f.name, error: `"${f.name}" is empty.`, status: 400 })
    }
  }
  const seen = new Map<string, number>()
  for (const f of files) seen.set(f.name.toLowerCase(), (seen.get(f.name.toLowerCase()) ?? 0) + 1)
  const reported = new Set<string>()
  for (const f of files) {
    const key = f.name.toLowerCase()
    if ((seen.get(key) ?? 0) > 1 && !reported.has(key)) {
      reported.add(key)
      problems.push({ name: f.name, error: `"${f.name}" appears more than once in this upload. Rename or remove one of them.`, status: 400 })
    }
  }
  return problems
}
