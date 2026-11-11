// Link instructions in the OLD /api/file?path= format. T10 switches these to topic/source ids.

/** Report style (diagnoses): numbered example, page estimate for slides. */
export function fileLinkInstructions(): string {
  return `Format the links EXACTLY like this:
- For Slides PDFs: [Source Lecture Slides Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=ESTIMATED_PAGE_NUMBER) (choose an estimated page number, e.g., 5, where the concept is taught)
- For Transcripts/Readings: [Source Lecture Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_UNIQUE_QUOTE_FROM_TEXT) (choose a 5-10 word unique quote from the text that they should review)

Example:
1. **Review Multi-stage Randomization**: Read page 15 of [Leaders and Democratic Institutions](/api/file?path=${encodeURIComponent('/Users/name/slides.pdf')}#page=15) to understand how the standard errors cluster.
2. **Re-evaluate OLS Coefficients**: Review the transcript [OLS Basics](/api/file?path=${encodeURIComponent('/Users/name/transcript.txt')}&highlight=estimate%20the%20OLS%20equation) to brush up on standard error interpretation.`
}

/** Voice style: short format list used inside the private knowledge block. */
export function voiceFileLinkInstructions(): string {
  return `Format links exactly like this:
- For Slides: [Slides File Title](/api/file?path=URL_ENCODED_LOCAL_PATH#page=PAGE_NUMBER)
- For Transcripts/Readings: [Transcript Title](/api/file?path=URL_ENCODED_LOCAL_PATH&highlight=SHORT_QUOTE)`
}
