// Wording shared by the upload screens about what is done with the questions a file contains.

/**
 * The app has four question types (single choice, multiple choice, numeric, dropdown), all graded against one stored answer. An open
 * question with a written model answer fits none of them, so it is not imported; this is said where files are added.
 */
export const QUESTION_IMPORT_NOTE =
  'Questions that are already in a file are imported when the file also states their answer and they are multiple choice, numeric or fill-in-the-blank. Open questions with a written model answer are not imported; the tutor writes practice questions from the text instead.'
