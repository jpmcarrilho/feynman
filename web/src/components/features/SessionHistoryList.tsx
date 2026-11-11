'use client'

import { Button } from '@/components/ui/button'
import { History, Trash2 } from 'lucide-react'

interface SessionHistoryListProps {
  histories: any[];
  session: any;
  setSelectedHistory: (h: any) => void;
  onDeleteSession: (e: React.MouseEvent, id: string) => void;
}

export function SessionHistoryList({
  histories,
  session,
  setSelectedHistory,
  onDeleteSession,
}: SessionHistoryListProps) {
  return (
    <div className="space-y-2">
      {histories.map(h => {
        const logs = h.logs || [];
        const answeredLogs = logs.filter((l: any) => l.userAnswer !== null && l.userAnswer !== undefined && l.userAnswer !== '');
        const correct = logs.filter((l: any) => l.isCorrect).length;
        const total = h.mode === 'exam' && h.exerciseCount
          ? h.exerciseCount
          : answeredLogs.length;
        const isActiveSession = session?.id === h.id;
        return (
          <div 
            key={h.id} 
            className={`text-xs p-3 border rounded-md shadow-sm cursor-pointer transition-colors group relative pr-8 ${
              isActiveSession 
                ? 'bg-background text-charcoal-graphite border-fountain-ink/40 shadow-md font-semibold' 
                : 'bg-muted/40 text-charcoal-graphite/70 border-charcoal-graphite/10 hover:bg-muted hover:text-charcoal-graphite'
            }`}
            onClick={() => setSelectedHistory(h)}
          >
            <div className="font-medium text-charcoal-graphite">
              {h.title || new Date(h.startTime).toLocaleString()}
            </div>
            {h.title && (
              <div className="text-[10px] mt-0.5 text-charcoal-graphite/50">
                {new Date(h.startTime).toLocaleString()}
              </div>
            )}
            <div className="mt-1 flex justify-between text-charcoal-graphite/60">
              <span>{h.status === 'cancelled' ? 'No score' : `Score: ${correct}/${total}`}</span>
              <span className={h.status === 'active' ? 'text-lecture-red font-semibold' : h.status === 'cancelled' ? 'text-charcoal-graphite/50' : isActiveSession ? 'text-fountain-ink' : 'text-fountain-ink/80'}>
                {h.status === 'cancelled' ? 'Cancelled' : h.status}
              </span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className={`h-6 w-6 absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity ${
                isActiveSession 
                  ? 'text-lecture-red hover:bg-lecture-red/10' 
                  : 'text-charcoal-graphite/40 hover:text-lecture-red hover:bg-lecture-red/10'
              }`}
              onClick={(e) => onDeleteSession(e, h.id)}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          </div>
        )
      })}
      {histories.length === 0 && (
        <div className="text-sm text-muted-foreground text-center py-4">No past sessions</div>
      )}
    </div>
  )
}
