import { describe, it, expect } from 'vitest'
import { decodeEntities, htmlToText, looksLikeHtml, stripHtmlIfEvident } from './htmlText'

// A page as a crawler saves it: head with scripts and styles, navigation, the article, a footer with tracking code
const article = `<h1>The median voter theorem</h1>
<p>In a majority-rule election with two candidates and single-peaked preferences, the candidate closest to the median voter wins.
Both candidates therefore move toward the centre.</p>
<p>The theorem rests on three assumptions: voters are sincere, preferences are single-peaked, and there is one policy dimension.
When a second dimension is added, a stable majority winner generally fails to exist (see Plott&#8217;s condition &amp; the Condorcet cycle).</p>
<h2>Why it matters</h2>
<ul><li>It explains why platforms converge.</li><li>It predicts which voter decides the outcome.</li><li>It is a benchmark for models with parties.</li></ul>
<p>Empirically, convergence is weaker than the theorem predicts &mdash; candidates keep distinct platforms because of primaries and turnout effects.</p>`
const page = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Median voter - Wiki</title>
<style>body{font-family:serif}.nav{display:flex}@media (max-width:600px){.nav{display:none}}</style>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());</script>
<script src="https://cdn.example.com/app.js"></script></head>
<body><nav class="nav"><a href="/">Home</a><a href="/about">About</a></nav>
<main>${article}</main>
<footer>&copy; 2026 Example &middot; <a href="/privacy">Privacy</a></footer>
<script type="text/javascript">var _gaq=_gaq||[];_gaq.push(['_trackPageview']);</script></body></html>`

describe('looksLikeHtml', () => {
  it('recognises a saved page by its doctype, by its script blocks, and by its tag density', () => {
    expect(looksLikeHtml(page)).toBe(true)
    expect(looksLikeHtml(`<div class="a"><p>one</p><p>two</p><p>three</p></div>\n<script>x()</script>`)).toBe(true)
    expect(looksLikeHtml(Array.from({ length: 30 }, (_, i) => `<span class="c${i}">w${i}</span>`).join(' '))).toBe(true)
  })

  it('does not treat Markdown or plain text with a few tags or comparisons as HTML', () => {
    expect(looksLikeHtml('# Notes\n\nLine one<br>line two. An image: <img src="a.png"> and a <b>bold</b> word.\n\nIf x < 5 and y > 3 then z.')).toBe(false)
    expect(looksLikeHtml('Plain lecture transcript. '.repeat(100))).toBe(false)
    expect(looksLikeHtml('The generic type is List<String> and Map<K, V>; compare a<b.')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('drops head, scripts, styles and tags, keeps the article text and decodes entities', () => {
    const text = htmlToText(page)
    expect(text).toContain('The median voter theorem')
    expect(text).toContain('closest to the median voter wins.')
    expect(text).toContain('Plott’s condition & the Condorcet cycle')
    expect(text).toContain('— candidates keep distinct platforms')
    expect(text).toContain('© 2026 Example · Privacy')
    expect(text).not.toMatch(/[<>]/)
    expect(text).not.toMatch(/dataLayer|gtag|_gaq|font-family|display:flex|cdn\.example/)
    expect(text).not.toContain('Median voter - Wiki') // the <title> lives in <head>
  })

  it('puts block elements and list items on their own lines', () => {
    const text = htmlToText(article)
    expect(text.split('\n')).toContain('It explains why platforms converge.')
    expect(text).toMatch(/^The median voter theorem\n\nIn a majority-rule election/)
  })

  it('removes an unclosed script together with the rest of the text', () => {
    expect(htmlToText('<p>Kept paragraph.</p><script>var x = "never closed')).toBe('Kept paragraph.')
  })
})

describe('decodeEntities', () => {
  it('decodes named and numeric entities and leaves unknown ones alone', () => {
    expect(decodeEntities('caf&eacute; &lt;b&gt; &#233; &#x41; &unknown; AT&amp;T')).toBe('café <b> é A &unknown; AT&T')
    expect(decodeEntities('bad &#0; and &#xD800; code points')).toBe('bad   and   code points')
  })
})

describe('stripHtmlIfEvident', () => {
  it('reports how much of the file was code, and returns other text unchanged', () => {
    const r = stripHtmlIfEvident(page)
    expect(r.wasHtml).toBe(true)
    expect(r.strippedShare).toBeGreaterThan(0.3)
    expect(r.text.length).toBeGreaterThan(500)
    const plain = 'Just a note.\nSecond line.'
    expect(stripHtmlIfEvident(plain)).toEqual({ text: plain, strippedShare: 0, wasHtml: false })
  })
})
