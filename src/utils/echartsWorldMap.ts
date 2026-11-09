import { registerMap } from 'echarts/core'
import { loadWorldGeoJson } from '@/utils/worldGeoJson'

const WORLD_MAP_NAME = 'cf-server-monitor-world'

let worldMapPromise: Promise<string> | null = null
let worldMapRegistered = false

export async function ensureWorldMapRegistered(): Promise<string> {
  if (worldMapRegistered)
    return WORLD_MAP_NAME

  if (!worldMapPromise) {
    worldMapPromise = loadWorldGeoJson()
      .then((worldGeoJson) => {
        registerMap(WORLD_MAP_NAME, worldGeoJson as unknown as Parameters<typeof registerMap>[1])
        worldMapRegistered = true
        return WORLD_MAP_NAME
      })
      .catch((error) => {
        worldMapPromise = null
        throw error
      })
  }

  return worldMapPromise
}
