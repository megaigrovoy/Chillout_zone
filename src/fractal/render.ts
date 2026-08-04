import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * Branch count below which we stop drawing. Depth and branch count multiply,
 * so an unbounded recursion at depth 10 with 5 branches is ~10M segments —
 * enough to lock the tab. We cap total segments instead of trusting the params.
 */
const MAX_SEGMENTS = 24000

interface DrawContext {
  ctx: CanvasRenderingContext2D
  params: FractalParams
  budget: { remaining: number }
}

/** Draw one fractal tree rooted at (x, y) growing along `angle`. */
function branch(
  dc: DrawContext,
  x: number,
  y: number,
  angle: number,
  length: number,
  depth: number,
) {
  if (depth <= 0 || length < 1 || dc.budget.remaining <= 0) return
  dc.budget.remaining--

  const { ctx, params } = dc
  const x2 = x + Math.cos(angle) * length
  const y2 = y + Math.sin(angle) * length

  // Deeper branches fade and thin out, which reads as depth without needing
  // per-segment shading.
  const t = depth / Math.max(params.depth, 1)
  const hue = (params.hue + (1 - t) * 70) % 360
  const alpha = 0.25 + t * 0.6

  ctx.strokeStyle = `hsla(${hue}, 85%, ${55 + params.energy * 15}%, ${alpha})`
  ctx.lineWidth = Math.max(0.6, t * (1.5 + params.energy * 4))
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x2, y2)
  ctx.stroke()

  const count = Math.max(2, Math.round(params.branches))
  const nextLength = length * params.ratio
  // Distribute children symmetrically across the spread arc.
  for (let i = 0; i < count; i++) {
    const offset = count === 1 ? 0 : (i / (count - 1) - 0.5) * 2
    const childAngle = angle + offset * params.spread + params.twist
    branch(dc, x2, y2, childAngle, nextLength, depth - 1)
  }
}

/** Render one full frame: trails, fractal(s), and the hand cursors. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  params: FractalParams,
  hands: HandState[],
) {
  // Instead of clearing, we lay down a translucent black rect so previous
  // frames decay — the motion trails are most of the "chill" in the visual.
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = `rgba(6, 8, 16, ${0.18 + params.energy * 0.12})`
  ctx.fillRect(0, 0, width, height)

  // Additive blending makes overlapping branches bloom where they cross.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'

  const base = Math.min(width, height)
  const budget = { remaining: MAX_SEGMENTS }

  if (hands.length === 0) {
    // Idle attractor: a slow ambient bloom at centre so the screen is never dead.
    const dc: DrawContext = { ctx, params, budget }
    const roots = 5
    for (let i = 0; i < roots; i++) {
      const a = (i / roots) * Math.PI * 2 + params.rotation
      branch(dc, width / 2, height / 2, a, base * params.length, Math.round(params.depth))
    }
  } else {
    // One fractal per hand, rooted at the palm — the form belongs to the hand.
    for (const hand of hands) {
      const dc: DrawContext = { ctx, params, budget }
      const hx = (1 - hand.center.x) * width // mirrored to match the video
      const hy = hand.center.y * height
      const roots = Math.max(2, Math.round(params.branches))
      for (let i = 0; i < roots; i++) {
        const a = (i / roots) * Math.PI * 2 + hand.rotation
        branch(dc, hx, hy, a, base * params.length, Math.round(params.depth))
      }
    }
  }

  drawCursors(ctx, width, height, hands, params)
  ctx.globalCompositeOperation = 'source-over'
}

/** Fingertip dots + palm ring, so the player can see what the app sees. */
function drawCursors(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hands: HandState[],
  params: FractalParams,
) {
  for (const hand of hands) {
    const cx = (1 - hand.center.x) * width
    const cy = hand.center.y * height

    ctx.strokeStyle = `hsla(${params.hue}, 90%, 70%, 0.5)`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 14 + hand.openness * 26, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = `hsla(${(params.hue + 40) % 360}, 95%, 75%, 0.85)`
    for (const tip of hand.tips) {
      ctx.beginPath()
      ctx.arc((1 - tip.x) * width, tip.y * height, 3.5, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
