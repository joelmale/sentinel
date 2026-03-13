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
import { usePerfStore } from '@/store/usePerfStore'
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
  const openedRef = useRef(false)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage  // always call the latest callback

  // In React StrictMode, effects run twice (mount → cleanup → mount).
  // Without this flag, the cleanup close triggers onclose → schedules a
  // reconnect → logs a spurious error before the real connection succeeds.
  // Setting destroyedRef=true tells onclose "this teardown was intentional,
  // don't retry" — same pattern as AbortController for fetch.
  const destroyedRef = useRef(false)

  const connect = useCallback(() => {
    if (!enabled) return

    const ws = new WebSocket(url)
    wsRef.current = ws
    openedRef.current = false

    ws.onopen = () => {
      if (destroyedRef.current || !enabled) {
        ws.close(1000, 'disposed before open')
        return
      }
      console.log('[SENTINEL] WS connected')
      usePerfStore.getState().recordWsOpen()
      openedRef.current = true
      attemptRef.current = 0
    }

    ws.onmessage = (event) => {
      let msg: WsMessage
      try {
        msg = JSON.parse(event.data) as WsMessage
      } catch (error) {
        usePerfStore.getState().recordWsParseError()
        console.warn(
          '[SENTINEL] WS JSON parse failed',
          error,
          typeof event.data === 'string' ? event.data.slice(0, 1000) : event.data,
        )
        return
      }

      usePerfStore.getState().recordWsMessage(
        typeof event.data === 'string' ? event.data.length : 0,
        msg.type === 'track_events' ? msg.events.length : 0,
      )

      try {
        onMessageRef.current(msg)
      } catch (error) {
        console.error('[SENTINEL] WS handler failed', error, {
          type: msg.type,
          count: msg.type === 'track_events' ? msg.events.length : undefined,
        })
      }
    }

    ws.onerror = () => {
      // onerror always fires before onclose — suppress the redundant log
      // when the socket was closed intentionally by cleanup.
      if (!destroyedRef.current && (openedRef.current || ws.readyState === WebSocket.OPEN)) {
        console.warn('[SENTINEL] WS connection error')
      }
    }

    ws.onclose = (event) => {
      // Intentional teardown (StrictMode cleanup or component unmount) — don't retry.
      if (destroyedRef.current || !enabled) return

       // Dev-mode mount/cleanup churn can dispose a socket before it finishes
       // opening. Treat that as a no-op rather than a connection failure.
      if (!openedRef.current && (event.code === 1000 || ws.readyState === WebSocket.CLOSED)) {
        return
      }

      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attemptRef.current)
      attemptRef.current++
      usePerfStore.getState().recordWsClose()
      usePerfStore.getState().recordWsReconnect()
      console.log(`[SENTINEL] WS closed. Reconnecting in ${backoff}ms`)
      reconnectTimeoutRef.current = setTimeout(connect, backoff)
    }
  }, [url, enabled])

  useEffect(() => {
    destroyedRef.current = false
    connect()
    return () => {
      destroyedRef.current = true
      const ws = wsRef.current
      if (ws) {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.onopen = () => ws.close(1000, 'disposed during connect')
          ws.onmessage = null
          ws.onerror = null
          ws.onclose = null
        } else if (ws.readyState === WebSocket.OPEN) {
          usePerfStore.getState().recordWsClose()
          ws.close(1000, 'component cleanup')
        }
      }
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current)
    }
  }, [connect, enabled])

  return {
    close: () => wsRef.current?.close(),
    readyState: wsRef.current?.readyState ?? WebSocket.CLOSED,
  }
}
