import {
  processIncomingTrackEvents,
  type ProcessedLiveEvents,
  type TrackEventBounds,
  type TrailHeadSnapshot,
} from '@/lib/liveEventProcessing'
import type { TrackEventProperties } from '@/types/track'

type ProcessLiveEventsRequest = {
  type: 'process-live-events'
  events: TrackEventProperties[]
  viewportKeys: string[]
  viewportBounds: TrackEventBounds | null
  trailHeads: Partial<Record<string, TrailHeadSnapshot>>
}

type ProcessLiveEventsResponse = {
  type: 'processed-live-events'
  result: ProcessedLiveEvents
}

self.onmessage = (message: MessageEvent<ProcessLiveEventsRequest>) => {
  if (message.data.type !== 'process-live-events') return

  const result = processIncomingTrackEvents(
    message.data.events,
    message.data.viewportKeys,
    message.data.viewportBounds,
    message.data.trailHeads,
  )

  const response: ProcessLiveEventsResponse = {
    type: 'processed-live-events',
    result,
  }
  self.postMessage(response)
}

export {}
