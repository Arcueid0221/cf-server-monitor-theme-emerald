<script setup lang="ts">
/**
 * 点首页小地球后，地球"摊开"成铺满屏幕的平面世界地图。
 *
 * 动画：d3-geo 的投影插值——正射投影（球面）逐帧混合成 Natural Earth 投影（平面），
 * 裁剪角同时从 90° 打开到 180°（背面逐渐露出来），缩放、平移、旋转一起插值。
 * 起点和小地球完全重合（同一中心经纬度、同一屏幕位置和半径），终点是适配屏幕的平面图。
 * 退出时倒放，卷回小地球的位置后通知父组件。
 */
import type { GeoPermissibleObjects, GeoProjection } from 'd3-geo'
import type { NodeData } from '@/stores/nodes'
import type { WorldGeoJson } from '@/utils/worldGeoJson'
import { Icon } from '@iconify/vue'
import {
  geoArea,
  geoGraticule10,
  geoNaturalEarth1,
  geoNaturalEarth1Raw,
  geoOrthographicRaw,
  geoPath,
  geoProjectionMutator,
} from 'd3-geo'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppStore } from '@/stores/app'
import { getApiAssetUrl } from '@/utils/api'
import { getCountryCodeFromRegion, resolveNodeLocation } from '@/utils/geoHelper'
import { getRegionDisplayName } from '@/utils/regionHelper'
import { loadWorldGeoJson } from '@/utils/worldGeoJson'

export interface UnfoldOrigin {
  /** 小地球圆心（视口坐标，px） */
  cx: number
  cy: number
  /** 小地球在屏幕上的半径（px） */
  r: number
}

export interface UnfoldView {
  /** 小地球此刻正对屏幕的经纬度（度） */
  lon: number
  lat: number
}

const props = defineProps<{
  nodes: NodeData[]
  getOrigin: () => UnfoldOrigin
  getView: () => UnfoldView
}>()

const emit = defineEmits<{
  /** 第一帧已画好，父组件可以隐藏小地球 */
  (e: 'ready'): void
  /** 倒放结束，父组件显示小地球并卸载本组件 */
  (e: 'closed'): void
}>()

const appStore = useAppStore()

const OPEN_DURATION_MS = 900
const CLOSE_DURATION_MS = 700
const MAP_PADDING_PX = 48
const LABEL_GAP_PX = 6

const canvasRef = ref<HTMLCanvasElement>()
const labelEls = new Map<string, HTMLElement>()
const viewport = ref({ width: window.innerWidth, height: window.innerHeight })
/** opening：正在摊开；open：已摊开（显示圆点和标签）；closing：正在卷回 */
const phase = ref<'opening' | 'open' | 'closing'>('opening')
/** 0 = 球面，1 = 平面 */
const progress = ref(0)
const world = ref<WorldGeoJson | null>(null)

interface UnfoldCluster {
  key: string
  code: string
  coord: [number, number]
  title: string
  servers: Array<{ uuid: string, name: string, online: boolean }>
  online: number
}

const regionNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['zh-Hans'], { type: 'region' })
  : null

function countryName(region: string, code: string): string {
  const name = getRegionDisplayName(region)
  if (name !== region)
    return name
  return code ? (regionNames?.of(code) ?? code) : ''
}

// 和小地球同一套定位规则：nodeLocations 配了坐标按坐标，否则按国家中心
const clusters = computed<UnfoldCluster[]>(() => {
  const map = new Map<string, UnfoldCluster>()
  for (const node of props.nodes) {
    const loc = resolveNodeLocation(node, appStore.nodeLocations)
    if (!loc)
      continue
    let entry = map.get(loc.key)
    if (!entry) {
      entry = {
        key: loc.key,
        code: loc.code,
        coord: loc.coord,
        title: loc.label || countryName(node.region, loc.code),
        servers: [],
        online: 0,
      }
      map.set(loc.key, entry)
    }
    entry.servers.push({ uuid: node.uuid, name: node.name, online: node.online })
    if (node.online)
      entry.online += 1
  }
  return Array.from(map.values())
})

const totalServers = computed(() => props.nodes.length)
const onlineServers = computed(() => props.nodes.filter(node => node.online).length)

const highlightCodes = computed(() => {
  const codes = new Set<string>()
  for (const node of props.nodes) {
    const code = getCountryCodeFromRegion(node.region)
    if (code)
      codes.add(code)
  }
  return codes
})

