'use client'

import { DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PlayCircle } from 'lucide-react'

interface SessionResultsDialogProps {
  selectedHistory: any;
  onLoadSession: (id: string) => void;
  isLoading: boolean;
}

export function SessionResultsDialog({
  selectedHistory,
  onLoadSession,
  isLoading,
}: SessionResultsDialogProps) {
  if (!selectedHistory) return null;

  const answeredLogs = selectedHistory.logs.filter((l: any) => l.userAnswer !== null && l.userAnswer !== undefined && l.userAnswer !== '');
  const correctCount = selectedHistory.logs.filter((l: any) => l.isCorrect).length;
  const totalCount = selectedHistory.mode === 'exam' && selectedHistory.exerciseIds
    ? JSON.parse(selectedHistory.exerciseIds).length
    : answeredLogs.length;

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Session Results</DialogTitle>
      </DialogHeader>
      <div className="py-4 space-y-6">
        <div className="space-y-2 border-b pb-4">
          <p className="text-sm"><strong>Date:</strong> {new Date(selectedHistory.startTime).toLocaleString()}</p>
          <p className="text-sm"><strong>Score:</strong> {correctCount} / {totalCount} correct</p>
          {selectedHistory.logs.length > 0 && (
            <ScrollArea className="h-[250px] border rounded-md p-3 mt-2 bg-muted/30">
              {selectedHistory.logs.map((log: any, idx: number) => (
                <div key={log.id} className="text-sm py-3 border-b last:border-0 flex flex-col gap-1">
                  <div className="flex items-start gap-2 font-medium">
                    <span className="mt-0.5">{log.isCorrect ? '✅' : '❌'}</span>
                    <span className="line-clamp-2">Q{idx + 1}: {log.exercise?.questionText}</span>
                  </div>
                  <div className="pl-6 space-y-0.5 text-xs">
                    <p className="text-muted-foreground"><span className="font-semibold text-foreground/70">Your Answer:</span> {log.userAnswer || 'Skipped'}</p>
                    {!log.isCorrect && (
                      <p className="text-green-600 dark:text-green-500"><span className="font-semibold">Correct Answer:</span> {log.exercise?.correctAnswer}</p>
                    )}
                  </div>
                </div>
              ))}
            </ScrollArea>
          )}
        </div>

        <div className="space-y-2">
          <Label className="font-semibold">Tutor Chat History</Label>
          {selectedHistory.chatLog ? (
            <ScrollArea className="h-[250px] border rounded-md p-3 bg-muted/10 scrollbar-thin">
              {JSON.parse(selectedHistory.chatLog).filter((m: any) => !m.text.startsWith('[SYSTEM')).map((msg: any, idx: number) => (
                <div key={idx} className={`flex mb-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-xl px-4 py-2 text-sm shadow-sm border ${
                    msg.role === 'user' 
                      ? 'bg-fountain-ink/15 border-fountain-ink/25 text-charcoal-graphite' 
                      : 'bg-background border-charcoal-graphite/10 text-charcoal-graphite/90'
                  }`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {JSON.parse(selectedHistory.chatLog).filter((m: any) => !m.text.startsWith('[SYSTEM')).length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4">No conversation recorded.</div>
              )}
            </ScrollArea>
          ) : (
            <div className="text-sm text-muted-foreground text-center py-4">No conversation recorded.</div>
          )}
        </div>

        <div className="pt-4 border-t">
          <Button 
            className="w-full bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold h-11" 
            onClick={() => onLoadSession(selectedHistory.id)}
            disabled={isLoading}
          >
            <PlayCircle className="w-4 h-4 mr-2" />
            Load This Session
          </Button>
        </div>
      </div>
    </DialogContent>
  )
}
