// Link instructions: the model can only reference material by topic id. Ids come from the prompt inputs
// (diagnosis topic lines, voice unit headers); the model never sees a filesystem path.
// No copyable placeholder titles or example ids here: the model copied those verbatim before.

/** Report style (diagnoses). */
export function fileLinkInstructions(): string {
  return `To point to study material, write a Markdown link whose text is the real title of that topic from the breakdowns above and whose address is /api/files/topic/ followed by the exact "Topic ID" printed on that topic's line.
- Copy the Topic ID exactly from the material above; never invent or alter one. If a topic has no Topic ID, write the task without a link.
- Slide decks and PDFs: append #page=N with the page where the concept is taught.
- Transcripts, readings and questions have no pages: append ?highlight= followed by a short exact quote (5-10 words) from that topic's text, URL-encoded.`
}

/** Voice style: short list used inside the private knowledge block. */
export function voiceFileLinkInstructions(): string {
  return `To send the student to a source, write a Markdown link whose text is that unit's real title and whose address is /api/files/topic/ followed by the exact Topic ID in that unit's header below.
- Copy the Topic ID exactly; never invent one. If the material has no Topic ID, give no link.
- #page=N only for slide decks and PDFs. For transcripts and questions append ?highlight= and a short exact quote from the text, URL-encoded.`
}
