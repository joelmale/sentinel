import { usePerfStore } from '@/store/usePerfStore'

export async function trackedFetchJson<T>(key: string, input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const started = performance.now()
  const response = await fetch(input, init)
  const text = await response.text()
  const durationMs = performance.now() - started
  usePerfStore.getState().recordRequest({
    key,
    ms: durationMs,
    status: response.status,
    bytes: text.length,
    ok: response.ok,
  })
  if (!response.ok) {
    throw new Error(`${key} failed: ${response.status}`)
  }
  return JSON.parse(text) as T
}
