import { useMapStore } from '@/store/useMapStore'
import { useShallow } from 'zustand/react/shallow'

export function AlertNotification() {
  const { pendingAlerts, dismissAlert, selectAsset } = useMapStore(useShallow((state) => ({
    pendingAlerts: state.pendingAlerts,
    dismissAlert: state.dismissAlert,
    selectAsset: state.selectAsset,
  })))
  if (pendingAlerts.length === 0) return null
  return (
    <div className="absolute bottom-24 right-2 flex flex-col gap-2" style={{ zIndex: 25 }}>
      {pendingAlerts.slice(-5).map(alert => (
        <div key={alert.alertId}
          className="flex items-center gap-3 px-3 py-2 rounded-lg bg-red-900/90 border border-red-500/60
                     backdrop-blur-md shadow-xl text-xs text-red-200">
          <span className="text-base">🚨</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate">Alert: {alert.domain}</div>
            <div className="text-red-400 font-mono truncate">{alert.trackId}</div>
          </div>
          <button onClick={() => { selectAsset(alert.trackId, alert.domain); dismissAlert(alert.alertId) }}
            className="text-red-300 hover:text-white text-xs px-1 flex-shrink-0">View</button>
          <button onClick={() => dismissAlert(alert.alertId)}
            className="text-red-500 hover:text-red-300 flex-shrink-0">✕</button>
        </div>
      ))}
    </div>
  )
}
