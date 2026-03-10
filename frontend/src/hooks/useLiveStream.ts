/**
 * useLiveStream — WebSocket hook for real-time track events.
 *
 * Manages the connection lifecycle, auto-reconnect, and routes
 * incoming messages to a caller-provided handler.
 *
 * Auto-reconnect uses exponential backoff capped at 30s —
 * same pattern as the Python collectors, but on the client side.
 */

import { useEffect, useRef, useCallback } from 'react'
import type { WsMessage } from '@/types/track'

interface UseLiveStreamOptions {
  url?: string
  onMessage: (msg: WsMessage) => void
  enabled?: boolean
}

const WS_URL = import.meta.env.VITE_WS_URL ?? '/ws/live'
const MAX_BACKOFF_MS = 30_000

export function useLiveStream({
  url = WS_URL,
  onMessage,
  enabled = true,
}: UseLiveStreamOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attemptRef = useRef(0)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage  // always call the latest callback

  const connect = useCallback(() => {
    if (!enabled) return

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[SENTINEL] WS connected')
      attemptRef.current = 0
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as WsMessage
        onMessageRef.current(msg)
      } catch {
        console.warn('[SENTINEL] Unparseable WS message', event.data)
      }
    }

    ws.onerror = (err) => {
      console.error('[SENTINEL] WS error', err)
    }

    ws.onclose = () => {
      if (!enabled) return
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attemptRef.current)
      attemptRef.current++
      console.log(`[SENTINEL] WS closed. Reconnecting in ${backoff}ms`)
      reconnectTimeoutRef.current = setTimeout(connect, backoff)
    }
  }, [url, enabled])

  useEffect(() => {
    connect()
    return () => {
      enabled && wsRef.current?.close()
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
    }
  }, [connect, enabled])

  return {
    close: () => wsRef.current?.close(),
    readyState: wsRef.current?.readyState ?? WebSocket.CLOSED,
  }
}
