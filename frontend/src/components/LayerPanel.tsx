/**
 * LayerPanel — collapsible sidebar for controlling data overlays.
 *
 * Each domain gets a toggle + opacity slider.
 * Shows data freshness (last updated time) per layer.
 */

import { useMapStore } from '@/store/useMapStore'
import type { SourceDomain } from '@/types/track'

const DOMAIN_META: Record<SourceDomain, { label: string; icon: string; source: string }> = {
  Air:      { label: 'Air (ADS-B)',      icon: '✈️',  source: 'OpenSky Network' },
  Maritime: { label: 'Maritime (AIS)',   icon: '🚢',  source: 'AISHub' },
  Space:    { label: 'Satellite Passes', icon: '🛰️',  source: 'Celestrak / Space-Track' },
  GPS:      { label: 'GPS Jamming',      icon: '📡',  source: 'GPSJam.org' },
  Infra:    { label: 'Infrastructure',   icon: '🌐',  source: 'IODA / PowerOutage.us' },
}

export function LayerPanel() {
  const { layers, setLayerEnabled, setLayerOpacity, layerPanelOpen, toggleLayerPanel } =
    useMapStore()

  return (
    <div
      className={`absolute top-4 right-4 z-10 bg-slate-900 text-white rounded-lg shadow-xl
                  transition-all duration-300 ${layerPanelOpen ? 'w-72' : 'w-12'}`}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer select-none border-b border-slate-700"
        onClick={toggleLayerPanel}
      >
        {layerPanelOpen && (
          <span className="text-sm font-semibold tracking-wide text-blue-300">
            DATA LAYERS
          </span>
        )}
        <button className="text-slate-400 hover:text-white text-lg">
          {layerPanelOpen ? '◀' : '▶'}
        </button>
      </div>

      {/* Layer controls */}
      {layerPanelOpen && (
        <div className="p-3 space-y-4">
          {(Object.entries(DOMAIN_META) as [SourceDomain, (typeof DOMAIN_META)[SourceDomain]][]).map(
            ([domain, meta]) => {
              const state = layers[domain]
              return (
                <div key={domain} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 cursor-pointer text-sm">
                      <input
                        type="checkbox"
                        checked={state.enabled}
                        onChange={(e) => setLayerEnabled(domain, e.target.checked)}
                        className="accent-blue-400 w-4 h-4"
                      />
                      <span className={state.enabled ? 'text-white' : 'text-slate-500'}>
                        {meta.icon} {meta.label}
                      </span>
                    </label>
                  </div>
                  <div className="pl-6">
                    <p className="text-xs text-slate-500">{meta.source}</p>
                    {state.enabled && (
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.1}
                        value={state.opacity}
                        onChange={(e) => setLayerOpacity(domain, parseFloat(e.target.value))}
                        className="w-full mt-1 accent-blue-400"
                        title="Opacity"
                      />
                    )}
                  </div>
                </div>
              )
            }
          )}
        </div>
      )}
    </div>
  )
}
