import fs from 'node:fs'
import path from 'node:path'

const jsPath = path.resolve('node_modules/maplibre-gl/dist/maplibre-gl.js')
const mapPath = path.resolve('node_modules/maplibre-gl/dist/maplibre-gl.js.map')
const marker = '\n//# sourceMappingURL=maplibre-gl.js.map'

try {
  if (fs.existsSync(jsPath)) {
    const source = fs.readFileSync(jsPath, 'utf8')
    if (source.includes(marker)) {
      fs.writeFileSync(jsPath, source.replace(marker, ''), 'utf8')
      console.log('patched maplibre-gl sourcemap reference')
    }
  }

  if (fs.existsSync(mapPath)) {
    try {
      JSON.parse(fs.readFileSync(mapPath, 'utf8'))
    } catch {
      fs.renameSync(mapPath, `${mapPath}.broken`)
      console.log('renamed broken maplibre-gl sourcemap')
    }
  }
} catch (error) {
  console.warn('maplibre-gl sourcemap patch skipped:', error instanceof Error ? error.message : error)
}
