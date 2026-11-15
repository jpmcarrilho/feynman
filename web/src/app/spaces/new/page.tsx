import { redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { NewSpaceForm } from '@/components/features/spaces/NewSpaceForm'

export const dynamic = 'force-dynamic'

export default async function NewSpacePage() {
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }
  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <NewSpaceForm />
      </div>
    </main>
  )
}