// 平面图的中心经度：所有位置经度的圆周平均，让机器尽量都在画面中间、不被日期变更线劈开
const finalCenterLon = computed(() => {
  let x = 0
  let y = 0
  for (const cluster of clusters.value) {
    const rad = cluster.coord[1] * Math.PI / 180
    x += Math.cos(rad) * cluster.servers.length
    y += Math.sin(rad) * cluster.servers.length
  }
  if (Math.abs(x) < 1e-6 && Math.abs(y) < 1e-6)
    return 0
  return Math.atan2(y, x) * 180 / Math.PI
})

// d3 要求多边形外环顺时针；echarts 的 world.json 是逆时针，不翻转的话会把"国家以外的整个球面"填上颜色
type Ring = [number, number][]
function rewindPolygon(rings: Ring[]): Ring[] {
  const area = geoArea({ type: 'Polygon', coordinates: rings })
  return area > 2 * Math.PI ? rings.map(ring => ring.slice().reverse()) : rings
}

function rewindWorld(source: WorldGeoJson): WorldGeoJson {
  return {
    ...source,
    features: source.features.map((feature) => {
      const geometry = feature.geometry
      if (geometry.type === 'Polygon')
        return { ...feature, geometry: { ...geometry, coordinates: rewindPolygon(geometry.coordinates as Ring[]) } }
      if (geometry.type === 'MultiPolygon')
        return { ...feature, geometry: { ...geometry, coordinates: (geometry.coordinates as Ring[][]).map(rewindPolygon) } }
      return feature
    }),
  }
}

const highlightedWorld = computed<GeoPermissibleObjects | null>(() => {
  if (!world.value)
    return null
  return {
    type: 'FeatureCollection',
    features: world.value.features.filter(feature => highlightCodes.value.has(String(feature.properties?.name ?? ''))),
  } as GeoPermissibleObjects
})

const palette = computed(() => appStore.isDark
  ? {
      ocean: 'rgba(255, 255, 255, 0.025)',
      sphereStroke: 'rgba(255, 255, 255, 0.14)',
      graticule: 'rgba(255, 255, 255, 0.05)',
      land: 'rgba(255, 255, 255, 0.06)',
      landStroke: 'rgba(255, 255, 255, 0.22)',
      highlight: 'rgba(16, 185, 129, 0.24)',
      highlightStroke: 'rgba(52, 211, 153, 0.75)',
      dotOnline: 'rgba(16, 185, 129, 0.95)',
      dotOffline: 'rgba(234, 179, 8, 0.95)',
    }
  : {
      ocean: 'rgba(15, 23, 42, 0.025)',
      sphereStroke: 'rgba(15, 23, 42, 0.14)',
      graticule: 'rgba(15, 23, 42, 0.05)',
      land: 'rgba(15, 23, 42, 0.05)',
      landStroke: 'rgba(15, 23, 42, 0.22)',
      highlight: 'rgba(16, 185, 129, 0.2)',
      highlightStroke: 'rgba(5, 150, 105, 0.7)',
      dotOnline: 'rgba(5, 150, 105, 0.95)',
      dotOffline: 'rgba(202, 138, 4, 0.95)',
    })

// ===== 投影 =====

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 经度差取最短方向，避免绕远路转一圈 */
function lerpLon(a: number, b: number, t: number): number {
  let delta = ((b - a) % 360 + 540) % 360 - 180
  if (delta === -180)
    delta = 180
  return a + delta * t
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
}

// d3-geo 运行时导出的 *Raw 本身就是 (λ, φ) => [x, y]，@types/d3-geo 却把它们写成了无参工厂，这里按真实签名转一下
type RawFn = (lambda: number, phi: number) => [number, number]
const orthographicRaw = geoOrthographicRaw as unknown as RawFn
const naturalEarth1Raw = geoNaturalEarth1Raw as unknown as RawFn

const blendedRaw = geoProjectionMutator((t: number) => (lambda: number, phi: number) => {
  const a = orthographicRaw(lambda, phi)
  const b = naturalEarth1Raw(lambda, phi)
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t)]
}) as unknown as (t: number) => GeoProjection

function finalProjection(): GeoProjection {
  const { width, height } = viewport.value
  return geoNaturalEarth1()
    .rotate([-finalCenterLon.value, 0])
    .fitExtent(
      [[MAP_PADDING_PX, MAP_PADDING_PX + 24], [width - MAP_PADDING_PX, height - MAP_PADDING_PX]],
      { type: 'Sphere' },
    )
}

