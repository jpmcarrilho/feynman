// Tutor text comes from audio transcription, so a link often arrives as a bracketed title followed by a bare
// "/api/files/topic/<id>" path. This turns those bare paths into Markdown links so the chat renderer (which hands file
// links to the in-app viewer) can make them clickable. Pure and client-safe.
//
// Rules:
//  - only the app's own id-based file routes (/api/files/topic/<id>, /api/files/source/<id>), optionally followed by
//    ?query and #hash; the id and the result must pass parseFileLink, anything else is left as written;
//  - a path that is already the target of a Markdown link ("](/api/...") or part of a longer path or URL is left alone;
//  - code spans and fenced code are not touched;
//  - "[Title]" directly before the path (only whitespace, including a line break, between them) becomes the link text.

import { parseFileLink } from './fileLinks'

const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/
// optional "[Title]" + whitespace, then the path (not preceded by a character that would make it part of something else)
const BARE_PATH_RE = /(?:\[([^\[\]\n]{1,200})\][ \t]*\r?\n?[ \t]*)?(?<![\w(/<"'=.:\-])(\/api\/files\/(?:topic|source)\/[A-Za-z0-9_%-]{1,200})((?:\?[^\s)\]<>]*)?)((?:#[^\s)\]<>]*)?)/g
const TRAILING_PUNCTUATION_RE = /[.,;:!?]+$/

const encodeForMarkdownDestination = (url: string) => url.replace(/[()\s<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)

function linkifySegment(text: string, origin?: string): string {
  return text.replace(BARE_PATH_RE, (whole, title: string | undefined, path: string, query: string, hash: string) => {
    // sentence punctuation after the path is not part of it
    let tail = ''
    const rest = hash || query
    const trimmed = rest.replace(TRAILING_PUNCTUATION_RE, '')
    if (trimmed !== rest) {
      tail = rest.slice(trimmed.length)
      if (hash) hash = trimmed
      else query = trimmed
    }
    const target = `${path}${query}${hash}`
    const link = parseFileLink(target, origin)
    if (!link || (link.kind !== 'topic' && link.kind !== 'source')) return whole
    const label = (title || 'Open document').trim()
    return `[${label}](${encodeForMarkdownDestination(target)})${tail}`
  })
}

export function linkifyFilePaths(text: string, origin?: string): string {
  if (!text || !text.includes('/api/files/')) return text
  return text
    .split(CODE_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : linkifySegment(part, origin)))
    .join('')
}
