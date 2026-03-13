/**
 * useResizePanel — 2-D drag-to-resize hook for floating panels.
 *
 * Manages width and height simultaneously, exposing three handle refs:
 *   rightHandleRef   — right edge,  cursor: col-resize  → width only
 *   bottomHandleRef  — bottom edge, cursor: row-resize  → height only
 *   cornerHandleRef  — bottom-right corner, cursor: se-resize → both
 *
 * Think of it like the resize grip on a desktop window: the right edge
 * stretches horizontally, the bottom edge stretches vertically, and the
 * corner grip is the diagonal combination of both.
 *
 * Width and height are persisted together in a single localStorage entry
 * so the panel remembers its last shape across page reloads.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseResizePanelOptions {
  defaultWidth: number
  defaultHeight: number
  minWidth?: number
  maxWidth?: number
  minHeight?: number
  maxHeight?: number
  horizontalAnchor?: 'left' | 'right'
  verticalAnchor?: 'top' | 'bottom'
  storageKey?: string
}

interface PanelSize {
  width: number
  height: number
}

export function useResizePanel({
  defaultWidth,
  defaultHeight,
  minWidth = 200,
  maxWidth = 800,
  minHeight = 200,
  maxHeight = 1200,
  horizontalAnchor = 'left',
  verticalAnchor = 'top',
  storageKey,
}: UseResizePanelOptions): {
  width: number
  height: number
  rightHandleRef: React.RefObject<HTMLDivElement>
  bottomHandleRef: React.RefObject<HTMLDivElement>
  cornerHandleRef: React.RefObject<HTMLDivElement>
  isDragging: boolean
} {
  const getInitial = (): PanelSize => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        try {
          const parsed = JSON.parse(stored) as Partial<PanelSize>
          return {
            width:  Math.max(minWidth,  Math.min(maxWidth,  parsed.width  ?? defaultWidth)),
            height: Math.max(minHeight, Math.min(maxHeight, parsed.height ?? defaultHeight)),
          }
        } catch { /* ignore malformed */ }
      }
    }
    return { width: defaultWidth, height: defaultHeight }
  }

  const initial = getInitial()
  const [width,  setWidth]  = useState(initial.width)
  const [height, setHeight] = useState(initial.height)
  const [isDragging, setIsDragging] = useState(false)

  // Refs so event handlers always read the latest values without recreating.
  const widthRef  = useRef(width)
  const heightRef = useRef(height)
  useEffect(() => { widthRef.current  = width  }, [width])
  useEffect(() => { heightRef.current = height }, [height])

  const persist = useCallback((w: number, h: number) => {
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify({ width: w, height: h }))
  }, [storageKey])

  const rightHandleRef  = useRef<HTMLDivElement>(null)
  const bottomHandleRef = useRef<HTMLDivElement>(null)
  const cornerHandleRef = useRef<HTMLDivElement>(null)

  // ── Right edge — width only ───────────────────────────────────────
  useEffect(() => {
    const el = rightHandleRef.current
    if (!el) return

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = widthRef.current
      setIsDragging(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        const nextW = horizontalAnchor === 'left' ? startW + dx : startW - dx
        const newW = Math.max(minWidth, Math.min(maxWidth, nextW))
        setWidth(newW)
        persist(newW, heightRef.current)
      }
      const onUp = () => {
        setIsDragging(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [horizontalAnchor, minWidth, maxWidth, persist])

  // ── Bottom edge — height only ─────────────────────────────────────
  useEffect(() => {
    const el = bottomHandleRef.current
    if (!el) return

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      const startY = e.clientY
      const startH = heightRef.current
      setIsDragging(true)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const dy = ev.clientY - startY
        const nextH = verticalAnchor === 'top' ? startH + dy : startH - dy
        const newH = Math.max(minHeight, Math.min(maxHeight, nextH))
        setHeight(newH)
        persist(widthRef.current, newH)
      }
      const onUp = () => {
        setIsDragging(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [verticalAnchor, minHeight, maxHeight, persist])

  // ── Bottom-right corner — width + height simultaneously ───────────
  useEffect(() => {
    const el = cornerHandleRef.current
    if (!el) return

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startY = e.clientY
      const startW = widthRef.current
      const startH = heightRef.current
      setIsDragging(true)
      document.body.style.cursor = 'se-resize'
      document.body.style.userSelect = 'none'

      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        const nextW = horizontalAnchor === 'left' ? startW + dx : startW - dx
        const nextH = verticalAnchor === 'top' ? startH + dy : startH - dy
        const newW = Math.max(minWidth, Math.min(maxWidth, nextW))
        const newH = Math.max(minHeight, Math.min(maxHeight, nextH))
        setWidth(newW)
        setHeight(newH)
        persist(newW, newH)
      }
      const onUp = () => {
        setIsDragging(false)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    }

    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [horizontalAnchor, verticalAnchor, minWidth, maxWidth, minHeight, maxHeight, persist])

  return { width, height, rightHandleRef, bottomHandleRef, cornerHandleRef, isDragging }
}