/** 摊开到 t（0 球面 → 1 平面）时的投影；origin / view 是动画起点（小地球） */
function projectionAt(t: number, origin: UnfoldOrigin, view: UnfoldView): GeoProjection {
  const end = finalProjection()
  const [endX, endY] = end.translate()
  const projection = blendedRaw(t)
  projection
    .scale(lerp(origin.r, end.scale(), t))
    .translate([lerp(origin.cx, endX, t), lerp(origin.cy, endY, t)])
    .rotate([-lerpLon(view.lon, finalCenterLon.value, t), -lerp(view.lat, 0, t)])
    .precision(0.4)
  // 背面随摊开逐渐露出；到终点完全不裁剪
  projection.clipAngle(t >= 0.999 ? null : 90 + 90 * t)
  return projection
}

// ===== 绘制 =====

let animationStart = 0
let animationFrame = 0
let animationOrigin: UnfoldOrigin = { cx: 0, cy: 0, r: 0 }
let animationView: UnfoldView = { lon: 0, lat: 0 }
let readyEmitted = false

function draw(t: number) {
  const canvas = canvasRef.value
  if (!canvas)
    return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const { width, height } = viewport.value
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx)
    return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const colors = palette.value
  const projection = projectionAt(t, animationOrigin, animationView)
  const path = geoPath(projection, ctx)

  ctx.beginPath()
  path({ type: 'Sphere' })
  ctx.fillStyle = colors.ocean
  ctx.fill()

  ctx.beginPath()
  path(geoGraticule10())
  ctx.strokeStyle = colors.graticule
  ctx.lineWidth = 0.6
  ctx.stroke()

  if (world.value) {
    ctx.beginPath()
    path(world.value as GeoPermissibleObjects)
    ctx.fillStyle = colors.land
    ctx.fill()
    ctx.strokeStyle = colors.landStroke
    ctx.lineWidth = 0.5
    ctx.stroke()
  }

  if (highlightedWorld.value) {
    ctx.beginPath()
    path(highlightedWorld.value)
    ctx.fillStyle = colors.highlight
    ctx.fill()
    ctx.strokeStyle = colors.highlightStroke
    ctx.lineWidth = 0.8
    ctx.stroke()
  }

  ctx.beginPath()
  path({ type: 'Sphere' })
  ctx.strokeStyle = colors.sphereStroke
  ctx.lineWidth = 1
  ctx.stroke()

  // 动画过程中圆点画在 canvas 上（跟着投影走）；摊开后换成 HTML 圆点和标签
  if (phase.value !== 'open') {
    // 带 context 的 geoPath 不返回值，判断"点有没有被裁掉"要用不带 context 的那种
    const testPath = geoPath(projection)
    for (const cluster of clusters.value) {
      const lonLat: [number, number] = [cluster.coord[1], cluster.coord[0]]
      // 被裁剪（在背面）的点不画
      if (!testPath({ type: 'Point', coordinates: lonLat }))
        continue
      const point = projection(lonLat)
      if (!point)
        continue
      ctx.beginPath()
      ctx.arc(point[0], point[1], lerp(2.5, 4, t), 0, Math.PI * 2)
      ctx.fillStyle = cluster.online > 0 ? colors.dotOnline : colors.dotOffline
      ctx.fill()
    }
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

function animate(direction: 'open' | 'close') {
  cancelAnimationFrame(animationFrame)
  const duration = prefersReducedMotion() ? 120 : (direction === 'open' ? OPEN_DURATION_MS : CLOSE_DURATION_MS)
  const from = progress.value
  const to = direction === 'open' ? 1 : 0
  animationStart = performance.now()

  const step = (now: number) => {
    const raw = Math.min((now - animationStart) / duration, 1)
    progress.value = lerp(from, to, easeInOutCubic(raw))
    draw(progress.value)
    if (!readyEmitted) {
      readyEmitted = true
      emit('ready')
    }
    if (raw < 1) {
      animationFrame = requestAnimationFrame(step)
      return
    }
    if (direction === 'open') {
      phase.value = 'open'
      draw(1)
      void nextTick(layoutLabels)
    }
    else {
      emit('closed')
    }
  }
  animationFrame = requestAnimationFrame(step)
}

// ===== 摊开后的圆点和标签 =====

interface PlacedMarker {
  key: string
  dotX: number
  dotY: number
  labelX: number
  labelY: number
  /** 标签被挪开了，需要画引线 */
  displaced: boolean
}

const markers = ref<PlacedMarker[]>([])
const labelsVisible = ref(false)

function setLabelEl(key: string, el: unknown) {
  if (el instanceof HTMLElement)
    labelEls.set(key, el)
  else
    labelEls.delete(key)
}

interface Box { x: number, y: number, w: number, h: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/**
 * 标签默认放在圆点右侧；和已放好的标签或圆点重叠时，依次尝试左侧、再上下错开，
 * 挪开的标签画一条引线指回圆点。
 */
function layoutLabels() {
  if (phase.value !== 'open')
    return
  const projection = finalProjection()
  const { width, height } = viewport.value
  const dots = clusters.value
    .map((cluster) => {
      const point = projection([cluster.coord[1], cluster.coord[0]])
      return point ? { cluster, x: point[0], y: point[1] } : null
    })
    .filter((item): item is { cluster: UnfoldCluster, x: number, y: number } => item !== null)
    // 从上往下、从左往右放，结果稳定
    .sort((a, b) => a.y - b.y || a.x - b.x)

  const placed: Box[] = dots.map(dot => ({ x: dot.x - 6, y: dot.y - 6, w: 12, h: 12 }))
  const result: PlacedMarker[] = []

  for (const dot of dots) {
    const el = labelEls.get(dot.cluster.key)
    const w = el?.offsetWidth ?? 120
    const h = el?.offsetHeight ?? 40
    const candidates: Array<{ x: number, y: number }> = []
    const right = dot.x + 12
    const left = dot.x - 12 - w
    const centerY = dot.y - h / 2
    candidates.push({ x: right, y: centerY }, { x: left, y: centerY })
    for (let i = 1; i <= 8; i += 1) {
      const dy = i * (h / 2 + LABEL_GAP_PX)
      candidates.push(
        { x: right, y: centerY - dy },
        { x: right, y: centerY + dy },
        { x: left, y: centerY - dy },
        { x: left, y: centerY + dy },
      )
    }

    let chosen = candidates[0]!
    for (const candidate of candidates) {
      const box = {
        x: Math.min(Math.max(candidate.x, 8), width - w - 8),
        y: Math.min(Math.max(candidate.y, 8), height - h - 8),
        w,
        h,
      }
      if (!placed.some(other => overlaps(box, other))) {
        chosen = box
        break
      }
    }
    const box = {
      x: Math.min(Math.max(chosen.x, 8), width - w - 8),
      y: Math.min(Math.max(chosen.y, 8), height - h - 8),
      w,
      h,
    }
    placed.push({ x: box.x - LABEL_GAP_PX / 2, y: box.y - LABEL_GAP_PX / 2, w: w + LABEL_GAP_PX, h: h + LABEL_GAP_PX })
    result.push({
      key: dot.cluster.key,
      dotX: dot.x,
      dotY: dot.y,
      labelX: box.x,
      labelY: box.y,
      displaced: Math.abs(box.y - centerY) > 1 || (box.x !== right && box.x !== left),
    })
  }

  markers.value = result
  labelsVisible.value = true
}

const markerByKey = computed(() => new Map(markers.value.map(marker => [marker.key, marker])))

/** 引线从圆点连到标签离它最近的那条竖边的中点 */
function leaderEnd(marker: PlacedMarker): { x: number, y: number } {
  const el = labelEls.get(marker.key)
  const w = el?.offsetWidth ?? 0
  const h = el?.offsetHeight ?? 0
  const x = marker.labelX + w / 2 < marker.dotX ? marker.labelX + w : marker.labelX
  return { x, y: marker.labelY + h / 2 }
}

// ===== 打开 / 关闭 =====

function close() {
  if (phase.value === 'closing')
    return
  labelsVisible.value = false
  phase.value = 'closing'
  // 小地球在背后一直在转，卷回时对准它此刻的朝向和位置
  animationOrigin = props.getOrigin()
  animationView = props.getView()
  animate('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape')
    close()
}

function onResize() {
  viewport.value = { width: window.innerWidth, height: window.innerHeight }
  if (phase.value === 'open') {
    draw(1)
    labelsVisible.value = false
    void nextTick(layoutLabels)
  }
}

let previousBodyOverflow = ''

onMounted(() => {
  previousBodyOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', onResize)

  animationOrigin = props.getOrigin()
  animationView = props.getView()
  // 国界数据和二维地图共用缓存，通常已经在本地；没加载好之前先只画球面和经纬网
  loadWorldGeoJson()
    .then((data) => {
      world.value = rewindWorld(data)
      if (phase.value === 'open')
        draw(1)
    })
    .catch(() => {})
  animate('open')
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame)
  document.body.style.overflow = previousBodyOverflow
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('resize', onResize)
})

watch(() => appStore.isDark, () => {
  if (phase.value === 'open')
    draw(1)
})

// 摊开状态下节点在线状态变化时重新排标签（数量可能变）
watch(() => clusters.value.map(c => `${c.key}:${c.servers.length}:${c.online}`).join(','), () => {
  if (phase.value !== 'open')
    return
  draw(1)
  void nextTick(layoutLabels)
})

const backdropOpacity = computed(() => Math.min(progress.value / 0.4, 1))
</script>

<template>
  <div class="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="节点世界地图">
    <div
      class="absolute inset-0 bg-background/85 backdrop-blur-md"
      :style="{ opacity: backdropOpacity }"
      @click="close"
    />
    <canvas ref="canvasRef" class="absolute inset-0 w-full h-full pointer-events-none" />

    <!-- 圆点、引线、标签：摊开后才出现 -->
    <svg
      v-if="phase === 'open'"
      class="absolute inset-0 w-full h-full pointer-events-none transition-opacity duration-300"
      :class="labelsVisible ? 'opacity-100' : 'opacity-0'"
    >
      <template v-for="marker in markers" :key="marker.key">
        <line
          v-if="marker.displaced"
          :x1="marker.dotX" :y1="marker.dotY"
          :x2="leaderEnd(marker).x" :y2="leaderEnd(marker).y"
          class="stroke-muted-foreground/50" stroke-width="1"
        />
      </template>
    </svg>

    <template v-if="phase === 'open'">
      <div
        v-for="cluster in clusters"
        :key="`dot-${cluster.key}`"
        class="unfold-dot absolute pointer-events-none"
        :class="cluster.online > 0 ? 'is-online' : 'is-offline'"
        :style="markerByKey.get(cluster.key)
          ? { transform: `translate(${markerByKey.get(cluster.key)!.dotX}px, ${markerByKey.get(cluster.key)!.dotY}px)` }
          : { opacity: 0 }"
      />
      <div
        v-for="cluster in clusters"
        :key="`label-${cluster.key}`"
        :ref="el => setLabelEl(cluster.key, el)"
        class="absolute left-0 top-0 pointer-events-none rounded-md bg-background/80 backdrop-blur px-2 py-1 text-xs shadow-sm ring-1 ring-border/60 transition-opacity duration-300"
        :class="labelsVisible && markerByKey.get(cluster.key) ? 'opacity-100' : 'opacity-0'"
        :style="markerByKey.get(cluster.key)
          ? { transform: `translate(${markerByKey.get(cluster.key)!.labelX}px, ${markerByKey.get(cluster.key)!.labelY}px)` }
          : undefined"
      >
        <div class="flex items-center gap-1 font-medium text-foreground text-nowrap">
          <img
            v-if="cluster.code"
            :src="getApiAssetUrl(`flags/${cluster.code.toLowerCase()}.svg`)" :alt="cluster.code"
            class="size-3.5"
          >
          {{ cluster.title }}
          <span class="text-muted-foreground font-normal">{{ cluster.online }}/{{ cluster.servers.length }}</span>
        </div>
        <div
          v-for="server in cluster.servers"
          :key="server.uuid"
          class="flex items-center gap-1 text-[11px] text-muted-foreground text-nowrap"
        >
          <span class="inline-block size-1.5 rounded-full" :class="server.online ? 'bg-green-600' : 'bg-yellow-600'" />
          {{ server.name }}
        </div>
      </div>
    </template>

    <div
      class="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none transition-opacity duration-300"
      :class="phase === 'open' ? 'opacity-100' : 'opacity-0'"
    >
      <div class="text-xs text-muted-foreground backdrop-blur-lg bg-background/60 rounded px-2 py-1">
        {{ clusters.length }} 个位置 ·
        <span class="text-green-600">{{ onlineServers }}</span> / {{ totalServers }} 在线
      </div>
      <button
        type="button"
        class="pointer-events-auto inline-flex items-center justify-center size-8 rounded-md backdrop-blur-lg bg-background/60 text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
        aria-label="收起地图" title="收起（Esc）"
        @click="close"
      >
        <Icon icon="tabler:x" width="16" height="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.unfold-dot {
  left: 0;
  top: 0;
  width: 0;
  height: 0;
}

.unfold-dot::before,
.unfold-dot::after {
  content: '';
  position: absolute;
  left: -4px;
  top: -4px;
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: currentColor;
}

.unfold-dot::after {
  animation: unfold-pulse 2s ease-out infinite;
}

.unfold-dot.is-online {
  color: rgb(16 185 129);
}

.unfold-dot.is-offline {
  color: rgb(234 179 8);
}

.unfold-dot::before {
  box-shadow: 0 0 10px currentColor;
}

@keyframes unfold-pulse {
  0% {
    transform: scale(1);
    opacity: 0.6;
  }
  100% {
    transform: scale(3.2);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .unfold-dot::after {
    animation: none;
  }
}
</style>
