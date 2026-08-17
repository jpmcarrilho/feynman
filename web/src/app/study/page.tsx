import { StudyInterface } from '@/components/features/StudyInterface'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default async function StudyPage() {
  const isAuthenticated = await checkIsAuthenticated()

  // Guard: if unauthenticated, send them to the home page login gate
  if (!isAuthenticated) {
    redirect('/')
  }

  return <StudyInterface />
}
