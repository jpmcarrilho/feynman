'use client'

import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { scrollableTableComponents } from './markdownComponents'
import { preprocessLaTeX } from './DiagnosisMarkdown'

/** The app's Markdown + KaTeX renderer for question parts (question, choices, explanation, model answer, feedback). */
export function Md({ text, className, as: Tag = 'div' }: { text: string; className: string; as?: 'div' | 'span' }) {
  return (
    <Tag className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={scrollableTableComponents}>{preprocessLaTeX(text)}</ReactMarkdown>
    </Tag>
  )
}

export const CONFIRM_BUTTON = 'w-full max-xl:h-11 bg-fountain-ink hover:bg-fountain-ink/90 text-white border-0 shadow-sm font-medium'

/** On phones the confirm button stays at the bottom of the panel while a long list of options scrolls (the panel ends above the band reserved for the floating Tutor button). */
export function ConfirmBar({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`mt-4 max-xl:sticky max-xl:bottom-0 max-xl:z-10 max-xl:-mx-4 max-xl:border-t max-xl:border-charcoal-graphite/10 max-xl:bg-card/95 max-xl:px-4 max-xl:py-3 max-xl:backdrop-blur-sm ${className}`}>
      {children}
    </div>
  )
}
