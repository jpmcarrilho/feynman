// Zod schemas of the ingestion pipeline. T21 adds the OCR schema; segmentation and import schemas arrive in T22.
import { z } from 'zod'

/** Gemini PDF transcription: one entry per requested page. */
export const OcrPagesSchema = z.object({ pages: z.array(z.object({ n: z.number().int(), text: z.string() })) })
export type OcrPages = z.infer<typeof OcrPagesSchema>

/** Content of storage/sources/<courseId>/<sourceId>/pages.json. Page numbers are 1-based and contiguous. */
export const PagesFileSchema = z.object({
  pages: z.array(z.object({ n: z.number().int().min(1), text: z.string() })),
  ocr: z.boolean(),
  /** Extraction warning (encoding guess, skipped pages, ...); copied to Source.warning. Optional for older files. */
  warning: z.string().optional(),
})
export type PagesFile = z.infer<typeof PagesFileSchema>
