'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { FeynmanLogo } from './FeynmanLogo'
import { loginWithPasscode } from '@/app/auth-actions'
import { Loader2, ShieldAlert } from 'lucide-react'

export function LoginForm() {
  const [passcode, setPasscode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setLoading(true)

    try {
      const res = await loginWithPasscode(passcode)
      if (res.success) {
        // Trigger page refresh to make the Server Component re-check credentials
        router.refresh()
      } else {
        setError(res.error || 'Authentication failed.')
      }
    } catch (err) {
      setError('An error occurred. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] w-full max-w-sm mx-auto">
      <div className="flex flex-col items-center mb-6 select-none animate-fade-in">
        <FeynmanLogo size={140} variant="thinking" />
      </div>
      <Card className="w-full border border-charcoal-graphite/10 shadow-lg bg-background/50">
        <CardHeader className="text-center pb-4">
          <CardTitle className="text-2xl font-bold font-display italic text-charcoal-graphite">Passcode Gate</CardTitle>
          <CardDescription className="text-charcoal-graphite/60 mt-1">
            This study workspace is protected. Enter your passcode to enter.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2">
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="relative">
              <Input
                type="password"
                placeholder="••••••••"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                disabled={loading}
                className="text-center tracking-widest text-xl font-mono border-charcoal-graphite/20 focus:border-lecture-red focus:ring-lecture-red/20 h-12"
                required
                autoFocus
              />
            </div>
            
            {error && (
              <div className="text-sm text-lecture-red flex items-center justify-center gap-1.5 font-medium bg-lecture-red/5 py-2 px-3 rounded-lg border border-lecture-red/10 animate-shake">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            
            <Button 
              type="submit" 
              disabled={loading}
              className="w-full bg-lecture-red hover:bg-lecture-red/90 text-white font-semibold py-3 h-12 border-0 shadow-sm transition-all duration-200 text-base"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-5 h-5 animate-spin text-white" />
                  <span>Verifying...</span>
                </span>
              ) : (
                'Enter Workspace'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
