import type {
  DomainScopeState,
  SourceDomain,
} from '@/types/track'

interface TrackScopeContext {
  domain: SourceDomain
  scope: DomainScopeState
  bbox?: string | null
  alertTrackIds?: string[]
  watchedSpaceTrackIds?: string[]
  selectedTrackId?: string | null
}

function appendCsv(params: URLSearchParams, key: string, values: string[]) {
  if (values.length === 0) return
  params.set(key, values.join(','))
}

export function buildTrackScopeParams(context: TrackScopeContext): URLSearchParams {
  const { domain, scope, bbox, alertTrackIds = [], watchedSpaceTrackIds = [], selectedTrackId } = context
  const params = new URLSearchParams()
  params.set('domain', domain)
  if (bbox) params.set('bbox', bbox)
  params.set('limit', String(scope.resultLimit))
  params.set('max_age_minutes', '60')
  if (scope.selectedQuickScope) params.set('quick_scope', scope.selectedQuickScope)

  switch (scope.selectedQuickScope) {
    case 'military':
      appendCsv(params, 'classifications', ['Military'])
      break
    case 'commercial_sample':
      appendCsv(params, 'classifications', ['Commercial'])
      break
    case 'recent_alerts':
      appendCsv(params, 'track_ids', alertTrackIds)
      break
    case 'government':
      appendCsv(params, 'classifications', ['Government', 'Military'])
      break
    case 'major_routes':
      appendCsv(params, 'classifications', ['Passenger', 'Cargo', 'Tanker'])
      break
    case 'watchlist':
      appendCsv(params, 'track_ids', watchedSpaceTrackIds)
      break
    case 'priority_constellations':
      appendCsv(params, 'constellations', ['Spire Global', 'GPS (USAF)', 'ISS', 'Tiangong / CSS'])
      break
    case 'by_operator':
      if (scope.customOperator.trim()) params.set('operator', scope.customOperator.trim())
      break
    case 'by_constellation':
      if (scope.customConstellation.trim()) params.set('constellations', scope.customConstellation.trim())
      break
    case 'by_function':
      if (scope.customPurpose.trim()) params.set('purpose', scope.customPurpose.trim())
      break
    case 'high_severity':
      params.set('min_severity', '70')
      break
    case 'near_selected':
      if (selectedTrackId) params.set('related_track_id', selectedTrackId)
      break
    case 'active_disruptions':
    case 'viewport':
    case 'show_all':
    default:
      break
  }

  return params
}
