import { GrowthSystem } from './growth'
import { fieldFromHands } from './field'
import { drawEntanglement } from './entangle'
import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * Two-layer renderer.
 *
 * `trail` is an offscreen canvas that accumulates every segment ever grown and
 * fades very slowly. That is what makes growth "infinite": the structure lives
 * as pixels, not as objects, so an hour of drawing costs no more memory than a
 * second of it. The visible canvas is composited fresh each frame from the
 * trail layer plus the live overlay (hand cursors, contact glow).
 */
export class FractalRenderer {
  private growth = new GrowthSystem()
  private trail: HTMLCanvasElement
  private trailCtx: CanvasRenderingContext2D
  private time = 0

  constructor(private width: number, private height: number) {
    this.trail = document.createElement('canvas')
    this.trail.width = Math.max(1, width)
    this.trail.height = Math.max(1, height)
    const ctx = this.trail.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for trail layer')
    this.trailCtx = ctx
    this.trailCtx.fillStyle = '#06080f'
    this.trailCtx.fillRect(0, 0, width, height)
  }

  /**
   * Resize the trail layer, preserving what is already drawn — otherwise every
   * window resize would wipe the player's accumulated form.
   */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return
    const previous = this.trail
    const next = document.createElement('canvas')
    next.width = Math.max(1, width)
    next.height = Math.max(1, height)
    const ctx = next.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#06080f'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(previous, 0, 0)

    this.trail = next
    this.trailCtx = ctx
    this.width = width
    this.height = height
  }

  /** Wipe both the drawn history and the live population. */
  reset() {
    this.growth.clear()
    this.trailCtx.globalCompositeOperation = 'source-over'
    this.trailCtx.fillStyle = '#06080f'
    this.trailCtx.fillRect(0, 0, this.width, this.height)
  }

  get tipCount() {
    return this.growth.tips.length
  }

  render(
    ctx: CanvasRenderingContext2D,
    params: FractalParams,
    hands: HandState[],
    dt: number,
  ) {
    this.time += dt
    const { width, height, trailCtx } = this

    // Fade the accumulated layer. The rate is per-second and deliberately tiny
    // so structures linger for tens of seconds; multiplying by dt keeps the
    // decay identical at any framerate.
    const decay = (0.055 + params.energy * 0.05) * dt
    trailCtx.globalCompositeOperation = 'source-over'
    trailCtx.fillStyle = `rgba(6, 8, 16, ${Math.min(decay, 0.5)})`
    trailCtx.fillRect(0, 0, width, height)

    // Growth is additive so crossing branches bloom where they overlap.
    trailCtx.globalCompositeOperation = 'lighter'

    const field = fieldFromHands(hands, width, height, this.time)

    if (hands.length === 0) this.growth.seedAmbient(width, height, params)
    else this.growth.seedFromHands(hands, width, height, params, dt)

    this.growth.step(trailCtx, field, params, dt, width, height)
    drawEntanglement(trailCtx, this.growth.tips, params.energy)

    trailCtx.globalCompositeOperation = 'source-over'

    // Composite: the accumulated world, then the live UI on top.
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this.trail, 0, 0, width, height)

    ctx.globalCompositeOperation = 'lighter'
    drawTipGlow(ctx, this.growth.tips, params)
    drawCursors(ctx, width, height, hands, params)
    ctx.globalCompositeOperation = 'source-over'
  }
}

/**
 * A soft dot at each live tip. Drawn to the visible canvas only, never to the
 * trail — the glow marks where growth *is now*, so it must not accumulate.
 */
function drawTipGlow(
  ctx: CanvasRenderingContext2D,
  tips: import('./growth').Tip[],
  params: FractalParams,
) {
  for (const tip of tips) {
    // Newly born tips flash brighter, which makes emission from the fingers
    // visible as a pulse rather than a steady stream.
    const youth = Math.max(0, 1 - tip.age * 2.2)
    ctx.fillStyle = `hsla(${tip.hue}, 95%, 80%, ${0.10 + youth * 0.45})`
    ctx.beginPath()
    ctx.arc(tip.x, tip.y, 1 + youth * 3 + params.energy * 1.2, 0, Math.PI * 2)
    ctx.fill()
  }
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
    const hue = hand.handedness === 'Left' ? 195 : 310

    ctx.strokeStyle = `hsla(${hue}, 90%, 72%, 0.35)`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 14 + hand.openness * 26, 0, Math.PI * 2)
    ctx.stroke()

    ctx.fillStyle = `hsla(${(hue + 40) % 360}, 95%, 78%, ${0.5 + params.energy * 0.3})`
    for (const tip of hand.tips) {
      ctx.beginPath()
      ctx.arc((1 - tip.x) * width, tip.y * height, 3, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
