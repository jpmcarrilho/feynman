'use client'

import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Mic, MicOff, Volume2, Loader2, AlertCircle, Send } from 'lucide-react'

interface VoiceHubProps {
  liveAPI: any
}

export function VoiceHub({ liveAPI }: VoiceHubProps) {
  const { isConnected, isConnecting, error, messages, connect, disconnect, sendText } = liveAPI
  
  const [inputText, setInputText] = useState('')
  const [isMuted, setIsMuted] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault()
    if (inputText.trim() && isConnected) {
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
                  {msg.text}
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
                <><MicOff className="mr-2 h-4 w-4" /> End Call</>
              ) : (
                <><Mic className="mr-2 h-4 w-4" /> Start Voice Tutor</>
              )}
            </Button>
          </div>

          <form onSubmit={(e) => {
            e.preventDefault();
            if (!inputText.trim()) return;
            
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
