// Prompts of the ingestion pipeline. Pure string builders (T22 adds the segmentation and import prompts here).

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
