'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Mic, MicOff, Volume2, AlertCircle, Send, Loader2 } from 'lucide-react'
import { FeynmanLogo } from './FeynmanLogo'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

const preprocessLaTeX = (text: string | null | undefined) => {
  if (!text) return '';
  let processed = text.replace(/\\\[([\s\S]*?)\\\]/g, '$$$$$1$$$$');
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, '$$$1$$');
  return processed;
}

interface VoiceHubProps {
  liveAPI: any;
  onViewFile?: (filePath: string) => void;
}

export function VoiceHub({ liveAPI, onViewFile }: VoiceHubProps) {
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

  return (
    <Card className="w-full h-full flex flex-col shadow-none border-0 rounded-none bg-card text-charcoal-graphite">
      <CardHeader className="pb-3 shrink-0 border-b border-charcoal-graphite/10">
        <div className="flex items-center justify-between">
          <CardTitle className="text-xl flex items-center gap-3 font-display italic text-fountain-ink select-none">
            <FeynmanLogo variant="mini" size={32} className="stroke-fountain-ink transition-transform duration-200 hover:scale-105" />
            Talk to the Professor
          </CardTitle>
        </div>
      </CardHeader>
      
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
                          if (href && (href.startsWith('/api/file?path=') || href.includes('path='))) {
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
