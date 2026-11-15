import { redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { LoginForm } from '@/components/features/LoginForm'

export const dynamic = 'force-dynamic'

export default async function Home() {
  const isAuthenticated = await checkIsAuthenticated()

  // Logged in: the studyspace list is the home page.
  if (isAuthenticated) {
    redirect('/spaces')
  }

  // If the passcode has not been verified or doesn't match, block access and show the login form.
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-background">
      <LoginForm />
    </main>
  )
}
