'use client'

import { DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { PlayCircle, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getSessionDetail, getSessionResults } from '@/app/actions'
import type { SessionResultItem } from '@/services/sessionService'
import { sessionHeadline, formatScore } from '@/lib/grading'

interface ChatMessage {
  role: string;
  text?: string;
}

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
  const [loaded, setLoaded] = useState<{ id: string; messages: ChatMessage[] } | null>(null);
  const [loadedResults, setLoadedResults] = useState<{ id: string; items: SessionResultItem[] } | null>(null);
  const sessionId: string | undefined = selectedHistory?.id;
  // null while the transcript for the current session is still loading
  const chatLog = loaded && loaded.id === sessionId ? loaded.messages : null;

  // The question list is not part of the history list either (it would carry every question's text)
  const resultItems = loadedResults && loadedResults.id === sessionId ? loadedResults.items : null;
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    getSessionResults(sessionId)
      .then(items => { if (!cancelled) setLoadedResults({ id: sessionId, items }); })
      .catch(e => {
        console.error('Failed to load session results', e);
        if (!cancelled) setLoadedResults({ id: sessionId, items: [] });
      });
    return () => { cancelled = true; };
  }, [sessionId]);

  // The transcript is not part of the history list; load it when the dialog opens.
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    getSessionDetail(sessionId)
      .then(detail => {
        if (cancelled) return;
        let parsed: unknown = [];
        try {
          parsed = detail?.chatLog ? JSON.parse(detail.chatLog) : [];
        } catch {
          parsed = [];
        }
        setLoaded({ id: sessionId, messages: Array.isArray(parsed) ? parsed : [] });
      })
      .catch(e => {
        console.error('Failed to load session detail', e);
        if (!cancelled) setLoaded({ id: sessionId, messages: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!selectedHistory) return null;

  const visibleMessages = (chatLog || []).filter(m => !String(m.text ?? '').startsWith('[SYSTEM'));

  // The headline is the history list's own value (shared helper); the listed questions only add a note
  const { scoreSum, correctCount, total: totalCount, notAnswered } = sessionHeadline({
    mode: selectedHistory.mode,
    exerciseCount: selectedHistory.exerciseCount,
    logs: selectedHistory.logs,
  });

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Session Results</DialogTitle>
      </DialogHeader>
      <div className="py-4 space-y-6">
        <div className="space-y-2 border-b pb-4">
          <p className="text-sm"><strong>Date:</strong> {new Date(selectedHistory.startTime).toLocaleString()}</p>
          <p className="text-sm"><strong>Score:</strong> {formatScore(scoreSum)} / {totalCount} ({correctCount} fully correct{notAnswered > 0 ? `, ${notAnswered} not answered` : ''})</p>
          {resultItems === null && selectedHistory.logs.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading questions...</div>
          )}
          {resultItems !== null && resultItems.length > 0 && (
            <ScrollArea className="h-[250px] border rounded-md p-3 mt-2 bg-muted/30">
              {resultItems.map(item => (
                <div key={item.exerciseId} className="text-sm py-3 border-b last:border-0 flex flex-col gap-1">
                  <div className="flex items-start gap-2 font-medium">
                    <span className="mt-0.5">{item.log ? (item.log.isCorrect ? '✅' : '❌') : '➖'}</span>
                    <span className="line-clamp-2">Q{item.position + 1}: {item.questionText}</span>
                    {item.log && item.log.score > 0 && item.log.score < 1 && (
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{formatScore(item.log.score)} pt</span>
                    )}
                  </div>
                  <div className="pl-6 space-y-0.5 text-xs">
                    {item.log ? (
                      <>
                        <p className="text-muted-foreground"><span className="font-semibold text-foreground/70">Your Answer:</span> {item.log.userAnswer || 'Skipped'}</p>
                        {!item.log.isCorrect && (
                          <p className="text-green-600 dark:text-green-500"><span className="font-semibold">Correct Answer:</span> {item.correctAnswer}</p>
                        )}
                      </>
                    ) : (
                      <p className="text-muted-foreground italic">Not answered</p>
                    )}
                  </div>
                </div>
              ))}
            </ScrollArea>
          )}
        </div>

        <div className="space-y-2">
          <Label className="font-semibold">Tutor Chat History</Label>
          {chatLog === null ? (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading conversation...
            </div>
          ) : visibleMessages.length > 0 ? (
            <ScrollArea className="h-[250px] border rounded-md p-3 bg-muted/10 scrollbar-thin">
              {visibleMessages.map((msg, idx) => (
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
