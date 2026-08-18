import type { Silhouette } from '../tracking/useSegmentation'

/**
 * Glowing outline around the player.
 *
 * Only the *edge* is drawn, not the filled body: a filled silhouette would
 * occlude the flame behind it and read as a cut-out, while an outline reads as
 * an aura and lets the fractal show through.
 *
 * The edge is found by comparing each cell against its neighbours in the
 * occupancy grid — a cell that is inside while a neighbour is outside sits on
 * the boundary. That is far cheaper than extracting contours as polygons and
 * is all a soft glow needs.
 */

/** Offscreen layer the aura is composed on, so it can be blurred cheaply. */
let layer: HTMLCanvasElement | null = null
let layerCtx: CanvasRenderingContext2D | null = null

/**
 * The layer is rebuilt only when the silhouette actually changes.
 *
 * Segmentation runs at 15Hz while rendering runs at 60, so redrawing the ~290
 * edge cells every frame would repeat identical work three times out of four.
 * The composite still happens every frame, so the colour drift stays smooth.
 */
let layerStamp = -1
let layerHue = -1

/**
 * Layer resolution.
 *
 * Raised well above the trace grid (160x120): the first version drew the edge
 * as one fillRect per grid cell at roughly grid resolution, so every cell
 * became a hard-edged block ~12px across once stretched to the screen, and
 * upscaling could not hide squares that large. Drawing into a bigger layer
 * with soft brushes gives the outline room to be smooth before it is scaled.
 */
const LAYER_W = 480
const LAYER_H = 360

/**
 * Reusable radial-gradient brush.
 *
 * A soft brush has no edges by construction, which is the actual fix for the
 * blockiness — a rectangle stays a rectangle no matter how much it is blurred
 * afterwards. The gradient is built once into its own tile and stamped, since
 * creating a gradient per cell would be far slower.
 */
const BRUSH_SIZE = 64
let brush: HTMLCanvasElement | null = null

function ensureBrush(): HTMLCanvasElement | null {
  if (brush) return brush
  const c = document.createElement('canvas')
  c.width = BRUSH_SIZE
  c.height = BRUSH_SIZE
  const bctx = c.getContext('2d')
  if (!bctx) return null
  const r = BRUSH_SIZE / 2
  const grad = bctx.createRadialGradient(r, r, 0, r, r, r)
  // A soft falloff rather than a linear one: linear leaves a visible disc
  // boundary where the alpha hits zero.
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.55)')
  grad.addColorStop(0.7, 'rgba(255,255,255,0.14)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  bctx.fillStyle = grad
  bctx.fillRect(0, 0, BRUSH_SIZE, BRUSH_SIZE)
  brush = c
  return brush
}

function ensureLayer(): CanvasRenderingContext2D | null {
  if (layerCtx) return layerCtx
  const c = document.createElement('canvas')
  c.width = LAYER_W
  c.height = LAYER_H
  const ctx = c.getContext('2d')
  if (!ctx) return null
  layer = c
  layerCtx = ctx
  return ctx
}

/**
 * Bilinear sample of the occupancy grid at fractional coordinates.
 *
 * Nearest-neighbour here would defeat the finer stepping entirely: the outline
 * would still snap to whole cells and keep its staircase.
 */
function sample(grid: Float32Array, gw: number, gh: number, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(gw - 1, Math.floor(x)))
  const y0 = Math.max(0, Math.min(gh - 1, Math.floor(y)))
  const x1 = Math.min(gw - 1, x0 + 1)
  const y1 = Math.min(gh - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0

  const a = grid[y0 * gw + x0]
  const b = grid[y0 * gw + x1]
  const c = grid[y1 * gw + x0]
  const d = grid[y1 * gw + x1]

  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy
}

