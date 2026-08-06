import { Bloom } from './bloom'
import type { IfsSpec } from './ifs'
import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * Two-layer renderer.
 *
 * `trail` is an offscreen canvas that accumulates every band ever drawn and
 * fades very slowly. That is what makes growth "infinite": the pattern lives
 * as pixels, not as objects, so an hour of drawing costs no more memory than a
 * second of it.
 *
 * The figures themselves are deterministic IFS blooms (see `bloom.ts`), each
 * emitted from a palm. Randomness lives only in the *choice of spec* per
 * emission, never inside a figure, so every bloom is exactly self-similar
 * while successive blooms still differ from each other.
 */

/** Ceiling on live blooms; older ones are retired as new ones arrive. */
const MAX_BLOOMS = 14

/** Ceiling on arms across all blooms — the real cost driver. */
const MAX_ARMS = 2600

export class FractalRenderer {
  private trail: HTMLCanvasElement
  private trailCtx: CanvasRenderingContext2D
  private blooms: Bloom[] = []
  private cooldown = 0
  private time = 0

  constructor(private width: number, private height: number) {
    this.trail = document.createElement('canvas')
    this.trail.width = Math.max(1, width)
    this.trail.height = Math.max(1, height)
    const ctx = this.trail.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for trail layer')
    this.trailCtx = ctx
    this.trailCtx.fillStyle = '#040c1e'
    this.trailCtx.fillRect(0, 0, width, height)
  }

  /**
   * Resize the trail layer, preserving what is already drawn — otherwise every
   * window resize would wipe the player's accumulated pattern.
   */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return
    const previous = this.trail
    const next = document.createElement('canvas')
    next.width = Math.max(1, width)
    next.height = Math.max(1, height)
    const ctx = next.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = '#040c1e'
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(previous, 0, 0)

    this.trail = next
    this.trailCtx = ctx
    this.width = width
    this.height = height
  }

  /** Wipe both the drawn history and the live figures. */
  reset() {
    this.blooms.length = 0
    this.trailCtx.globalCompositeOperation = 'source-over'
    this.trailCtx.fillStyle = '#040c1e'
    this.trailCtx.fillRect(0, 0, this.width, this.height)
  }

  get tipCount() {
    return this.blooms.reduce((n, b) => n + b.armCount, 0)
  }

  render(
    ctx: CanvasRenderingContext2D,
    params: FractalParams,
    hands: HandState[],
    dt: number,
  ) {
    this.time += dt
    const { width, height, trailCtx } = this

    // Fade the accumulated layer. Slow enough that a figure lingers for tens
    // of seconds; multiplying by dt keeps decay identical at any framerate.
    const decay = (0.028 + params.energy * 0.022) * dt
    trailCtx.globalCompositeOperation = 'source-over'
    trailCtx.fillStyle = `rgba(4, 12, 30, ${Math.min(decay, 0.5)})`
    trailCtx.fillRect(0, 0, width, height)

    this.emit(hands, params, dt)

    // Bands are opaque so overlapping figures occlude into layered depth,
    // the way the reference's shells stack. Additive blending would wash the
    // overlaps out to white.
    const speed = 0.28 + params.energy * 0.5
    const arms = this.tipCount
    for (const bloom of this.blooms) {
      bloom.step(trailCtx, dt, speed, Math.max(0, MAX_ARMS - arms + bloom.armCount))
    }

    // Retire finished figures so the population turns over and the pattern
    // keeps renewing instead of freezing once everything is complete.
    if (this.blooms.length > MAX_BLOOMS) {
      this.blooms.splice(0, this.blooms.length - MAX_BLOOMS)
    }

    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this.trail, 0, 0, width, height)

    drawCursors(ctx, width, height, hands, params)
  }

  /**
   * Emit a new bloom from each palm.
   *
   * Only the palm centre, rotation and openness are used — finger landmarks
   * are deliberately ignored, so tracking noise in individual fingers cannot
   * disturb the figure, and the gesture is simply "hold your hand up".
   */
  private emit(hands: HandState[], params: FractalParams, dt: number) {
    this.cooldown -= dt
    if (this.cooldown > 0) return
    if (this.tipCount > MAX_ARMS * 0.8) return

    const base = Math.min(this.width, this.height)

    if (hands.length === 0) {
      // Ambient bloom at centre so the screen is never dead.
      this.cooldown = 2.6
      this.blooms.push(
        new Bloom(this.width / 2, this.height / 2, this.time * 0.2, {
          ...this.specFor(params, base),
          hue: params.hue,
        }),
      )
      return
    }

    // Faster emission when hands are open, so an open palm pours out pattern.
    const openness = hands.reduce((m, h) => Math.max(m, h.openness), 0)
    this.cooldown = 1.5 - openness * 0.9

    for (const hand of hands) {
      const cx = (1 - hand.center.x) * this.width
      const cy = hand.center.y * this.height
      this.blooms.push(
        new Bloom(cx, cy, hand.rotation, {
          ...this.specFor(params, base),
          hue: hand.handedness === 'Left' ? 205 : 288,
        }),
      )
    }
  }

  /**
   * Build the transform set for one figure.
   *
   * Every value here is fixed for the lifetime of the bloom — that constancy
   * is precisely what makes the result self-similar rather than organic.
   */
  private specFor(params: FractalParams, base: number): IfsSpec {
    return {
      turns: 1.5 + params.spread * 0.9,
      // Tight spirals at low openness, open sweeping ones when the hand opens.
      b: 0.14 + params.ratio * 0.16,
      branches: Math.max(2, Math.min(4, Math.round(params.branches))),
      ratio: 0.34 + params.ratio * 0.12,
      branchAngle: 0.5 + params.spread * 0.7,
      depth: Math.max(2, Math.min(4, Math.round(params.depth * 0.45))),
      width: base * 0.055,
      scale: base * (0.20 + params.length * 0.55),
      hue: params.hue,
    }
  }
}

/** Palm ring only — finger dots are gone along with fingertip tracking. */
function drawCursors(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hands: HandState[],
  params: FractalParams,
) {
  ctx.globalCompositeOperation = 'lighter'
  for (const hand of hands) {
    const cx = (1 - hand.center.x) * width
    const cy = hand.center.y * height
    const hue = hand.handedness === 'Left' ? 205 : 288

    ctx.strokeStyle = `hsla(${hue}, 90%, 72%, ${0.28 + params.energy * 0.2})`
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, 18 + hand.openness * 30, 0, Math.PI * 2)
    ctx.stroke()
  }
  ctx.globalCompositeOperation = 'source-over'
}
