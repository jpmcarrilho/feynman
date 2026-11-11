import Link from 'next/link'
import { Plus } from 'lucide-react'
import { redirect } from 'next/navigation'
import { checkIsAuthenticated } from '@/app/auth-actions'
import { listStudyspacesAction } from '@/app/spaces/actions'
import { getOverallDiagnosis } from '@/services/spaceSummaries'
import { FeynmanLogo } from '@/components/features/FeynmanLogo'
import { SpaceCard } from '@/components/features/spaces/SpaceCard'
import { OverallDiagnosis } from '@/components/features/spaces/OverallDiagnosis'

export const dynamic = 'force-dynamic'

export default async function SpacesPage() {
  // Guard on the server first: nothing below runs for a visitor without the passcode cookie
  if (!(await checkIsAuthenticated())) {
    redirect('/')
  }

  const [spaces, overallDiagnosis] = await Promise.all([listStudyspacesAction(), getOverallDiagnosis()])

  return (
    <main className="min-h-screen bg-background px-4 py-8 sm:px-8 sm:py-12">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex items-center gap-3 select-none">
          <FeynmanLogo variant="mini" size={44} className="stroke-charcoal-graphite shrink-0" />
          <div className="min-w-0">
            <h1 className="font-display text-3xl font-bold italic tracking-tight text-charcoal-graphite">Studyspaces</h1>
            <p className="text-sm text-charcoal-graphite/60 font-sans">Pick one to study. Everything you see there belongs to that studyspace only.</p>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {spaces.map((space) => (
            <SpaceCard key={space.id} space={space} />
          ))}
          <Link
            href="/spaces/new"
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-charcoal-graphite/25 p-6 text-center font-sans text-charcoal-graphite/70 transition-colors hover:border-charcoal-graphite/50 hover:bg-card hover:text-charcoal-graphite focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fountain-ink"
          >
            <Plus className="size-6" aria-hidden />
            <span className="text-base font-semibold">New studyspace</span>
            <span className="text-xs">Upload your own notes, slides or PDFs.</span>
          </Link>
        </div>

        {overallDiagnosis && <OverallDiagnosis text={overallDiagnosis} />}
      </div>
    </main>
  )
}