export function drawAura(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  sil: Silhouette,
  palette: Float32Array,
  time: number,
  energy: number,
) {
  if (!sil.ready) return
  const lc = ensureLayer()
  if (!lc || !layer) return

  const br = ensureBrush()
  if (!br) return

  const { grid, width: gw, height: gh } = sil

  // Brush footprint on the layer. Generous overlap so adjacent stamps fuse
  // into one continuous band rather than reading as a row of dots.
  const cw = (LAYER_W / gw) * 5.0
  const ch = (LAYER_H / gh) * 5.0

  // Colour drifts along the palette over time, matching the skeleton and
  // trails so the whole overlay family shimmers together.
  const phase = time * 0.07
  const ci = Math.max(0, Math.min(255, Math.round(((phase % 1) + 1) % 1 * 255))) * 3
  const r = Math.min(255, palette[ci] * 1.7 + 30) | 0
  const g = Math.min(255, palette[ci + 1] * 1.7 + 30) | 0
  const b = Math.min(255, palette[ci + 2] * 1.7 + 40) | 0

  // Rebuild the layer only when the silhouette or its colour has moved on.
  const hueBucket = Math.round(phase * 60)
  const needsRebuild = sil.stamp !== layerStamp || hueBucket !== layerHue
  if (needsRebuild) {
   layerStamp = sil.stamp
   layerHue = hueBucket
   lc.clearRect(0, 0, LAYER_W, LAYER_H)
   // Stamps accumulate additively so overlapping brushes build a bright,
   // continuous ridge instead of each one flatly overwriting the last.
   lc.globalCompositeOperation = 'lighter'

   // Walk a finer virtual grid than the occupancy data and sample it
   // bilinearly. Stepping cell-by-cell made the outline follow the grid's
   // staircase; sub-cell steps let it land between cells and read as a curve.
   const STEP = 0.5
   for (let y = 1; y < gh - 1; y += STEP) {
    for (let x = 1; x < gw - 1; x += STEP) {
      const v = sample(grid, gw, gh, x, y)
      if (v < 0.35) continue

      // Edge strength from the local gradient: interior points match their
      // surroundings and score ~0, so only the boundary lights up.
      const dx = sample(grid, gw, gh, x + 1, y) - sample(grid, gw, gh, x - 1, y)
      const dy = sample(grid, gw, gh, x, y + 1) - sample(grid, gw, gh, x, y - 1)
      const d = Math.abs(dx) + Math.abs(dy)
      if (d < 0.25) continue

      // Weight by edge strength so the band fades where the boundary is soft,
      // and scale down for the denser sampling to keep total brightness even.
      const a = Math.min(1, d * 0.55) * STEP * STEP * 1.6
      lc.globalAlpha = a
      lc.drawImage(
        br,
        (x / gw) * LAYER_W - cw / 2,
        (y / gh) * LAYER_H - ch / 2,
        cw,
        ch,
      )
    }
   }

   // Tint the accumulated white glow in one pass. Colouring per stamp would
   // mean a fillStyle change per cell for no visual difference.
   lc.globalAlpha = 1
   lc.globalCompositeOperation = 'source-in'
   lc.fillStyle = `rgb(${r}, ${g}, ${b})`
   lc.fillRect(0, 0, LAYER_W, LAYER_H)
   lc.globalCompositeOperation = 'source-over'
  }

  // Composite additively and mirrored, matching the video the player sees.
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  ctx.imageSmoothingEnabled = true
  ctx.translate(width, 0)
  ctx.scale(-1, 1)

  // Two passes at different scales: a wide soft halo and a tighter brighter
  // core, which together read as a glow rather than a flat band.
  // Energy is applied here rather than baked into the layer, so a cached layer
  // still brightens instantly with a gesture.
  ctx.globalAlpha = (0.5 + energy * 0.3) * (0.5 + energy * 0.5)
  ctx.drawImage(layer, -width * 0.03, -height * 0.03, width * 1.06, height * 1.06)
  ctx.globalAlpha = 0.75 * (0.5 + energy * 0.5)
  ctx.drawImage(layer, 0, 0, width, height)

  ctx.restore()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
}
