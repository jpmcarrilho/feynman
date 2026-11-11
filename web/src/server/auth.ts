import { checkIsAuthenticated } from '@/app/auth-actions'

/**
 * Throws when the request has no valid session. Call first in every exported server action.
 */
export async function requireAuth(): Promise<void> {
  if (!(await checkIsAuthenticated())) {
    throw new Error('Unauthorized')
  }
}
