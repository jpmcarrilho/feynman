import Link from 'next/link'
import { buttonVariants } from '@/components/ui/button'
import { FeynmanLogo } from '@/components/features/FeynmanLogo'

export default function SpaceNotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center font-sans">
      <FeynmanLogo variant="thinking" size={120} />
      <h1 className="font-display text-2xl font-bold italic text-charcoal-graphite">Studyspace not found</h1>
      <p className="max-w-sm text-sm text-charcoal-graphite/60">This studyspace does not exist, or it was removed.</p>
      <Link href="/spaces" className={buttonVariants({ className: 'h-11 bg-lecture-red px-6 text-white hover:bg-lecture-red/90 border-0 font-semibold' })}>
        Back to studyspaces
      </Link>
    </main>
  )
}
