import { useEffect, useRef, useState, useCallback } from 'react'
import { WSMessage } from '../types'
import { wsUrl } from '../config'

type Status = 'connecting' | 'connected' | 'disconnected' | 'error'

const MAX_HISTORY = 200

export function useWebSocket() {
  const [status, setStatus] = useState<Status>('disconnected')
  const [messages, setMessages] = useState<WSMessage[]>([])
  const wsRef = useRef<WebSocket | null>(null)
  const retryDelay = useRef(1000)
  const mountedRef = useRef(true)

  const connect = useCallback(() => {
    if (!mountedRef.current) return
    setStatus('connecting')

    const ws = new WebSocket(wsUrl('/ws'))
    wsRef.current = ws

    ws.onopen = () => {
      if (!mountedRef.current) return
      setStatus('connected')
      retryDelay.current = 1000
    }

    ws.onmessage = (event) => {
      if (!mountedRef.current) return
      try {
        const msg: WSMessage = JSON.parse(event.data)
        setMessages(prev => {
          const updated = [...prev, msg]
          return updated.length > MAX_HISTORY ? updated.slice(-MAX_HISTORY) : updated
        })
      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      if (!mountedRef.current) return
      setStatus('disconnected')
      // Exponential backoff reconnect, max 30s
      const delay = Math.min(retryDelay.current, 30_000)
      retryDelay.current = delay * 2
      setTimeout(connect, delay)
    }

    ws.onerror = () => {
      setStatus('error')
      ws.close()
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    connect()
    return () => {
      mountedRef.current = false
      wsRef.current?.close()
    }
  }, [connect])

  const latestSnapshot = messages.filter(m => m.type === 'snapshot').at(-1) ?? null
  const latestMessage = messages.at(-1) ?? null

  return { status, messages, latestSnapshot, latestMessage }
}
