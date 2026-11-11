import { useState, useRef, useCallback } from 'react'
import { createLiveToken } from '@/app/auth-actions'

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
  const [isMuted, setIsMuted] = useState(false)

  const isMutedRef = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<AudioWorkletNode | null>(null)
  
  // For playback scheduling
  const nextPlayTimeRef = useRef<number>(0)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])

  const setMuted = useCallback(async (muted: boolean) => {
    isMutedRef.current = muted;
    setIsMuted(muted);

    if (muted) {
      // If muting, stop the microphone tracks to turn off the recording indicator
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop())
        streamRef.current = null
      }
      if (sourceRef.current) {
        sourceRef.current.disconnect()
        sourceRef.current = null
      }
    } else {
      // If unmuting, ensure audio context is running
      if (audioContextRef.current) {
        if (audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume().catch(console.error)
        }

        // If the stream wasn't initialized or was stopped, initialize it now!
        if (!streamRef.current) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            streamRef.current = stream

            // Ensure worklet is loaded and processor is created
            if (!processorRef.current) {
              try {
                await audioContextRef.current.audioWorklet.addModule('/audio-worklet.js')
              } catch (e) {
                console.log("Audio worklet module add attempt:", e)
              }
              const processor = new AudioWorkletNode(audioContextRef.current, 'audio-recorder-worklet')
              processorRef.current = processor
            }

            const source = audioContextRef.current.createMediaStreamSource(stream)
            sourceRef.current = source

            // Hook up processor port to current websocket
            processorRef.current.port.onmessage = (e) => {
              if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && !isMutedRef.current) {
                const base64 = arrayBufferToBase64(e.data)
                wsRef.current.send(JSON.stringify({
                  realtimeInput: {
                    audio: { mimeType: 'audio/pcm;rate=16000', data: base64 }
                  }
                }))
              }
            }

            source.connect(processorRef.current)
            processorRef.current.connect(audioContextRef.current.destination)
          } catch (err) {
            console.error("Failed to re-initialize microphone stream on unmute:", err)
            setError("Failed to access microphone.")
            // Revert state to muted
            isMutedRef.current = true;
            setIsMuted(true);
          }
        } else {
          // If stream exists, make sure tracks are enabled
          streamRef.current.getAudioTracks().forEach(t => {
            t.enabled = true
          })
        }
      }
    }
  }, [])

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
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume().catch(console.error)
    }
    const float32 = base64ToFloat32Array(base64)
    const buffer = audioContextRef.current.createBuffer(1, float32.length, 24000)
    buffer.getChannelData(0).set(float32)

    const source = audioContextRef.current.createBufferSource()
    source.buffer = buffer
    source.connect(audioContextRef.current.destination)

    const currentTime = audioContextRef.current.currentTime
    const playTime = Math.max(currentTime, nextPlayTimeRef.current)
    
    // Register active source and clean up when it ends
    activeSourcesRef.current.push(source)
    source.onended = () => {
      activeSourcesRef.current = activeSourcesRef.current.filter(s => s !== source)
    }

    source.start(playTime)
    nextPlayTimeRef.current = playTime + buffer.duration
  }

  const stopAllAudio = useCallback(() => {
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop()
      } catch (e) {
        // Node was already stopped or not started yet
      }
    })
    activeSourcesRef.current = []
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime
    }
  }, [])

  const connect = (audioEnabled: boolean = true): Promise<void> => {
    return new Promise(async (resolve, reject) => {
      setIsConnecting(true)
      setError(null)
      
      // Initialize correct initial muted state based on audioEnabled
      isMutedRef.current = !audioEnabled
      setIsMuted(!audioEnabled)
      
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
        // Single-use token: mint a fresh one for every connection attempt
        const { token } = await createLiveToken()

        const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=${encodeURIComponent(token)}`
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
                responseModalities: ["AUDIO"]
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
              if (ws.readyState === WebSocket.OPEN && !isMutedRef.current) {
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
          resolve()
        }

        ws.onmessage = async (event) => {
          // a connection that was closed (for example because the session changed) adds nothing to the conversation
          if (wsRef.current !== ws) return
          try {
            let text = event.data
            if (event.data instanceof Blob) {
              text = await event.data.text()
            }
            const data = JSON.parse(text)
            
            if (data.serverContent?.interrupted) {
              console.log("User interrupted, stopping playback.")
              stopAllAudio()
            }
            
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
          reject(new Error("WebSocket error"))
        }

        ws.onclose = (event) => {
          console.log("Live API WS Closed:", event.code, event.reason)
          // the close event of an old connection must not tear down a newer one
          if (wsRef.current && wsRef.current !== ws) return
          disconnect()
        }

      } catch (err: any) {
        console.error(err)
        setError(err.message || 'Failed to connect.')
        setIsConnecting(false)
        disconnect()
        reject(err)
      }
    })
  }

  const disconnect = useCallback(() => {
    stopAllAudio()
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
  }, [stopAllAudio])

  const sendText = (text: string) => {
    stopAllAudio()
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: true
        }
      }))
      // Force a new message block
      setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', text }])
    }
  }

  // Sends hidden context to the model: not shown in the chat panel, not saved in the chat log.
  // Only interrupts the tutor's audio when asked to.
  // respond (default true): the model starts answering right away. With respond:false the turn is only appended
  // to the conversation (turnComplete:false) and the model waits for the next message, e.g. the student's typed one.
  const sendContext = (text: string, opts?: { interrupt?: boolean; respond?: boolean }) => {
    if (opts?.interrupt) stopAllAudio()
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        clientContent: {
          turns: [{ role: 'user', parts: [{ text }] }],
          turnComplete: opts?.respond !== false
        }
      }))
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
    sendText,
    sendContext,
    isMuted,
    setMuted
  }
}
