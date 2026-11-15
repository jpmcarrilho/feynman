import { redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'

export const dynamic = 'force-dynamic'

// The study interface lives under /spaces/[id] now. Authentication is checked first, so a visitor without the
// passcode lands on the login, not on a list they cannot open.
export default async function StudyPage() {
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }
  redirect('/spaces')
}
