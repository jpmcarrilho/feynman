'use server'

import { cookies } from 'next/headers'

/**
 * Verifies if the request possesses a valid session cookie matching the configured passcode.
 */
export async function checkIsAuthenticated(): Promise<boolean> {
  const securePasscode = process.env.APP_PASSCODE

  if (!securePasscode) {
    // If no passcode is set in env, we fail-safe as unauthenticated to prevent unintended public access.
    console.error("CRITICAL: APP_PASSCODE environment variable is not defined on the server.")
    return false
  }

  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get('feynman_session')?.value

  return sessionCookie === securePasscode
}

/**
 * Validates the user's submitted passcode and sets a secure HttpOnly cookie on success.
 */
export async function loginWithPasscode(passcode: string): Promise<{ success: boolean; error?: string }> {
  const securePasscode = process.env.APP_PASSCODE

  if (!securePasscode) {
    return { success: false, error: 'Server authentication is unconfigured.' }
  }

  if (passcode === securePasscode) {
    const cookieStore = await cookies()
    cookieStore.set('feynman_session', securePasscode, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 60 * 60 * 24 * 365, // Keep logged in on your phone for 1 year
      path: '/'
    })
    return { success: true }
  }

  return { success: false, error: 'Incorrect passcode.' }
}

/**
 * Clears the session cookie to log the user out.
 */
export async function logout(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete('feynman_session')
}

/**
 * Securely retrieves the Gemini API Key from the server environment, gated by passcode validation.
 */
export async function getGeminiApiKey(): Promise<string> {
  const isAuthenticated = await checkIsAuthenticated()
  if (!isAuthenticated) {
    throw new Error('Unauthorized')
  }
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || ''
}
