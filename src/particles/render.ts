import { ParticleSystem, RADIUS } from './physics'
import { drawHandOverlay } from './handOverlay'
import type { HandState } from '../tracking/types'

/**
 * Collision mode renderer.
 *
 * Each hand emits a stream of particles that carry its colour. The two streams
 * genuinely collide — momentum is exchanged, particles rebound — so the forms
 * push against each other as physical matter rather than through the staged
 * interaction the flame mode uses.
 *
 * Trails come from fading the canvas rather than clearing it, matching the
 * flame mode's look and costing one fillRect instead of a per-particle history.
 */

/** Colour coordinates for the two hands, kept in the app's cool palette. */
const LEFT_HUE = 195
const RIGHT_HUE = 300

/**
 * Hand openness below which no paint is released at all.
 *
 * Set inside the measured range rather than at zero: a fist does not register
 * as exactly 0 openness, so a threshold at 0 would never actually close the
 * tap.
 */
const OPEN_THRESHOLD = 0.32

/**
 * How far the tap is open, 0..1, renormalised past the threshold.
 *
 * Shared by emission and the overlay so the two can never disagree about
 * whether paint is flowing — duplicating the arithmetic would let a change to
 * the threshold leave the overlay showing a tap state that is no longer real.
 */
function flowOf(openness: number): number {
  if (openness < OPEN_THRESHOLD) return 0
  return (openness - OPEN_THRESHOLD) / (1 - OPEN_THRESHOLD)
}

export class ParticleRenderer {
  private sys = new ParticleSystem()
  private emitCooldown: number[] = []
  private impactGlow = 0
  /**
   * Pre-tinted brushes, keyed by "hue|lightness|saturation".
   *
   * drawImage ignores fillStyle, so a white brush stays white however the
   * context is configured. Tinting has to happen when the brush is built, and
   * since only a handful of colour combinations are ever used they are cached
   * rather than rebuilt per droplet.
   */
  private brushes = new Map<string, HTMLCanvasElement>()

  constructor(private width: number, private height: number) {}

  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  reset() {
    this.sys.clear()
    this.emitCooldown.length = 0
    this.impactGlow = 0
  }

  get particleCount() {
    return this.sys.count
  }

  render(ctx: CanvasRenderingContext2D, hands: HandState[], dt: number) {
    const { width, height } = this

    this.emit(hands, dt)
    this.applyHandForces(hands, dt)
    this.sys.integrate(dt, width, height)

    // Contact is resolved over several passes; see RELAX_PASSES.
    const impulse = this.sys.relax(width, height, dt)
    // Normalise by count so the global flash reflects collision *intensity*
    // rather than merely how many particles are on screen.
    const perParticle = this.sys.count > 0 ? impulse / this.sys.count : 0
    const target = Math.min(1, perParticle * 0.02)
    if (target > this.impactGlow) this.impactGlow += (target - this.impactGlow) * 0.5
    else this.impactGlow *= Math.pow(0.06, dt)

    this.draw(ctx)
    this.drawHands(ctx, hands)
  }

  /**
   * Draw each hand in its own emitter colour.
   *
   * Painted after the fluid so the hands read as being in front of the paint,
   * and using the same openness gate as emission, so the overlay always shows
   * the true state of the tap rather than a separate approximation of it.
   */
  private drawHands(ctx: CanvasRenderingContext2D, hands: HandState[]) {
    for (const hand of hands) {
      const hue = hand.handedness === 'Left' ? LEFT_HUE : RIGHT_HUE
      const flow = flowOf(hand.openness)
      drawHandOverlay(
        ctx,
        this.width,
        this.height,
        hand,
        hue,
        flow,
      )
    }
  }

  /**
   * Spawn particles at each palm.
   *
   * Emission rate follows openness, so an open hand pours out matter and a
   * fist barely trickles — the same gesture mapping as the flame mode, so the
   * two modes feel related.
   */
  private emit(hands: HandState[], dt: number) {
    hands.forEach((hand, index) => {
      this.emitCooldown[index] = (this.emitCooldown[index] ?? 0) - dt

      // A closed hand is a closed tap: below the threshold the flow stops
      // entirely rather than merely slowing. A rate that only tapers left paint
      // trickling from a fist, so the gesture never read as "off".
      const flow = flowOf(hand.openness)
      if (flow <= 0) return

      if (this.emitCooldown[index] > 0) return
      // Slower emission than a spray: paint is laid down, not poured.
      this.emitCooldown[index] = 0.05 - flow * 0.038

      const cx = (1 - hand.center.x) * this.width
      const cy = hand.center.y * this.height
      const hue = hand.handedness === 'Left' ? LEFT_HUE : RIGHT_HUE

      // Inherit the hand's own velocity so a throwing motion actually throws
      // the particles, which is what makes flinging one stream into the other
      // feel physical.
      const hvx = -hand.velocity.x * this.width * 0.6
      const hvy = hand.velocity.y * this.height * 0.6

      // A small dollop per emission, dropped almost at rest: thick paint has no
      // launch velocity of its own, it only goes where the hand takes it. A
      // wider-open hand releases more at once, so opening further visibly
      // increases the flow rather than only its frequency.
      const burst = 2 + Math.round(flow * 5)
      for (let k = 0; k < burst; k++) {
        const a = Math.random() * Math.PI * 2
        const speed = 4 + Math.random() * 16
        // Emission ring widens as the hand opens, so paint spreads out of an
        // open palm and stays a tight bead from a nearly-closed one.
        const r = 4 + Math.random() * (6 + flow * 18)
        this.sys.spawn(
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          Math.cos(a) * speed + hvx * 0.5,
          Math.sin(a) * speed + hvy * 0.5,
          hue,
        )
      }
    })
  }

