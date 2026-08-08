'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Mic, MicOff, Volume2, Loader2, AlertCircle, Send } from 'lucide-react'
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

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (inputText.trim() && isConnected) {
      setMuted(true)
      sendText(inputText)
      setInputText('')
    }
  }

  return (
    <Card className="w-full h-full flex flex-col shadow-none border-0 rounded-none bg-blue-50/30 dark:bg-blue-900/10">
      <CardHeader className="pb-3 shrink-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2 text-blue-700 dark:text-blue-300">
            <Volume2 className="h-5 w-5" />
            Live Voice Tutor
          </CardTitle>
        </div>
      </CardHeader>
      
      <CardContent className="flex-1 overflow-hidden flex flex-col p-4 pt-0">
        {error && (
          <div className="mb-4 text-sm text-red-600 flex items-center gap-2 shrink-0">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
        
        <div className="flex-1 overflow-y-auto mb-4 space-y-4 pr-2 scrollbar-thin scrollbar-thumb-blue-200 dark:scrollbar-thumb-blue-800">
          {messages.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-muted-foreground italic text-center px-4">
              {isConnected ? 'Listening... Speak or type below.' : 'Connect to start chatting hands-free.'}
            </div>
          ) : (
            messages.filter((msg: any) => !msg.text.startsWith('[SYSTEM MESSAGE')).map((msg: any) => (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-4 py-2 text-sm ${msg.role === 'user' ? 'bg-blue-600 text-white' : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'}`}>
                  <div className={`prose max-w-none text-sm ${msg.role === 'user' ? 'text-white prose-p:text-white prose-strong:text-white prose-a:text-white' : 'dark:prose-invert'}`}>
                    <ReactMarkdown 
                      remarkPlugins={[remarkGfm, remarkMath]} 
                      rehypePlugins={[rehypeKatex]}
                      components={{
                        a: ({ href, children }: any) => {
                          if (href && (href.startsWith('/api/file?path=') || href.includes('path='))) {
                            return (
                              <button 
                                onClick={() => onViewFile?.(href)} 
                                className="text-blue-600 dark:text-blue-400 hover:underline font-semibold inline-flex items-center gap-1 bg-transparent border-0 p-0 align-baseline text-left cursor-pointer"
                              >
                                {children}
                              </button>
                            );
                          }
                          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">{children}</a>;
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

        <div className="flex flex-col gap-3 shrink-0 border-t border-blue-100 dark:border-blue-900 pt-4 mt-auto">
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
              className={`flex-1 ${isConnected ? "text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-950/50" : "bg-blue-600 hover:bg-blue-700 text-white"}`}
            >
              {isConnecting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Connecting...</>
              ) : isConnected ? (
                <div className="flex items-center justify-between w-full px-1">
                  <span className="flex items-center"><MicOff className="mr-2 h-4 w-4" /> End Call</span>
                  <kbd className="text-[10px] opacity-60 font-mono bg-background border rounded px-1 shrink-0 ml-2">{platform === 'mac' ? 'Opt+V' : 'Alt+V'}</kbd>
                </div>
              ) : (
                <div className="flex items-center justify-between w-full px-1">
                  <span className="flex items-center"><Mic className="mr-2 h-4 w-4" /> Start Voice Tutor</span>
                  <kbd className="text-[10px] opacity-70 font-mono bg-blue-700 dark:bg-blue-900 border border-blue-500 text-white rounded px-1 shrink-0 ml-2">{platform === 'mac' ? 'Opt+V' : 'Alt+V'}</kbd>
                </div>
              )}
            </Button>

            {isConnected && (
              <Button
                variant={isMuted ? "destructive" : "outline"}
                size="sm"
                onClick={() => setMuted(!isMuted)}
                className="px-3 shrink-0 flex items-center gap-1.5"
                title={isMuted ? "Unmute Microphone" : "Mute Microphone"}
              >
                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                <kbd className="text-[10px] opacity-60 font-mono bg-background border rounded px-1 shrink-0">{platform === 'mac' ? 'Opt+M' : 'Alt+M'}</kbd>
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
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button type="submit" size="icon" disabled={isConnecting || !inputText.trim()}>
              {isConnecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            </Button>
          </form>
        </div>
      </CardContent>
    </Card>
  )
}
