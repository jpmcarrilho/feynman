'use client'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface CourseAccuracyChartProps {
  courseAccuracyData: { name: string, accuracy: number, total: number }[]
}

export function CourseAccuracyChart({ courseAccuracyData }: CourseAccuracyChartProps) {
  return (
    <Card className="col-span-1 border border-charcoal-graphite/10 shadow-sm bg-card text-charcoal-graphite">
      <CardHeader className="border-b border-charcoal-graphite/5 pb-4 mb-4">
        <CardTitle className="font-display italic text-lg font-bold text-charcoal-graphite">Course Accuracy</CardTitle>
        <CardDescription className="text-charcoal-graphite/60 font-sans text-xs">Percentage of correct answers by course</CardDescription>
      </CardHeader>
      <CardContent className="h-[300px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={courseAccuracyData} margin={{ top: 20, right: 20, bottom: 20, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="name" tick={{ fontSize: 11, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }} />
            <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: 'var(--charcoal-graphite, #2C2E33)', opacity: 0.7 }} />
            <Tooltip 
              cursor={{ fill: 'transparent' }}
              contentStyle={{ 
                backgroundColor: 'var(--card, #FFFFFF)', 
                borderColor: 'rgba(44, 46, 51, 0.15)',
                color: 'var(--charcoal-graphite, #2C2E33)',
                fontSize: 12,
                fontFamily: 'sans-serif',
                borderRadius: '6px'
              }}
            />
            <Bar dataKey="accuracy" fill="var(--fountain-ink, #3B6D9A)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
