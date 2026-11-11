import { google } from '@ai-sdk/google'

/** Text model used for every non-live generation in the app. */
export const TEXT_MODEL_ID = 'gemini-3.6-flash'

export function textModel() {
  return google(TEXT_MODEL_ID)
}
