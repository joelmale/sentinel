interface DragDotsProps {
  dragRef: React.Ref<HTMLDivElement>
  isDragging: boolean
}

interface PanelResizeHandlesProps {
  horizontalRef: React.RefObject<HTMLDivElement>
  verticalRef: React.RefObject<HTMLDivElement>
  cornerRef: React.RefObject<HTMLDivElement>
  horizontalEdge: 'left' | 'right'
  verticalEdge: 'top' | 'bottom'
}

export function DragDots({ dragRef, isDragging }: DragDotsProps) {
  return (
    <div
      ref={dragRef}
      title="Drag to move panel"
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '3px',
        padding: '6px 8px',
        cursor: isDragging ? 'grabbing' : 'grab',
        flexShrink: 0,
        borderRadius: 6,
        background: 'transparent',
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => {
        const handle = e.currentTarget as HTMLDivElement
        handle.style.background = 'rgba(148,163,184,0.18)'
      }}
      onMouseLeave={(e) => {
        const handle = e.currentTarget as HTMLDivElement
        handle.style.background = 'transparent'
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{ width: 4, height: 4, borderRadius: '50%', background: '#64748b' }}
        />
      ))}
    </div>
  )
}

export function PanelResizeHandles({
  horizontalRef,
  verticalRef,
  cornerRef,
  horizontalEdge,
  verticalEdge,
}: PanelResizeHandlesProps) {
  const cornerCursor = (
    (horizontalEdge === 'right' && verticalEdge === 'bottom') ||
    (horizontalEdge === 'left' && verticalEdge === 'top')
  ) ? 'nwse-resize' : 'nesw-resize'

  return (
    <>
      <div
        ref={horizontalRef}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          [horizontalEdge]: 0,
          width: 8,
          cursor: 'col-resize',
          zIndex: 30,
          background: 'transparent',
        }}
      />
      <div
        ref={verticalRef}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          [verticalEdge]: 0,
          height: 8,
          cursor: 'row-resize',
          zIndex: 30,
          background: 'transparent',
        }}
      />
      <div
        ref={cornerRef}
        style={{
          position: 'absolute',
          [horizontalEdge]: 0,
          [verticalEdge]: 0,
          width: 14,
          height: 14,
          cursor: cornerCursor,
          zIndex: 31,
          background: 'transparent',
        }}
      />
    </>
  )
}
