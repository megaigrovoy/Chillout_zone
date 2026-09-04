import { ParticleSystem } from './physics'
import { drawHandOverlay } from './handOverlay'
import { MetaballField, CELL } from './metaball'
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

  /** Scalar field the surface is extracted from. */
  private metaballs: MetaballField
  /** Reused segment buffer, so contouring allocates nothing per frame. */
  private segments: number[] = []

  constructor(private width: number, private height: number) {
    this.metaballs = new MetaballField(width, height)
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
    this.metaballs.resize(width, height)
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
      this.emitCooldown[index] = 0.075 - flow * 0.05

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
      const burst = 1 + Math.round(flow * 2)
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
   * Draw the paint as one connected surface.
   *
   * Two layers: a soft body built from the droplets themselves, and a contour
   * traced from the metaball field on top of it. The contour is what sells the
   * substance — it is a single continuous outline around whatever the droplets
   * collectively form, so neighbouring droplets read as one mass with a skin
   * rather than as a cluster of separate blobs.
   */
  private draw(ctx: CanvasRenderingContext2D) {
    const { width, height } = this

    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = '#070a16'
    ctx.fillRect(0, 0, width, height)

    const { x, y, hue, count } = this.sys
    if (count === 0) return

    this.metaballs.build(x, y, hue, count)

    // Body: fill the field's interior directly. Painting per-droplet brushes
    // here instead reproduces the old cluster-of-blobs look no matter what the
    // contour does, and buries the surface under it.
    this.drawBody(ctx)
    this.drawSurface(ctx)
  }

  /**
   * Fill the interior of the surface.
   *
   * Cells are drawn slightly oversized so neighbours overlap and the interior
   * reads as continuous rather than as a visible grid.
   */
  private drawBody(ctx: CanvasRenderingContext2D) {
    const pad = CELL * 0.75
    const size = CELL + pad * 2

    ctx.globalCompositeOperation = 'source-over'
    this.metaballs.forEachInsideCell((cx, cy, hue, depth) => {
      // Deeper inside the mass is lighter and more saturated, so the body has
      // shading instead of being a flat silhouette.
      const l = 24 + Math.min(depth, 1.6) * 17
      ctx.fillStyle = `hsl(${hue}, 74%, ${l}%)`
      ctx.fillRect(cx - pad, cy - pad, size, size)
    })
  }

  /**
   * Stroke the metaball contour.
   *
   * Segments are batched per colour band rather than stroked individually:
   * marching squares emits hundreds of them, and a stroke() per segment would
   * dominate the frame. Banding by hue keeps the two hands distinguishable
   * along the surface where their paint meets.
   */
  private drawSurface(ctx: CanvasRenderingContext2D) {
    const segs = this.segments
    const n = this.metaballs.contour(segs)
    if (n === 0) return

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Two hue bands, one per hand, so the skin is tinted by whichever paint
    // formed it. More bands would mean more stroke calls for no visible gain.
    for (let band = 0; band < 2; band++) {
      const bandHue = band === 0 ? LEFT_HUE : RIGHT_HUE

      for (let pass = 0; pass < 2; pass++) {
        const glow = pass === 0
        ctx.lineWidth = glow ? 9 : 2.4
        ctx.strokeStyle = `hsla(${bandHue}, 95%, ${glow ? 58 : 82}%, ${glow ? 0.10 : 0.85})`
        ctx.beginPath()

        let any = false
        for (let k = 0; k < segs.length; k += 4) {
          const mx = (segs[k] + segs[k + 2]) * 0.5
          const my = (segs[k + 1] + segs[k + 3]) * 0.5
          const h = this.metaballs.hueAt(mx, my)
          // Assign each segment to the nearer band, so the boundary between the
          // two colours falls where the paints actually meet.
          const nearer = Math.abs(h - LEFT_HUE) < Math.abs(h - RIGHT_HUE) ? 0 : 1
          if (nearer !== band) continue

          ctx.moveTo(segs[k], segs[k + 1])
          ctx.lineTo(segs[k + 2], segs[k + 3])
          any = true
        }

        if (any) ctx.stroke()
      }
    }

    ctx.globalCompositeOperation = 'source-over'
  }

}
