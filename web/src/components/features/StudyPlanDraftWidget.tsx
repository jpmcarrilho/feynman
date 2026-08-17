'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardContent, CardFooter } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Calendar, Clock, Sliders, CheckCircle2 } from 'lucide-react'

interface StudyPlanDraftWidgetProps {
  draftPlan: {
    title: string;
    executiveSummary: string;
    sessions: Array<{
      name: string;
      day: string;
      timeSlot: 'morning' | 'afternoon' | 'night' | 'flexible';
      durationMinutes: number;
      mode: 'study' | 'exam';
      sourcingMix: number;
      focusDescription: string;
      topicIds: string[];
      questionCount: number;
    }>;
  };
  onDeploy: (finalPlan: any) => void;
  onCancel: () => void;
  isDeploying: boolean;
}

export function StudyPlanDraftWidget({
  draftPlan,
  onDeploy,
  onCancel,
  isDeploying,
}: StudyPlanDraftWidgetProps) {
  // Allow the student to live-tweak session settings before deploying
  const [sessions, setSessions] = useState(draftPlan.sessions)
  const [title, setTitle] = useState(draftPlan.title)

  const handleModeToggle = (index: number) => {
    setSessions(prev => prev.map((s, idx) => {
      if (idx !== index) return s;
      return {
        ...s,
        mode: s.mode === 'study' ? 'exam' : 'study'
      };
    }));
  };

  const handleSourcingMixChange = (index: number, val: number) => {
    setSessions(prev => prev.map((s, idx) => {
      if (idx !== index) return s;
      return {
        ...s,
        sourcingMix: val
      };
    }));
  };

  const handleDeleteSession = (index: number) => {
    setSessions(prev => prev.filter((_, idx) => idx !== index));
  };

  // Group sessions by day for a gorgeous column layout
  const daysMap: Record<string, typeof sessions> = {};
  sessions.forEach(s => {
    if (!daysMap[s.day]) {
      daysMap[s.day] = [];
    }
    daysMap[s.day].push(s);
  });

  const handleDeploy = () => {
    onDeploy({
      title,
      executiveSummary: draftPlan.executiveSummary,
      sessions
    });
  };

  return (
    <Card className="w-full bg-card border-2 border-charcoal-graphite/20 shadow-2xl rounded-xl overflow-hidden font-sans animate-sketch-draw">
      <CardHeader className="bg-muted/10 border-b border-charcoal-graphite/10 p-5 sm:p-6 space-y-1.5">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4">
          <div className="space-y-1">
            <span className="text-[10px] bg-lecture-red/10 text-lecture-red px-2 py-1 rounded-full font-bold uppercase tracking-wider">Curriculum Draft Proposal</span>
            <input 
              type="text" 
              value={title} 
              onChange={e => setTitle(e.target.value)}
              className="text-2xl font-bold font-display italic text-charcoal-graphite bg-transparent border-b border-transparent hover:border-charcoal-graphite/30 focus:border-fountain-ink focus:outline-none w-full"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onCancel} className="text-xs h-9 rounded-lg" disabled={isDeploying}>
              Cancel Plan
            </Button>
            <Button 
              size="sm" 
              onClick={handleDeploy} 
              disabled={isDeploying || sessions.length === 0} 
              className="bg-green-600 hover:bg-green-700 text-white font-semibold text-xs h-9 px-4 rounded-lg flex items-center gap-1.5 shadow-sm border-0"
            >
              {isDeploying ? (
                <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Deploying...</>
              ) : (
                <><CheckCircle2 className="w-3.5 h-3.5" /> Approve & Deploy Curriculum</>
              )}
            </Button>
          </div>
        </div>
        <p className="text-xs sm:text-sm text-charcoal-graphite/80 leading-relaxed pt-2">
          {draftPlan.executiveSummary}
        </p>
        <div className="mt-3 bg-bongo-gold/5 border border-bongo-gold/20 text-bongo-gold px-3.5 py-2.5 rounded-lg text-xs leading-relaxed flex items-start gap-2 shadow-xs">
          <span className="text-sm">💡</span>
          <span><strong>Conversational Adjustments</strong>: Want to change this schedule? Simply tell the professor in the chat sidebar (e.g., <em>"Make my morning sessions 3 hours"</em> or <em>"Add more exam mocks on Friday"</em>), then click the gold <strong>Plan</strong> button in the chat header again. The AI will instantly re-design and update this timeline based on your feedback!</span>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <ScrollArea className="w-full whitespace-nowrap overflow-x-auto p-5 sm:p-6">
          <div className="flex gap-6 min-w-max pb-4">
            {Object.entries(daysMap).map(([day, daySessions]) => (
              <div key={day} className="w-[300px] bg-muted/20 p-4 rounded-xl border border-charcoal-graphite/10 space-y-4 shrink-0 flex flex-col">
                <div className="flex items-center gap-2 pb-2 border-b border-charcoal-graphite/10 text-charcoal-graphite">
                  <Calendar className="w-4 h-4 text-lecture-red" />
                  <span className="font-bold text-sm">{day}</span>
                  <span className="text-[10px] ml-auto bg-card px-2 py-0.5 border rounded-full font-semibold">{daySessions.length} slots</span>
                </div>

                <div className="space-y-4 overflow-y-auto max-h-[400px] scrollbar-thin pr-1 flex-1">
                  {daySessions.map((session) => {
                    const globalIdx = sessions.findIndex(s => s === session);
                    return (
                      <div 
                        key={globalIdx} 
                        className="bg-card border border-charcoal-graphite/10 rounded-lg p-3.5 space-y-3 shadow-xs relative group hover:border-fountain-ink/40 transition-colors duration-200"
                      >
                        <button 
                          type="button"
                          onClick={() => handleDeleteSession(globalIdx)}
                          className="absolute top-2 right-2 text-charcoal-graphite/40 hover:text-lecture-red text-[11px] font-bold opacity-0 group-hover:opacity-100 transition-opacity p-1 bg-muted rounded-full"
                          title="Remove session"
                        >
                          ✕
                        </button>

                        <div className="space-y-1">
                          <span className="text-[9px] font-bold tracking-wider uppercase text-fountain-ink flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-fountain-ink inline-block animate-pulse"></span>
                            {session.timeSlot} slot
                          </span>
                          <h5 className="font-bold text-xs sm:text-sm text-charcoal-graphite leading-snug">{session.name}</h5>
                          <p className="text-[10px] text-muted-foreground leading-normal line-clamp-2">{session.focusDescription}</p>
                        </div>

                        <div className="flex flex-col gap-2 pt-2 border-t border-charcoal-graphite/10">
                          {/* Duration & Count row */}
                          <div className="flex items-center gap-3 text-[10px] font-semibold text-charcoal-graphite/60">
                            <span className="flex items-center gap-1"><Clock className="w-3 h-3 text-muted-foreground" /> {session.durationMinutes}m</span>
                            <span className="bg-muted px-2 py-0.5 rounded-sm border">{session.questionCount} Questions</span>
                          </div>

                          {/* Mode Toggle Controls */}
                          <div className="flex items-center justify-between gap-2 pt-1">
                            <span className="text-[9px] font-bold text-charcoal-graphite/50 uppercase">Type:</span>
                            <button
                              type="button"
                              onClick={() => handleModeToggle(globalIdx)}
                              className={`text-[10px] font-semibold px-2 py-0.5 rounded-md border transition-all duration-200 ${
                                session.mode === 'exam'
                                  ? 'bg-lecture-red/10 border-lecture-red/30 text-lecture-red'
                                  : 'bg-green-50 border-green-200 text-green-700'
                              }`}
                            >
                              {session.mode === 'exam' ? '⏱️ Timed Exam' : '🎓 Practice'}
                            </button>
                          </div>

                          {/* Sourcing Mix Select Control */}
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[9px] font-bold text-charcoal-graphite/50 uppercase flex items-center gap-1"><Sliders className="w-2.5 h-2.5" /> Sourcing:</span>
                            <select
                              value={session.sourcingMix}
                              onChange={e => handleSourcingMixChange(globalIdx, Number(e.target.value))}
                              className="text-[10px] h-7 bg-transparent border rounded-md px-1 py-0.5 text-charcoal-graphite outline-none focus:ring-1 focus:ring-fountain-ink w-[100px]"
                            >
                              <option value="0">100% Ingested</option>
                              <option value="25">75% In/25% AI</option>
                              <option value="50">50% In/50% AI</option>
                              <option value="75">25% In/75% AI</option>
                              <option value="100">100% AI</option>
                            </select>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
