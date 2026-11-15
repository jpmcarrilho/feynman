// Zod schemas of the ingestion pipeline: OCR (T21), segmentation and question import (T22).
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

// --- Segmentation (T22) -------------------------------------------------------------------------------------------

/**
 * One topic as the model reports it. `isStudyMaterial` is false for front matter and logistics (title slides, syllabus,
 * honor code, tables of contents, "how to use this course"): such topics keep their pages in the outline but get the
 * `not_study_material` marker that question generation reads.
 */
export const TopicSegmentSchema = z.object({
  title: z.string(),
  pageStart: z.number().int(),
  pageEnd: z.number().int(),
  summary: z.string(),
  keyTerms: z.array(z.string()),
  isQuantitative: z.boolean(),
  isStudyMaterial: z.boolean(),
})
export type TopicSegment = z.infer<typeof TopicSegmentSchema>

export const SegmentationOutputSchema = z.object({ modules: z.array(z.object({ title: z.string(), topics: z.array(TopicSegmentSchema) })) })
export type SegmentationOutput = z.infer<typeof SegmentationOutputSchema>

export const WindowTopicsSchema = z.object({ topics: z.array(TopicSegmentSchema.extend({ moduleHint: z.string() })) })
export type WindowTopics = z.infer<typeof WindowTopicsSchema>

export const ModuleGroupingSchema = z.object({
  modules: z.array(z.object({ title: z.string(), topicIndices: z.array(z.number().int()) })),
  mergeGroups: z.array(z.array(z.number().int())),
})
export type ModuleGrouping = z.infer<typeof ModuleGroupingSchema>

// --- Question import (T22) ----------------------------------------------------------------------------------------

/**
 * `answerQuote` is the passage of the text that states the answer (an answer key line, a worked solution, a marked
 * option). Code checks that it occurs in the topic text; a question without such a passage is not imported.
 */
export const ImportedQuestionSchema = z.object({
  questionText: z.string(),
  exerciseType: z.enum(['single_choice', 'multiple_choice', 'numeric', 'dropdown', 'open']),
  choices: z.array(z.string()),
  /** 0-based indexes into `choices` of the correct options (one for single choice and dropdown, one or more for multiple choice, none for numeric). Code derives the stored answer from them. */
  correctChoiceIndexes: z.array(z.number().int()),
  /** The number for numeric questions; the model answer copied verbatim from the text for open questions; "" for every choice type. */
  correctAnswer: z.string(),
  explanation: z.string(),
  answerQuote: z.string(),
  /** Open questions only: 1 to 4 short points condensed from the written model answer in `correctAnswer`; [] for every other type. */
  keyPoints: z.array(z.string()),
})
export type ImportedQuestion = z.infer<typeof ImportedQuestionSchema>
export const ImportedQuestionsSchema = z.object({ questions: z.array(ImportedQuestionSchema) })
export type ImportedQuestions = z.infer<typeof ImportedQuestionsSchema>
