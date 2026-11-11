// Saved web pages uploaded as .txt / .md (a crawler's output, "Save page as" with the wrong extension): mostly tags, scripts and
// style rules around a little text. Detection, stripping and entity decoding are pure so they can be tested on realistic input.

/** Fewer readable characters than this after stripping and the file is not worth studying from. */
export const HTML_MIN_TEXT_CHARS = 500

const ANY_TAG = /<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>/g

/**
 * True when the text is evidently HTML: it starts like a document (doctype or <html>), or it has a <head>/<body>/<script>/<style>
 * element, or tags make up a large share of it. A Markdown or text file with an occasional <br> or <img> is not HTML.
 */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 2000).trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || /<html[\s>]/.test(head)) return true
  const tags = text.match(ANY_TAG) ?? []
  if (tags.length < 5) return false
  if (/<(script|style)[\s>]/i.test(text) && tags.length >= 10) return true
  const tagChars = tags.reduce((n, t) => n + t.length, 0)
  return tags.length >= 20 && tagChars / Math.max(1, text.length) >= 0.15
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
  times: '×', minus: '−', plusmn: '±', deg: '°', euro: '€', pound: '£', sect: '§', para: '¶', frac12: '½',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç',
  ntilde: 'ñ', atilde: 'ã', otilde: 'õ', ecirc: 'ê', ocirc: 'ô', acirc: 'â', uuml: 'ü', ouml: 'ö', auml: 'ä',
}

/** Decodes the named entities above and numeric ones (&#233; &#xE9;). Unknown entities stay as they are. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return ' '
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const BLOCK_BREAK = /<\/?(?:p|div|section|article|header|footer|main|nav|aside|ul|ol|table|thead|tbody|tr|blockquote|pre|figure|figcaption|h[1-6]|hr|form|fieldset)(?:\s[^<>]*)?\/?>/gi
const LINE_BREAK = /<(?:br|li|dt|dd)(?:\s[^<>]*)?\/?>|<\/(?:li|dt|dd|td|th)>/gi

/**
 * The readable text of an HTML document: comments, <head>, <script>, <style>, <noscript>, <svg>, <template> and <iframe> elements are
 * removed with their content, block tags become line breaks, the other tags are dropped, entities are decoded, blank space is collapsed.
 */
export function htmlToText(html: string): string {
  let t = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head|object|canvas)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/gi, ' ')
    // An unclosed script or style (a truncated page) takes the rest of the text with it
    .replace(/<(script|style)(?:\s[^<>]*)?>[\s\S]*$/gi, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ')
    .replace(BLOCK_BREAK, '\n\n')
    .replace(LINE_BREAK, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9:-]*(?:\s[^<>]*)?\/?>/g, '')
  t = decodeEntities(t)
  return t
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export type HtmlStripResult = { text: string; strippedShare: number }

/** Strips an evident HTML document; the text of any other file comes back unchanged (strippedShare 0). */
export function stripHtmlIfEvident(text: string): HtmlStripResult & { wasHtml: boolean } {
  if (!looksLikeHtml(text)) return { text, strippedShare: 0, wasHtml: false }
  const stripped = htmlToText(text)
  return { text: stripped, strippedShare: text.length === 0 ? 0 : 1 - stripped.length / text.length, wasHtml: true }
}
