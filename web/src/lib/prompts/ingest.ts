// Prompts of the ingestion pipeline: OCR (T21), segmentation and question import (T22). Pure string builders.

/** Transcription of a page range of an attached PDF (Gemini fallback for scans and image-heavy decks). */
export function ocrPagesPrompt(start: number, end: number, total: number): string {
  return `Transcribe pages ${start} to ${end} (inclusive, counting from 1 at the first page of the attached PDF, which has ${total} pages) of the attached PDF.
Return JSON {"pages":[{"n":<page number in the whole PDF>,"text":"<transcription>"}]} with exactly one entry for every page from ${start} to ${end}, in order, and no entry for any other page.
Rules:
- "n" is the absolute page number in the whole PDF (the first page of the PDF is 1), not a number relative to this range.
- Transcribe all readable text, including text inside images, diagrams and tables, in reading order. Keep math as LaTeX.
- Do not summarize, translate, explain or add anything that is not on the page. Leave out running headers, footers and slide numbers.
- If a page has no readable text, use an empty string for it.`
}

// --- Segmentation (T22) -------------------------------------------------------------------------------------------

/** Bump whenever the segmentation or import prompts change (stored on the marker rows and reported by the measurements). */
export const INGEST_PROMPT_VERSION = 'ingest-v1'

const TOPIC_FIELD_RULES = `For every topic give:
- "title": at most 80 characters, specific (name the concept, method or example, not "Introduction" or "Slide 12"), written in the language of the document text.
- "pageStart" and "pageEnd": the first and last page of the topic, copied from the [[p:N]] markers only. Pages are numbered from 1 and a range includes both ends.
- "summary": 2 to 3 sentences in the language of the document text saying what the topic teaches.
- "keyTerms": 3 to 8 terms or short phrases that literally appear in the text of the topic (copy them exactly as written). Fewer than 3 only when the topic has fewer.
- "isQuantitative": true only if studying the topic requires calculations, formulas, proofs or reading numeric tables; false for purely verbal or conceptual topics.
- "isStudyMaterial": true for subject matter a student can be tested on, including worked examples, practice problems, quizzes and readings. false for front matter and course logistics: title or cover slides, outline or agenda slides that only list what comes next, tables of contents, indexes, syllabus, grading and exam rules, schedules, honor code, platform or website instructions, welcome notes, "how to use this course", acknowledgements, reference lists, thank-you slides. Judge from the content, not from the title. A recap, summary or conclusion that restates the content of the material is subject matter. When unsure, use true: a lecture slide that introduces a concept is subject matter even if it is called "Introduction".`

/** The size guidance in pages, derived from how much text a page of this document holds. */
export function topicSizeGuidance(avgPageChars: number): string {
  const avg = Math.max(1, Math.round(avgPageChars))
  const lo = Math.max(1, Math.round(2000 / avg))
  const hi = Math.max(lo + 1, Math.round(15000 / avg))
  return `a topic is what a student would study in one sitting: about 2,000 to 15,000 characters. The pages of this document hold about ${avg.toLocaleString('en-US')} characters on average, so that is roughly ${lo} to ${hi} page${hi === 1 ? '' : 's'} per topic (a slide deck page or a short page can be a topic of its own only when it is a self-contained unit; a long continuous piece may run longer).`
}

function topicCoverageRules(avgPageChars: number): string {
  return `Rules for the topics:
- Size: ${topicSizeGuidance(avgPageChars)}
- Cover every page: the first topic starts at the first page and each next topic starts on the page after the previous one ends. Topics must not overlap and must not skip pages. Put front matter and logistics (and closing pages that only thank, advertise or list references) in their own topics with isStudyMaterial false instead of leaving them out.
- Keep the order of the document.`
}

/** Whole document in one call (at most ~60,000 characters). Output: modules with their topics. */
export function segmentSinglePrompt(input: { fileName: string; pageCount: number; avgPageChars: number; markedText: string }): string {
  return `You are a curriculum designer. Build the study outline of one document, "${input.fileName}", which has ${input.pageCount} page${input.pageCount === 1 ? '' : 's'} (numbered 1 to ${input.pageCount}). Each page of the text below starts with a marker line [[p:N]].

Split it into topics and group the topics into modules (chapters, lectures or sections, in the order of the document). A module has a title of at most 60 characters, written in the language of the document text, and holds consecutive topics. Use the document's own section structure when it has one; a short document may be a single module.

${TOPIC_FIELD_RULES}

${topicCoverageRules(input.avgPageChars)}
- Write every title and summary in the language of the document text, not in the language of these instructions.

Return JSON {"modules":[{"title":...,"topics":[{"title":...,"pageStart":...,"pageEnd":...,"summary":...,"keyTerms":[...],"isQuantitative":...,"isStudyMaterial":...}]}]}.

DOCUMENT TEXT:
${input.markedText}`
}

