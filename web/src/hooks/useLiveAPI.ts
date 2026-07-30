import { useState, useRef, useCallback } from 'react'

export type ChatMessage = {
  id: string
  role: 'user' | 'model' | 'system'
  text: string
}

export function useLiveAPI(systemInstructionText: string) {
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  
  // For playback scheduling
  const nextPlayTimeRef = useRef<number>(0)

  // Converts ArrayBuffer (PCM16) to Base64 string
  const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    return window.btoa(binary)
  }

  // Converts Base64 string to Float32Array for Web Audio API playback
  const base64ToFloat32Array = (base64: string) => {
    const binary = window.atob(base64)
    const pcm16 = new Int16Array(binary.length / 2)
    for (let i = 0; i < pcm16.length; i++) {
      const byteA = binary.charCodeAt(i * 2)
      const byteB = binary.charCodeAt(i * 2 + 1)
      pcm16[i] = byteA | (byteB << 8)
    }
    const float32 = new Float32Array(pcm16.length)
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0
    }
    return float32
  }

  const addMessage = (role: 'user' | 'model' | 'system', text: string) => {
    if (!text.trim()) return
    setMessages(prev => {
      // Append text if it's the same role in the last message (streaming accumulation)
      const last = prev[prev.length - 1]
      if (last && last.role === role) {
        const newMsg = { ...last, text: last.text + text }
        return [...prev.slice(0, -1), newMsg]
      }
      return [...prev, { id: Date.now().toString() + Math.random(), role, text }]
    })
  }

  const playAudioChunk = (base64: string) => {
    if (!audioContextRef.current) return
    const float32 = base64ToFloat32Array(base64)
    const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000)
    buffer.getChannelData(0).set(float32)

    const source = audioContextRef.current.createBufferSource()
    source.buffer = buffer
    source.connect(audioContextRef.current.destination)

    const currentTime = audioContextRef.current.currentTime
    const playTime = Math.max(currentTime, nextPlayTimeRef.current)
    source.start(playTime)
    nextPlayTimeRef.current = playTime + buffer.duration
  }

  const connect = async (audioEnabled: boolean = true) => {
    setIsConnecting(true)
    setError(null)
    
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 })
      audioContextRef.current = audioCtx
      nextPlayTimeRef.current = audioCtx.currentTime

      if (audioEnabled) {
        // 1. Init Audio Recording
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
        
        await audioCtx.audioWorklet.addModule('/audio-worklet.js')
        const source = audioCtx.createMediaStreamSource(stream)
        sourceRef.current = source

        const processor = new AudioWorkletNode(audioCtx, 'audio-recorder-worklet')
        processorRef.current = processor
      }

      // 2. Init WebSocket
      const key = process.env.NEXT_PUBLIC_GEMINI_API_KEY
      if (!key) throw new Error("Missing NEXT_PUBLIC_GEMINI_API_KEY")

      const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${key}`
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // Build system instruction with history if any
        const historyText = messages.filter(m => !m.text.startsWith('[SYSTEM MESSAGE')).map(m => `${m.role}: ${m.text}`).join('\n')
        const fullSystemInstruction = systemInstructionText + (historyText ? `\n\n[Previous conversation context:]\n${historyText}` : '')

        // Send initial setup
        ws.send(JSON.stringify({
          setup: {
            model: 'models/gemini-3.1-flash-live-preview',
            generationConfig: {
              responseModalities: audioEnabled ? ["AUDIO"] : ["TEXT"]
            },
            systemInstruction: {
              parts: [{ text: fullSystemInstruction }]
            }
          }
        }))
        setIsConnected(true)
        setIsConnecting(false)
        
        // Start processing audio if enabled
        if (audioEnabled && processorRef.current && sourceRef.current) {
          processorRef.current.port.onmessage = (e) => {
            if (ws.readyState === WebSocket.OPEN) {
              const base64 = arrayBufferToBase64(e.data)
              ws.send(JSON.stringify({
                realtimeInput: {
                  audio: { mimeType: 'audio/pcm;rate=16000', data: base64 }
                }
              }))
            }
          }
          sourceRef.current.connect(processorRef.current)
          processorRef.current.connect(audioCtx.destination)
        }
      }

      ws.onmessage = async (event) => {
        try {
          let text = event.data
          if (event.data instanceof Blob) {
            text = await event.data.text()
          }
          const data = JSON.parse(text)
          
          if (data.serverContent?.modelTurn?.parts) {
            const parts = data.serverContent.modelTurn.parts
            for (const part of parts) {
              if (part.text) {
                addMessage('model', part.text)
              }
              if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                playAudioChunk(part.inlineData.data)
              }
            }
          }

          const inputTranscript = data.serverContent?.inputTranscription
          if (inputTranscript) {
            const transcriptText = inputTranscript.text || (inputTranscript.parts && inputTranscript.parts[0]?.text)
            if (transcriptText) addMessage('user', transcriptText)
          }

          const outputTranscript = data.serverContent?.outputTranscription
          if (outputTranscript) {
            const transcriptText = outputTranscript.text || (outputTranscript.parts && outputTranscript.parts[0]?.text)
            if (transcriptText) addMessage('model', transcriptText)
          }

        } catch (e) {
          console.error("Error parsing message:", e)
        }
      }

      ws.onerror = (e) => {
        console.error("Live API WS Error:", e)
        setError("Connection error occurred.")
      }

      ws.onclose = (event) => {
        console.log("Live API WS Closed:", event.code, event.reason)
        disconnect()
      }

    } catch (err: any) {
      console.error(err)
      setError(err.message || 'Failed to connect.')
      setIsConnecting(false)
      disconnect()
    }
  }

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.close()
      wsRef.current = null
    }
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop())
      streamRef.current = null
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(console.error)
      audioContextRef.current = null
    }
    setIsConnected(false)
    setIsConnecting(false)
  }, [])

  const sendText = (text: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        realtimeInput: {
          text: text
        }
      }))
      // Force a new message block
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text }])
    }
  }

  return {
    isConnected,
    isConnecting,
    error,
    messages,
    setMessages,
    connect,
    disconnect,
    sendText
  }
}
