/**
 * useDrag — panel drag-to-move hook.
 *
 * Attaches mousedown to the element pointed at by `dragHandleRef`.
 * Returns an `offset` (dx, dy in pixels) that is applied as a CSS
 * `transform: translate(x, y)` on the panel — so the panel stays at
 * its default fixed position until the user drags it.
 *
 * Using transform instead of changing left/top:
 *   • Simpler: no need to compute initial screen coordinates
 *   • GPU-composited — no layout reflow while dragging
 *   • Default panel position is preserved in CSS; offset is additive
 *
 * The offset persists in localStorage so panels remember where the
 * user left them across page refreshes.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseDragOptions {
  storageKey?: string
}

interface DragOffset {
  x: number
  y: number
}

export function useDrag({ storageKey }: UseDragOptions = {}): {
  offset: DragOffset
  dragHandleRef: React.RefObject<HTMLDivElement | null>
  isDragging: boolean
} {
  const getInitial = (): DragOffset => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        try {
          return JSON.parse(stored) as DragOffset
        } catch {
          // ignore malformed storage
        }
      }
    }
    return { x: 0, y: 0 }
  }

  const [offset, setOffset] = useState<DragOffset>(getInitial)
  const [isDragging, setIsDragging] = useState(false)

  const dragHandleRef = useRef<HTMLDivElement>(null)

  // Keep a ref so onMouseDown captures current offset without recreating
  const offsetRef = useRef(offset)
  useEffect(() => { offsetRef.current = offset }, [offset])

  // Active drag state: anchor point + offset at drag start
  const dragState = useRef<{
    startX: number
    startY: number
    ox: number
    oy: number
  } | null>(null)

  const onMouseDown = useCallback((e: MouseEvent) => {
    // Ignore right-click
    if (e.button !== 0) return
    e.preventDefault()
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      ox: offsetRef.current.x,
      oy: offsetRef.current.y,
    }
    setIsDragging(true)
    document.body.style.cursor = 'grabbing'
    document.body.style.userSelect = 'none'
  }, [])

  // Attach mousedown to the handle element
  useEffect(() => {
    const el = dragHandleRef.current
    if (!el) return
    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [onMouseDown])

  // Track mouse movement globally while dragging
  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return
      const next: DragOffset = {
        x: dragState.current.ox + e.clientX - dragState.current.startX,
        y: dragState.current.oy + e.clientY - dragState.current.startY,
      }
      setOffset(next)
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next))
    }

    const onMouseUp = () => {
      dragState.current = null
      setIsDragging(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [isDragging, storageKey])

  return { offset, dragHandleRef, isDragging }
}
