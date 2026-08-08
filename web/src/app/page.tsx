import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { FeynmanLogo } from '@/components/features/FeynmanLogo'

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-6 bg-background">
      <div className="flex flex-col items-center mb-4 select-none">
        <FeynmanLogo size={200} />
      </div>
      <Card className="w-full max-w-md border border-charcoal-graphite/10 shadow-lg bg-background/50">
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-3xl font-bold font-display italic text-charcoal-graphite">Feynman Study Hub</CardTitle>
          <CardDescription className="text-charcoal-graphite/60 font-sans mt-2">
            "Understand everything. Simplify anything."
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pt-2">
          <p className="text-sm text-center text-charcoal-graphite/60 leading-relaxed font-sans mb-2">
            Master the MIT DEDP MicroMasters content with your personal hands-free AI physics and economics tutor.
          </p>
          <Link href="/study" className="w-full">
            <Button className="w-full bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold py-3 h-12 border-0 shadow-sm transition-all duration-200 text-base">
              Start Study Session
            </Button>
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}