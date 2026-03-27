import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { LiveSummaryResponse, SourceDomain, SpaceAggregate, TrackEventProperties } from '@/types/track'

const UI_SYNC_DELAY_MS = 300

let uiSyncTimer: ReturnType<typeof setTimeout> | null = null

interface LiveDataStore {
  globalSummary: LiveSummaryResponse | null
  setGlobalSummary: (summary: LiveSummaryResponse | null) => void
  uiGlobalSummary: LiveSummaryResponse | null

  viewportAssets: Map<string, TrackEventProperties>
  upsertViewportAssets: (events: TrackEventProperties[]) => void
  replaceDomainViewportAssets: (domain: SourceDomain, events: TrackEventProperties[]) => void
  replaceViewportAssetDomains: (domains: Partial<Record<SourceDomain, TrackEventProperties[]>>) => void
  clearViewportAssets: () => void
  uiViewportAssets: Map<string, TrackEventProperties>

  spaceAggregates: SpaceAggregate[]
  setSpaceAggregates: (aggregates: SpaceAggregate[]) => void

  selectedAssetDetail: TrackEventProperties | null
  setSelectedAssetDetail: (asset: TrackEventProperties | null) => void
  clearSelectedAssetDetail: () => void
}

function scheduleUiSync(
  set: (partial: Partial<LiveDataStore>) => void,
  get: () => LiveDataStore,
) {
  if (uiSyncTimer !== null) return
  uiSyncTimer = setTimeout(() => {
    uiSyncTimer = null
    const state = get()
    set({
      uiGlobalSummary: state.globalSummary,
      uiViewportAssets: state.viewportAssets,
    })
  }, UI_SYNC_DELAY_MS)
}

export const useLiveDataStore = create<LiveDataStore>()(
  devtools((set, get) => ({
    globalSummary: null,
    uiGlobalSummary: null,
    setGlobalSummary: (globalSummary) => {
      set({ globalSummary })
      scheduleUiSync(set, get)
    },

    viewportAssets: new Map(),
    uiViewportAssets: new Map(),
    upsertViewportAssets: (events) => {
      set((state) => {
        const next = new Map(state.viewportAssets)
        for (const event of events) {
          next.set(`${event.source_domain}:${event.track_id}`, event)
        }
        return { viewportAssets: next }
      })
      scheduleUiSync(set, get)
    },
    replaceDomainViewportAssets: (domain, events) => {
      set((state) => {
        const next = new Map(state.viewportAssets)
        for (const key of next.keys()) {
          if (key.startsWith(`${domain}:`)) {
            next.delete(key)
          }
        }
        for (const event of events) {
          next.set(`${event.source_domain}:${event.track_id}`, event)
        }
        return { viewportAssets: next }
      })
      scheduleUiSync(set, get)
    },
    replaceViewportAssetDomains: (domains) => {
      const domainEntries = Object.entries(domains).filter(([, events]) => Array.isArray(events)) as Array<[SourceDomain, TrackEventProperties[]]>
      if (domainEntries.length === 0) return

      set((state) => {
        const next = new Map(state.viewportAssets)
        const domainSet = new Set(domainEntries.map(([domain]) => domain))

        for (const key of next.keys()) {
          const separatorIndex = key.indexOf(':')
          if (separatorIndex === -1) continue
          const domain = key.slice(0, separatorIndex) as SourceDomain
          if (domainSet.has(domain)) {
            next.delete(key)
          }
        }

        for (const [, events] of domainEntries) {
          for (const event of events) {
            next.set(`${event.source_domain}:${event.track_id}`, event)
          }
        }

        return { viewportAssets: next }
      })
      scheduleUiSync(set, get)
    },
    clearViewportAssets: () => {
      set({ viewportAssets: new Map() })
      scheduleUiSync(set, get)
    },

    spaceAggregates: [],
    setSpaceAggregates: (spaceAggregates) => set({ spaceAggregates }),

    selectedAssetDetail: null,
    setSelectedAssetDetail: (selectedAssetDetail) => set({ selectedAssetDetail }),
    clearSelectedAssetDetail: () => set({ selectedAssetDetail: null }),
  }))
)
