/**
 * useResize — drag-to-resize hook for floating panels.
 *
 * Returns a `size` (px width), a `handleRef` to attach to the drag handle
 * element, and `isDragging` state.
 *
 * Direction semantics:
 *   'right'  — handle sits on right edge; dragging RIGHT increases width.
 *              Use for left-anchored panels (SourcePanel).
 *   'left'   — handle sits on left edge; dragging LEFT increases width.
 *              Use for right-anchored panels (AssetCard).
 *
 * Think of it like sliding a door: the direction tells us which *wall* the
 * handle is on, and sliding away from that wall makes the room bigger.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

interface UseResizeOptions {
  direction: 'right' | 'left'
  minSize?: number
  maxSize?: number
  defaultSize: number
  storageKey?: string
}

export function useResize({
  direction,
  minSize = 200,
  maxSize = 800,
  defaultSize,
  storageKey,
}: UseResizeOptions): {
  size: number
  handleRef: React.RefObject<HTMLDivElement>
  isDragging: boolean
} {
  const getInitial = (): number => {
    if (storageKey) {
      const stored = localStorage.getItem(storageKey)
      if (stored) {
        const n = parseInt(stored, 10)
        if (!isNaN(n)) return Math.max(minSize, Math.min(maxSize, n))
      }
    }
    return defaultSize
  }

  const [size, setSize] = useState<number>(getInitial)
  const [isDragging, setIsDragging] = useState(false)

  // Use a ref so onMouseDown doesn't recreate on every size change.
  const sizeRef = useRef(size)
  useEffect(() => { sizeRef.current = size }, [size])

  const handleRef = useRef<HTMLDivElement>(null)

  // Stores { startX, startSize } for the active drag gesture.
  const dragState = useRef<{ startX: number; startSize: number } | null>(null)

  const onMouseDown = useCallback((e: MouseEvent) => {
    e.preventDefault()
    dragState.current = { startX: e.clientX, startSize: sizeRef.current }
    setIsDragging(true)
    // Lock cursor + disable text selection for the whole document during drag.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  // Attach mousedown to the handle element.
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    el.addEventListener('mousedown', onMouseDown)
    return () => el.removeEventListener('mousedown', onMouseDown)
  }, [onMouseDown])

  // While dragging, track mousemove / mouseup on the document.
  useEffect(() => {
    if (!isDragging) return

    const onMouseMove = (e: MouseEvent) => {
      if (!dragState.current) return
      const dx = e.clientX - dragState.current.startX
      // 'right' handle: positive dx → wider.
      // 'left'  handle: negative dx → wider (panel is right-anchored).
      const newSize =
        direction === 'right'
          ? dragState.current.startSize + dx
          : dragState.current.startSize - dx
      const clamped = Math.max(minSize, Math.min(maxSize, newSize))
      setSize(clamped)
      if (storageKey) localStorage.setItem(storageKey, String(clamped))
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
  }, [isDragging, direction, minSize, maxSize, storageKey])

  return { size, handleRef, isDragging }
}
