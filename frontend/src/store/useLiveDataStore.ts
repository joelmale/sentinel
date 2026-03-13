import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { LiveSummaryResponse, SourceDomain, SpaceAggregate, TrackEventProperties } from '@/types/track'

interface LiveDataStore {
  globalSummary: LiveSummaryResponse | null
  setGlobalSummary: (summary: LiveSummaryResponse | null) => void

  viewportAssets: Map<string, TrackEventProperties>
  upsertViewportAssets: (events: TrackEventProperties[]) => void
  replaceDomainViewportAssets: (domain: SourceDomain, events: TrackEventProperties[]) => void
  clearViewportAssets: () => void

  spaceAggregates: SpaceAggregate[]
  setSpaceAggregates: (aggregates: SpaceAggregate[]) => void

  selectedAssetDetail: TrackEventProperties | null
  setSelectedAssetDetail: (asset: TrackEventProperties | null) => void
  clearSelectedAssetDetail: () => void
}

export const useLiveDataStore = create<LiveDataStore>()(
  devtools((set) => ({
    globalSummary: null,
    setGlobalSummary: (globalSummary) => set({ globalSummary }),

    viewportAssets: new Map(),
    upsertViewportAssets: (events) =>
      set((state) => {
        const next = new Map(state.viewportAssets)
        for (const event of events) {
          next.set(`${event.source_domain}:${event.track_id}`, event)
        }
        return { viewportAssets: next }
      }),
    replaceDomainViewportAssets: (domain, events) =>
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
      }),
    clearViewportAssets: () => set({ viewportAssets: new Map() }),

    spaceAggregates: [],
    setSpaceAggregates: (spaceAggregates) => set({ spaceAggregates }),

    selectedAssetDetail: null,
    setSelectedAssetDetail: (selectedAssetDetail) => set({ selectedAssetDetail }),
    clearSelectedAssetDetail: () => set({ selectedAssetDetail: null }),
  }))
)
