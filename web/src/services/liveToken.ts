const AUTH_TOKENS_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens'

// A token is single-use: it can open exactly one session, and only within the first minute.
// expireTime bounds how long that session may keep sending messages.
export const LIVE_TOKEN_SESSION_MS = 30 * 60 * 1000
export const LIVE_TOKEN_NEW_SESSION_MS = 60 * 1000

export type LiveToken = { token: string; expiresAt: string }

/**
 * Mints a short-lived, single-use Gemini Live ephemeral token. The API key stays on the server.
 * No liveConnectConstraints are set, so the client's setup message (model, system instruction) is unrestricted.
 */
export async function mintLiveToken(apiKey: string, now: number = Date.now()): Promise<LiveToken> {
  if (!apiKey) throw new Error('Missing Gemini API Key on server')

  const expireTime = new Date(now + LIVE_TOKEN_SESSION_MS).toISOString()
  const newSessionExpireTime = new Date(now + LIVE_TOKEN_NEW_SESSION_MS).toISOString()

  const res = await fetch(AUTH_TOKENS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ uses: 1, expireTime, newSessionExpireTime }),
  })
  if (!res.ok) {
    throw new Error(`Could not create a live session token (HTTP ${res.status}).`)
  }
  const data = (await res.json()) as { name?: string }
  if (!data.name) throw new Error('Could not create a live session token.')
  return { token: data.name, expiresAt: expireTime }
}