  /**
   * Hands act as force fields on existing particles.
   *
   * An open palm attracts, a fist repels — so you can gather a cloud and then
   * punch it into the other hand's cloud. Without this the hands could only
   * emit, and the two streams would never be aimed at each other deliberately.
   */
  private applyHandForces(hands: HandState[], dt: number) {
    if (hands.length === 0) return
    const base = Math.min(this.width, this.height)
    // A local reach, not a field over the whole canvas: paint is displaced by
    // the hand that touches it, and a wide pull made the entire body drift as
    // one, which read as gravity rather than as fingers in paint.
    const reach = base * 0.16
    const reachSq = reach * reach

    for (const hand of hands) {
      const hx = (1 - hand.center.x) * this.width
      const hy = hand.center.y * this.height
      // Hand motion in pixels per second: the primary way paint is moved.
      const hvx = -hand.velocity.x * this.width
      const hvy = hand.velocity.y * this.height

      // Open palm gathers, fist pushes away — a gentler version of before,
      // since dragging is now the main interaction.
      const sign = hand.openness > 0.5 ? 1 : -1
      const gather = base * (0.6 + Math.abs(hand.openness - 0.5) * 2.4) * sign

      for (let i = 0; i < this.sys.count; i++) {
        const dx = hx - this.sys.x[i]
        const dy = hy - this.sys.y[i]
        const dSq = dx * dx + dy * dy
        if (dSq > reachSq || dSq < 1) continue

        const d = Math.sqrt(dSq)
        const falloff = 1 - d / reach

        // Dragging: paint under the hand is carried along with it. This is what
        // makes the gesture feel like smearing rather than attracting.
        const drag = falloff * falloff * 9 * dt
        this.sys.vx[i] += (hvx - this.sys.vx[i]) * Math.min(0.9, drag)
        this.sys.vy[i] += (hvy - this.sys.vy[i]) * Math.min(0.9, drag)

        // Radial gather/push on top, capped near the palm so a hand resting on
        // the paint does not fling it.
        const f = gather * (falloff / Math.max(d, reach * 0.25)) * dt
        this.sys.vx[i] += (dx / d) * f
        this.sys.vy[i] += (dy / d) * f
      }
    }
  }

  /**
   * Draw the paint.
   *
   * Additive glowing dots read as sparks, not as pigment. Thick paint needs the
   * opposite: opaque, saturated blobs that merge where they overlap and hide
   * what is behind them. So droplets are drawn as solid radial blobs with a
   * soft edge, and the canvas is cleared rather than faded — a fading trail
   * would leave ghosts of paint that is no longer there.
   */
  private draw(ctx: CanvasRenderingContext2D) {
    const { width, height } = this

    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#070a16'
    ctx.fillRect(0, 0, width, height)

    const { x, y, hue, flash, age, count } = this.sys
    if (count === 0) return


    // Two passes. The first lays down a wide, dark body: overlapping blobs
    // build up into a continuous mass with soft boundaries, the way merging
    // lava-lamp globules look. The second adds a tighter bright core so the
    // paint has depth instead of reading as flat silhouette.
    for (let pass = 0; pass < 2; pass++) {
      const body = pass === 0
      const size = RADIUS * (body ? 7.5 : 3.6)
      const baseAlpha = body ? 0.5 : 0.28

      for (let i = 0; i < count; i++) {
        // Fade in over the first moments. Recycled slots teleport a droplet
        // from wherever it was to the hand, and fading hides both ends of that
        // jump; fresh droplets get the same treatment for free.
        const fade = Math.min(1, age[i] * 4)
        ctx.globalAlpha = baseAlpha * fade

        // Flash is quantised into a few steps so the brush cache stays small;
        // at these sizes the banding is invisible.
        const step = Math.round(flash[i] * 3)
        const brush = this.brushFor(hue[i], body, step)
        ctx.drawImage(brush, x[i] - size, y[i] - size, size * 2, size * 2)
      }
    }

    ctx.globalAlpha = 1
  }

  /**
   * A soft round brush in a given colour, built once and cached.
   *
   * Drawn as an image rather than arc()+fill() so the edge can be a gradient:
   * hard-edged circles at this size would tile visibly instead of merging, and
   * merging is the whole effect.
   */
  private brushFor(hue: number, body: boolean, flashStep: number): HTMLCanvasElement {
    const key = `${Math.round(hue)}|${body ? 1 : 0}|${flashStep}`
    const cached = this.brushes.get(key)
    if (cached) return cached

    const f = flashStep / 3
    const l = body ? 26 + f * 14 : 58 + f * 22
    const sat = body ? 72 : 86

    const size = 64
    const c = document.createElement('canvas')
    c.width = size
    c.height = size
    const bctx = c.getContext('2d')
    if (!bctx) return c

    const r = size / 2
    const grad = bctx.createRadialGradient(r, r, 0, r, r, r)
    grad.addColorStop(0, `hsla(${hue}, ${sat}%, ${l}%, 1)`)
    grad.addColorStop(0.5, `hsla(${hue}, ${sat}%, ${l}%, 0.85)`)
    grad.addColorStop(0.82, `hsla(${hue}, ${sat}%, ${l}%, 0.28)`)
    grad.addColorStop(1, `hsla(${hue}, ${sat}%, ${l}%, 0)`)
    bctx.fillStyle = grad
    bctx.fillRect(0, 0, size, size)

    this.brushes.set(key, c)
    return c
  }
}
