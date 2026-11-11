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