/** One window of a long document. Output: flat topics with a module hint each; modules are decided in the merge call. */
export function segmentWindowPrompt(input: { fileName: string; pageCount: number; avgPageChars: number; windowStart: number; windowEnd: number; markedText: string }): string {
  return `You are a curriculum designer. The document "${input.fileName}" has ${input.pageCount} pages and is processed in windows. The text below is window pages ${input.windowStart} to ${input.windowEnd}. Each page starts with a marker line [[p:N]].

Split the pages of this window into topics.${input.windowStart > 1 ? ` The first page of this window (page ${input.windowStart}) was also the last page of the previous window, so the topic that contains it may have started earlier: start your first topic at page ${input.windowStart} anyway.` : ''}${input.windowEnd < input.pageCount ? ` The last page of this window (page ${input.windowEnd}) is also the first page of the next window: end your last topic at page ${input.windowEnd}.` : ''}

${TOPIC_FIELD_RULES}
- "moduleHint": the title (at most 60 characters) of the chapter, lecture or section the topic belongs to, in the language of the document text. Use the same hint for consecutive topics of the same section, and the document's own section titles when the text shows them.

${topicCoverageRules(input.avgPageChars)}
- Only use page numbers from ${input.windowStart} to ${input.windowEnd}. The first topic starts at page ${input.windowStart} and the last one ends at page ${input.windowEnd}.
- Write every title, hint and summary in the language of the document text, not in the language of these instructions.

Return JSON {"topics":[{"title":...,"pageStart":...,"pageEnd":...,"summary":...,"keyTerms":[...],"isQuantitative":...,"isStudyMaterial":...,"moduleHint":...}]}.

WINDOW TEXT:
${input.markedText}`
}

export type GroupingTopic = { index: number; title: string; pageStart: number; pageEnd: number; summary: string; moduleHint: string }

/** The single merge call of a windowed document: modules over the window topics, and duplicates created by window boundaries. */
export function moduleGroupingPrompt(input: { fileName: string; pageCount: number; topics: GroupingTopic[] }): string {
  const lines = input.topics
    .map((t) => `${t.index}. [pages ${t.pageStart}-${t.pageEnd}] ${t.title} (section hint: ${t.moduleHint}) - ${t.summary}`)
    .join('\n')
  return `You are a curriculum designer. The document "${input.fileName}" (${input.pageCount} pages) was split into topics window by window. Below are all the topics in page order, numbered by index.

Do two things:
1. Group the topics into modules (chapters, lectures or sections of the document). Each module has a title of at most 60 characters, in the language of the topics, and a list of "topicIndices" that are consecutive indices in order. Every index must appear in exactly one module. Use the section hints and the document's own structure; aim for modules of roughly 3 to 15 topics, and never one module per topic unless the document really is that fragmented.
2. Report "mergeGroups": lists of consecutive indices that are the SAME topic cut in two by a window boundary (the same title or the same subject continuing across the boundary page). Only merge topics that are clearly one continuous piece; return [] when there are none.

Return JSON {"modules":[{"title":...,"topicIndices":[...]}],"mergeGroups":[[...]]}.

TOPICS:
${lines}`
}

// --- Question import (T22) ----------------------------------------------------------------------------------------

/** Extraction of the questions a topic's text already contains. The answer must be stated in the text. */
export function importQuestionsPrompt(input: { topicTitle: string; text: string }): string {
  return `You extract practice questions that already exist in a study document. Below is the text of one topic, "${input.topicTitle}".

Extract only questions that are present in the text AND whose correct answer is stated in the text (an answer key, a marked option such as "[x]" or "correct", a worked solution, "Answer: ..."). Never work out an answer yourself and never guess one: if the text does not state the answer, leave the question out. Leave out rhetorical questions of a lecture, questions that depend on a figure, table or dataset that is not in the text, and survey, feedback or opinion items. If there are none, return {"questions":[]}.

For every question return:
- "questionText": the question as written, complete enough to be answered on its own (include the setup the text gives for it). Keep the language of the text. Remove numbering such as "Question 3", points ("1/1 point (graded)") and instructions such as "Submit" or "Show answer".
- "exerciseType": one of
  - "single_choice": 3 to 6 options, exactly one correct. "choices" lists the options in the order of the text; "correctAnswer" is exactly the text of the correct option. (A true/false question with only two options is not importable: leave it out.)
  - "multiple_choice": 3 to 6 options, "select all that apply". "correctAnswer" is a JSON array string of the exact texts of all the correct options, e.g. "[\\"Option A\\",\\"Option C\\"]". Not every option may be correct.
  - "numeric": the answer is a number. "choices" is []. "correctAnswer" is a plain number such as "0.8" or "-12" (no units, no percent sign, no thousands separators, no words).
  - "dropdown": a fill-in-the-blank sentence with 3 to 5 options: "questionText" contains exactly one "[Dropdown 1]" placeholder, "choices" the options, "correctAnswer" the exact correct option.
  - Questions that need a free-text answer or a long derivation cannot be imported: leave them out.
- "choices": the options as plain strings without letters or bullets ("A)", "i."), copied from the text.
- "explanation": the explanation or solution the text gives for the answer, copied or lightly condensed. If the text gives none, write a one-sentence statement of the correct answer as the text gives it. Never add reasoning of your own.
- "answerQuote": the passage of the text that states the answer, copied exactly (one line or a short passage, at most 300 characters).
- Math: write every mathematical expression between dollar signs ($...$ inline), e.g. $\\beta > 0$; never write LaTeX commands outside dollar signs. Write currency with an escaped dollar sign (\\$5). Dropdown options are plain text without LaTeX.

Return JSON {"questions":[...]}.

TOPIC TEXT:
${input.text}`
}
