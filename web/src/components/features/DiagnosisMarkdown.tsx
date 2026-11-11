'use client'

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import type { ReactNode } from 'react'
import { parseFileLink } from '@/lib/fileLinks'

export type ViewFile = (href: string, title?: string) => void

/** Markdown link renderer: file links open in the in-app viewer when there is one, everything else in a new tab. */
const fileAwareLink = (onViewFile?: ViewFile) => {
  const Link = ({ href, children }: { href?: string; children?: ReactNode }) => {
    if (onViewFile && href && parseFileLink(href, window.location.origin)) {
      const text = typeof children === 'string' ? children : Array.isArray(children) ? children.filter((c: unknown) => typeof c === 'string').join('') : ''
      return (
        <a
          href={href}
          onClick={(e) => { e.preventDefault(); onViewFile(href, text || undefined) }}
          className="text-fountain-ink hover:underline font-semibold cursor-pointer"
        >
          {children}
        </a>
      )
    }
    return <a href={href} target="_blank" rel="noopener noreferrer" className="text-fountain-ink hover:underline font-semibold">{children}</a>
  }
  return Link
}

export const preprocessLaTeX = (text: string | null | undefined): string => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return processed;
}

/** A stored diagnosis report: GitHub markdown with math, links to course files open in the viewer (or a new tab without one). */
export function DiagnosisMarkdown({ text, onViewFile }: { text: string; onViewFile?: ViewFile }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{ a: fileAwareLink(onViewFile) }}
    >
      {preprocessLaTeX(text)}
    </ReactMarkdown>
  )
}
