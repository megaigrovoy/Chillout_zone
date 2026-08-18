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
 * Layer resolution. The aura is drawn small and scaled up, which produces the
 * blur for free — upscaling a low-resolution edge with smoothing enabled is a
 * blur, and costs a fraction of what canvas filter blur would.
 */
const LAYER_W = 240
const LAYER_H = 180

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

  const { grid, width: gw, height: gh } = sil

  // Cell size on the layer, with a slight overlap so adjacent edge cells merge
  // into a continuous band instead of a dotted line.
  const cw = (LAYER_W / gw) * 1.9
  const ch = (LAYER_H / gh) * 1.9

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
   lc.globalCompositeOperation = 'source-over'

   for (let y = 1; y < gh - 1; y++) {
    for (let x = 1; x < gw - 1; x++) {
      const i = y * gw + x
      const v = grid[i]
      if (v < 0.35) continue

      // Edge strength: how much this cell differs from its neighbours. Interior
      // cells match all four and score ~0, so only the boundary lights up.
      const d =
        Math.abs(v - grid[i - 1]) +
        Math.abs(v - grid[i + 1]) +
        Math.abs(v - grid[i - gw]) +
        Math.abs(v - grid[i + gw])
      if (d < 0.25) continue

      const a = Math.min(1, d * 0.55)
      lc.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`
      lc.fillRect((x / gw) * LAYER_W - cw / 2, (y / gh) * LAYER_H - ch / 2, cw, ch)
    }
   }
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
