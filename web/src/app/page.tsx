import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-24">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>DEDP Study Hub</CardTitle>
          <CardDescription>Master the MIT DEDP MicroMasters content.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Link href="/study" className="w-full">
            <Button className="w-full">Start Study Session</Button>
          </Link>
        </CardContent>
      </Card>
    </main>
  )
}