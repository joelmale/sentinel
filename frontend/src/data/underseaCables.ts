/**
 * Undersea cable context overlays.
 *
 * Source: TeleGeography's public submarine cable map repository.
 * Important caveat from their README: routes are approximate/stylized and are
 * not intended to represent exact surveyed seabed paths.
 *
 * The repo keeps the original source snapshots plus lighter runtime versions:
 *   - /data/undersea-cables.geojson                      source snapshot
 *   - /data/undersea-cables.runtime.geojson              rounded/pruned runtime asset
 *   - /data/undersea-cable-landing-points.geojson        source snapshot
 *   - /data/undersea-cable-landing-points.runtime.geojson rounded/pruned runtime asset
 */

export const UNDERSEA_CABLES_GEOJSON_URL = '/data/undersea-cables.runtime.geojson'
export const UNDERSEA_CABLE_LANDING_POINTS_GEOJSON_URL = '/data/undersea-cable-landing-points.runtime.geojson'
