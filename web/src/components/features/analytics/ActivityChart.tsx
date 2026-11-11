'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface ActivityChartProps {
  activityData: { date: string, sessions: number }[]
}

export function ActivityChart({ activityData }: ActivityChartProps) {
  return (
    <Card className="col-span-1 lg:col-span-2 border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
      <CardHeader className="border-b border-charcoal-graphite/5 pb-4 mb-4">
        <CardTitle className="font-display italic text-lg font-bold text-charcoal-graphite">Weekly Activity</CardTitle>
        <CardDescription className="text-charcoal-graphite/60 font-sans text-xs">Number of sessions started per day</CardDescription>
      </CardHeader>
      <CardContent className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={activityData} margin={{ top: 20, right: 20, bottom: 20, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis 
              dataKey="date" 
              tick={{ fontSize: 10, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }}
              tickFormatter={(str) => {
                // "YYYY-MM-DD" is a calendar day; reading it through Date would shift it by the time zone offset
                const [, month, day] = String(str).split('-');
                return `${Number(month)}/${Number(day)}`;
              }}
            />
            <YAxis allowDecimals={false} tick={{ fontSize: 10, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }} />
            <Tooltip 
              contentStyle={{ 
                backgroundColor: 'var(--card, #FFFFFF)', 
                borderColor: 'rgba(44, 46, 51, 0.15)',
                color: 'var(--charcoal-graphite, #2C2E33)',
                fontSize: 12,
                fontFamily: 'sans-serif',
                borderRadius: '6px'
              }}
            />
            <Line type="monotone" dataKey="sessions" stroke="var(--charcoal-graphite, #2C2E33)" strokeWidth={2.5} dot={{ r: 4, fill: "var(--fountain-ink)", stroke: "var(--charcoal-graphite)", strokeWidth: 1.5 }} />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
