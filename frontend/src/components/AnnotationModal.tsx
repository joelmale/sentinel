import { useState } from 'react'

interface Props {
  lon: number
  lat: number
  onClose: () => void
}

export function AnnotationModal({ lon, lat, onClose }: Props) {
  const [label, setLabel] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!label.trim()) return
    setSaving(true)
    try {
      await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lon, lat, label: label.trim(), body: body.trim(), created_by: 'analyst' }),
      })
      onClose()
    } catch {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm" style={{ zIndex: 40 }}>
      <div className="bg-slate-900 border border-slate-700/60 rounded-xl shadow-2xl p-5 w-80">
        <div className="text-sm font-bold text-teal-400 mb-3">📍 Add Annotation</div>
        <div className="text-[10px] text-slate-500 font-mono mb-3">
          {Math.abs(lat).toFixed(4)}° {lat >= 0 ? 'N' : 'S'}, {Math.abs(lon).toFixed(4)}° {lon >= 0 ? 'E' : 'W'}
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Label (required)"
            value={label}
            onChange={e => setLabel(e.target.value)}
            autoFocus
            className="bg-slate-800 border border-slate-600/60 rounded-md px-3 py-1.5 text-sm text-slate-200
                       placeholder-slate-600 focus:outline-none focus:border-teal-500/60"
          />
          <textarea
            placeholder="Notes (optional)"
            value={body}
            onChange={e => setBody(e.target.value)}
            rows={3}
            className="bg-slate-800 border border-slate-600/60 rounded-md px-3 py-1.5 text-sm text-slate-200
                       placeholder-slate-600 focus:outline-none focus:border-teal-500/60 resize-none"
          />
          <div className="flex gap-2 justify-end">
            <button type="button" onClick={onClose}
              className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={!label.trim() || saving}
              className="px-4 py-1.5 text-xs bg-teal-700 text-teal-100 rounded-lg hover:bg-teal-600
                         transition-colors disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
