import { create } from 'zustand'

type RequestMetric = {
  key: string
  count: number
  errors: number
  avgMs: number
  lastMs: number
  lastStatus: number
  lastBytes: number
}

type WsMetric = {
  connected: boolean
  reconnects: number
  messages: number
  events: number
  parseErrors: number
  lastMessageBytes: number
}

type MapMetric = {
  visibleAssets: number
  visibleDisruptions: number
  layerCount: number
  deckBuildMs: number
  airCount: number
  maritimeCount: number
  spacePriorityCount: number
  spaceAggregateCount: number
  spaceBackgroundCount: number
}

type ApiPerfSnapshot = {
  started_at: number
  routes: Array<{
    path: string
    count: number
    errors: number
    avg_ms: number
    max_ms: number
    last_ms: number
    last_status: number
  }>
  recent: Array<{
    path: string
    method: string
    status_code: number
    duration_ms: number
    ts: number
  }>
} | null

interface PerfStore {
  enabled: boolean
  panelOpen: boolean
  requests: Record<string, RequestMetric>
  ws: WsMetric
  map: MapMetric
  apiPerf: ApiPerfSnapshot
  setEnabled: (enabled: boolean) => void
  togglePanel: () => void
  recordRequest: (metric: { key: string; ms: number; status: number; bytes: number; ok: boolean }) => void
  recordWsOpen: () => void
  recordWsClose: () => void
  recordWsReconnect: () => void
  recordWsMessage: (bytes: number, events: number) => void
  recordWsParseError: () => void
  recordMap: (metric: Partial<MapMetric>) => void
  setApiPerf: (snapshot: ApiPerfSnapshot) => void
}

const perfEnabledByDefault = import.meta.env.DEV || import.meta.env.VITE_PERF_PANEL === 'true'

export const usePerfStore = create<PerfStore>()((set) => ({
  enabled: perfEnabledByDefault,
  panelOpen: perfEnabledByDefault,
  requests: {},
  ws: {
    connected: false,
    reconnects: 0,
    messages: 0,
    events: 0,
    parseErrors: 0,
    lastMessageBytes: 0,
  },
  map: {
    visibleAssets: 0,
    visibleDisruptions: 0,
    layerCount: 0,
    deckBuildMs: 0,
    airCount: 0,
    maritimeCount: 0,
    spacePriorityCount: 0,
    spaceAggregateCount: 0,
    spaceBackgroundCount: 0,
  },
  apiPerf: null,
  setEnabled: (enabled) => set({ enabled }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),
  recordRequest: ({ key, ms, status, bytes, ok }) =>
    set((state) => {
      const current = state.requests[key] ?? {
        key,
        count: 0,
        errors: 0,
        avgMs: 0,
        lastMs: 0,
        lastStatus: 0,
        lastBytes: 0,
      }
      const count = current.count + 1
      return {
        requests: {
          ...state.requests,
          [key]: {
            key,
            count,
            errors: current.errors + (ok ? 0 : 1),
            avgMs: ((current.avgMs * current.count) + ms) / count,
            lastMs: ms,
            lastStatus: status,
            lastBytes: bytes,
          },
        },
      }
    }),
  recordWsOpen: () => set((state) => ({ ws: { ...state.ws, connected: true } })),
  recordWsClose: () => set((state) => ({ ws: { ...state.ws, connected: false } })),
  recordWsReconnect: () => set((state) => ({ ws: { ...state.ws, reconnects: state.ws.reconnects + 1 } })),
  recordWsMessage: (bytes, events) =>
    set((state) => ({
      ws: {
        ...state.ws,
        messages: state.ws.messages + 1,
        events: state.ws.events + events,
        lastMessageBytes: bytes,
      },
    })),
  recordWsParseError: () => set((state) => ({ ws: { ...state.ws, parseErrors: state.ws.parseErrors + 1 } })),
  recordMap: (metric) => set((state) => ({ map: { ...state.map, ...metric } })),
  setApiPerf: (snapshot) => set({ apiPerf: snapshot }),
}))
