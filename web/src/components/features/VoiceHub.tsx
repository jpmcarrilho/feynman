'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Mic, MicOff, Volume2, AlertCircle, Send, Loader2, Sparkles, PanelRightClose } from 'lucide-react'
import { FeynmanLogo } from './FeynmanLogo'
import { chatModeSwitchMessage, CHAT_MODE_LABELS, CHAT_MODE_HINTS } from '@/lib/prompts'
import { ChatModeEnum, type TutorChatMode, type TutorProfile } from '@/lib/studyspace/profile'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { parseFileLink } from '@/lib/fileLinks'

const preprocessLaTeX = (text: string | null | undefined) => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return processed;
}

interface VoiceHubProps {
  liveAPI: any;
  onViewFile?: (href: string, title?: string) => void;
  onGeneratePlan?: () => void;
  isGeneratingPlan?: boolean;
  onToggleClose?: () => void;
  /** Tutor chat mode selector. Rendered only when chatMode, onChatModeChange and chatModeProfile are given, and never in exam sessions. */
  chatMode?: TutorChatMode;
  onChatModeChange?: (mode: TutorChatMode) => void;
  chatModeProfile?: TutorProfile;
  sessionMode?: string | null;
}

export function VoiceHub({ liveAPI, onViewFile, onGeneratePlan, isGeneratingPlan = false, onToggleClose, chatMode, onChatModeChange, chatModeProfile, sessionMode }: VoiceHubProps) {
  const { isConnected, isConnecting, error, messages, connect, disconnect, sendText, isMuted, setMuted } = liveAPI
  
  const [inputText, setInputText] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  
  type Platform = 'mac' | 'windows' | 'linux' | 'other'
  const [platform, setPlatform] = useState<Platform>('other')

  useEffect(() => {
    const userAgent = navigator.userAgent.toLowerCase();
    if (userAgent.indexOf('mac') !== -1) {
      setPlatform('mac');
    } else if (userAgent.indexOf('win') !== -1) {
      setPlatform('windows');
    } else if (userAgent.indexOf('linux') !== -1) {
      setPlatform('linux');
    } else {
      setPlatform('other');
    }
  }, [])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const showChatModes = !!chatMode && !!onChatModeChange && !!chatModeProfile && sessionMode !== 'exam'

  const selectChatMode = (mode: TutorChatMode) => {
    if (!chatMode || !onChatModeChange || !chatModeProfile || mode === chatMode) return
    onChatModeChange(mode)
    // One hidden message tells the connected tutor about the switch; the exercise context is not re-sent
    if (isConnected && typeof liveAPI.sendContext === 'function') {
      liveAPI.sendContext(chatModeSwitchMessage(chatModeProfile, mode, sessionMode), { interrupt: false })
    }
  }

  return (
    <Card className="w-full h-full flex flex-col shadow-none border-0 rounded-none bg-card text-charcoal-graphite">
      <CardHeader className="pb-3 shrink-0 border-b border-charcoal-graphite/10">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base sm:text-lg font-display italic text-fountain-ink select-none truncate">
            Talk to the Professor
          </CardTitle>
          <div className="flex items-center gap-1.5 shrink-0">
            {onToggleClose && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onToggleClose}
                title="Hide Professor Sidebar"
                className="h-8 w-8 text-charcoal-graphite/70 hover:bg-muted rounded-md transition-all duration-200"
              >
                <PanelRightClose className="w-4 h-4" />
              </Button>
            )}
            <Button
              variant="ghost"
                onClick={() => {
                  if (typeof window !== 'undefined' && window.confirm("Clear all conversation history and start fresh with the professor?")) {
                    liveAPI.setMessages([]);
                  }
                }}
                className="text-[10px] h-8 px-2 rounded-md hover:bg-muted text-muted-foreground font-semibold"
                title="Clear all conversation messages"
              >
                Clear
              </Button>
              </div>
        </div>
      </CardHeader>

      {showChatModes && (
        <div className="shrink-0 px-4 pt-3" data-testid="chat-mode-selector">
          <div role="radiogroup" aria-label="Tutor mode" className="grid grid-cols-3 gap-1 rounded-lg bg-muted/50 p-1">
            {ChatModeEnum.options.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={chatMode === mode}
                title={CHAT_MODE_HINTS[mode]}
                onClick={() => selectChatMode(mode)}
                className={`rounded-md px-2 py-1 text-xs font-semibold transition-colors ${
                  chatMode === mode
                    ? 'bg-background text-fountain-ink shadow-sm'
                    : 'text-charcoal-graphite/60 hover:text-charcoal-graphite'
                }`}
              >
                {CHAT_MODE_LABELS[mode]}
              </button>
            ))}
          </div>
        </div>
      )}
      
      <CardContent className="flex-1 overflow-hidden flex flex-col p-4 pt-4">
        {error && (
          <div className="mb-4 text-sm text-lecture-red flex items-center gap-2 shrink-0 font-medium animate-pulse">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2 scrollbar-thin scrollbar-thumb-charcoal-graphite/10 scrollbar-track-transparent">
          {messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-sm text-charcoal-graphite/40 italic text-center px-4 gap-3">
              {isConnected ? (
                <>
                  <FeynmanLogo variant="thinking" size={48} />
                  <span>Listening... Speak or type below.</span>
                </>
              ) : (
                <span>Connect to start chatting hands-free.</span>
              )}
            </div>
          ) : (
            messages.filter((msg: any) => !msg.text.startsWith('[SYSTEM MESSAGE')).map((msg: any) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div 
                  className={`max-w-[85%] rounded-xl px-4 py-2 text-sm shadow-sm border ${
                    msg.role === 'user' 
                      ? 'bg-fountain-ink/10 text-charcoal-graphite border-fountain-ink/20' 
                      : 'bg-muted/40 text-charcoal-graphite border-charcoal-graphite/10'
                  }`}
                >
                  <div className={`prose max-w-none text-sm leading-relaxed ${
                    msg.role === 'user' 
                      ? 'text-charcoal-graphite prose-p:text-charcoal-graphite prose-strong:text-charcoal-graphite prose-a:text-fountain-ink' 
                      : 'text-charcoal-graphite/90 prose-p:text-charcoal-graphite/90 prose-strong:text-charcoal-graphite prose-a:text-fountain-ink'
                  }`}>
                    <ReactMarkdown 
                      remarkPlugins={[remarkGfm, remarkMath]} 
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        a: ({ href, children }: any) => {
                          if (href && parseFileLink(href, window.location.origin)) {
                            return (
                              <button 
                                onClick={() => onViewFile?.(href)} 
                                className="text-fountain-ink hover:underline font-semibold inline-flex items-center gap-1 bg-transparent border-0 p-0 align-baseline text-left cursor-pointer"
                              >
                                {children}
                              </button>
                            );
                          }
                          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-fountain-ink hover:underline">{children}</a>;
                        }
                      }}
                    >
                      {preprocessLaTeX(msg.text)}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="flex flex-col gap-3 shrink-0 border-t border-charcoal-graphite/10 pt-4 mt-auto">
          {/* Connection Controls at Bottom */}
          <div className="flex gap-2 w-full justify-between items-center">
            <Button 
              variant={isConnected ? "outline" : "default"}
              size="sm"
              onClick={() => {
                if (isConnected) {
                  disconnect()
                } else {
                  connect(true) // Explicitly enable audio
                }
              }}
              disabled={isConnecting}
              className={`flex-1 transition-colors duration-200 ${
                isConnected 
                  ? "text-lecture-red border-lecture-red/30 hover:bg-lecture-red/10 hover:text-lecture-red" 
                  : "bg-lecture-red hover:bg-lecture-red/90 text-white border-0 shadow-sm font-semibold"
              }`}
            >
              {isConnecting ? (
                <div className="flex items-center justify-center">
                  <FeynmanLogo variant="thinking" size={16} className="mr-2" />
                  <span>Connecting...</span>
                </div>
              ) : isConnected ? (
                <div className="flex items-center justify-between w-full px-1">
                  <span className="flex items-center"><MicOff className="mr-2 h-4 w-4" /> End Call</span>
                  <kbd className="text-[10px] opacity-60 font-mono bg-background border border-charcoal-graphite/10 rounded px-1 shrink-0 ml-2">{platform === 'mac' ? 'Opt+V' : 'Alt+V'}</kbd>
                </div>
              ) : (
                <div className="flex items-center justify-between w-full px-1">
                  <span className="flex items-center"><Mic className="mr-2 h-4 w-4" /> Start Voice Tutor</span>
                  <kbd className="text-[10px] opacity-75 font-mono bg-lecture-red/80 border border-lecture-red/40 text-white rounded px-1 shrink-0 ml-2">{platform === 'mac' ? 'Opt+V' : 'Alt+V'}</kbd>
                </div>
              )}
            </Button>

            {isConnected && (
              <Button
                variant={isMuted ? "destructive" : "outline"}
                size="sm"
                onClick={() => setMuted(!isMuted)}
                className="px-3 shrink-0 flex items-center gap-1.5 border-charcoal-graphite/10 hover:bg-muted"
                title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMuted ? <MicOff className="h-4 w-4 text-lecture-red" /> : <Mic className="h-4 w-4" />}
                <kbd className="text-[10px] opacity-60 font-mono bg-background border border-charcoal-graphite/10 rounded px-1 shrink-0">{platform === 'mac' ? 'Opt+M' : 'Alt+M'}</kbd>
              </Button>
            )}
          </div>

          <form onSubmit={(e) => {
            e.preventDefault();
            if (!inputText.trim()) return;
            
            setMuted(true); // Mute mic when sending text
            
            if (!isConnected) {
              connect(false).then(() => { // Text-only mode
                setTimeout(() => sendText(inputText), 1000)
              });
              setInputText('');
            } else {
              sendText(inputText);
              setInputText('');
            }
          }} className="flex gap-2 w-full">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Type a message to start chatting..."
              className="flex-1 rounded-md border border-charcoal-graphite/15 bg-background text-charcoal-graphite px-3 py-2 text-sm placeholder:text-charcoal-graphite/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fountain-ink"
            />
            <Button 
              type="submit" 
              size="icon" 
              className="bg-fountain-ink hover:bg-fountain-ink/90 border-0 text-white shrink-0" 
              disabled={isConnecting || !inputText.trim()}
            >
              {isConnecting ? (
                <FeynmanLogo variant="thinking" size={16} />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
