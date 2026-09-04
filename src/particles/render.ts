import { ParticleSystem } from './physics'
import { drawHandOverlay } from './handOverlay'
import { MetaballField } from './metaball'
import type { HandState } from '../tracking/types'

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

/**
 * Where the interior shading sits, as a fraction of the way from the surface
 * to the field's peak. Relative rather than absolute so the rim keeps a
 * consistent width however much paint is piled up.
 */
const INTERIOR_FRACTION = 0.35

export class ParticleRenderer {
  private sys = new ParticleSystem()
  private emitCooldown: number[] = []
  private impactGlow = 0

  /** Scalar field the surface is extracted from. */
  private metaballs: MetaballField
  /** Reused segment buffer, so contouring allocates nothing per frame. */
  private segments: number[] = []
  /** Reused polygon buffer for the body fill, for the same reason. */
  private polyBuffer: number[] = []
  /** Offscreen buffer holding the local paint mixture at grid resolution. */
  private mixCanvas: HTMLCanvasElement | null = null
  private mixCtx: CanvasRenderingContext2D | null = null
  private mixImage: ImageData | null = null

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

    this.draw(ctx, hands)
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
  private draw(ctx: CanvasRenderingContext2D, hands: HandState[]) {
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
    this.drawBody(ctx, hands)
    this.drawSurface(ctx, hands)
  }

  /**
   * Fill the interior of the surface.
   *
   * Each cell is filled with the polygon marching squares describes for it, so
   * the body's edge lands exactly where the contour is drawn. Filling squares
   * instead left the boundary snapped to the grid while the outline followed
   * the interpolated crossings, which is what made the edges look pixelated.
   */
  private drawBody(ctx: CanvasRenderingContext2D, _hands: HandState[]) {
    ctx.globalCompositeOperation = 'source-over'

    // Colour comes from the local paint mixture, not from where the hands are.
    //
    // A gradient between the palms was geometric: it coloured a *place* rather
    // than whatever paint sat there, so paint flung from one hand into the
    // other's half took the wrong colour. The field already tracks the mixture
    // — each droplet contributes its hue weighted by influence — so that is
    // what gets drawn, sampled per texel and stretched over the shape.
    this.tracePath(ctx, this.metaballs.levelAt(0))
    ctx.fillStyle = '#fff'
    ctx.fill()

    this.tracePath(ctx, this.metaballs.levelAt(INTERIOR_FRACTION))
    ctx.fillStyle = '#fff'
    ctx.fill()

    // Paint the mixture over the shape just drawn. source-atop clips it to the
    // existing pixels, so the colour lands on the body and nowhere else.
    this.paintMixtureOver(ctx, 34, 0.86)
  }

  /**
   * Draw the mixture buffer over whatever is already on the canvas.
   *
   * @param light  base lightness of the paint
   * @param alpha  how strongly the mixture replaces what is beneath
   */
  private paintMixtureOver(ctx: CanvasRenderingContext2D, light: number, alpha: number) {
    const cols = this.metaballs.gridCols
    const rows = this.metaballs.gridRows

    if (!this.mixCanvas || this.mixCanvas.width !== cols || this.mixCanvas.height !== rows) {
      const c = document.createElement('canvas')
      c.width = Math.max(1, cols)
      c.height = Math.max(1, rows)
      this.mixCanvas = c
      this.mixCtx = c.getContext('2d')
      this.mixImage = this.mixCtx?.createImageData(c.width, c.height) ?? null
    }
    const mixCtx = this.mixCtx
    const mixImage = this.mixImage
    if (!mixCtx || !mixImage) return

    this.metaballs.paintMixture(mixImage, (hue, out, at) => {
      hslToRgb(hue, 0.78, light / 100, out, at)
      out[at + 3] = 255
    })
    mixCtx.putImageData(mixImage, 0, 0)

    ctx.save()
    ctx.globalCompositeOperation = 'source-atop'
    ctx.globalAlpha = alpha
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.mixCanvas!, 0, 0, this.width, this.height)
    ctx.restore()
  }

  /** Build one canvas path covering every cell inside the given iso-level. */
  private tracePath(ctx: CanvasRenderingContext2D, level: number) {
    ctx.beginPath()
    this.metaballs.forEachInsidePolygon(this.polyBuffer, (p) => {
      ctx.moveTo(p[0], p[1])
      for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1])
      ctx.closePath()
    }, level)
  }

  /**
   * Stroke the metaball contour.
   *
   * Segments are batched per colour band rather than stroked individually:
   * marching squares emits hundreds of them, and a stroke() per segment would
   * dominate the frame. Banding by hue keeps the two hands distinguishable
   * along the surface where their paint meets.
   */
  private drawSurface(ctx: CanvasRenderingContext2D, _hands: HandState[]) {
    const segs = this.segments
    const n = this.metaballs.contour(segs)
    if (n === 0) return

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // The skin is banded by hue like the body, so it blends across the seam
    // instead of switching colour at a cell border. Empty bands are skipped:
    // most of them find nothing, since the paints sit at the extremes.
    // The skin is stroked white and then tinted by the same mixture pass, so it
    // matches the body's colour wherever it runs instead of being coloured by
    // position.
    for (let pass = 0; pass < 2; pass++) {
      const glow = pass === 0
      ctx.lineWidth = glow ? 9 : 2.4
      ctx.strokeStyle = glow ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.85)'

      ctx.beginPath()
      for (let k = 0; k < segs.length; k += 4) {
        ctx.moveTo(segs[k], segs[k + 1])
        ctx.lineTo(segs[k + 2], segs[k + 3])
      }
      ctx.stroke()
    }

    // Lift the skin's colour: brighter and more saturated than the body so it
    // reads as a highlight along the surface.
    this.paintMixtureOver(ctx, 76, 0.7)

    ctx.globalCompositeOperation = 'source-over'
  }

}

/**
 * HSL to RGB, written into a byte buffer in place.
 *
 * Used per texel of the mixture buffer, so it avoids strings and allocation —
 * the canvas colour parser would be far too slow at this call rate.
 */
function hslToRgb(h: number, s: number, l: number, out: Uint8ClampedArray, at: number) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x }
  else if (hp < 2) { r = x; g = c }
  else if (hp < 3) { g = c; b = x }
  else if (hp < 4) { g = x; b = c }
  else if (hp < 5) { r = x; b = c }
  else { r = c; b = x }
  const m = l - c / 2
  out[at] = (r + m) * 255
  out[at + 1] = (g + m) * 255
  out[at + 2] = (b + m) * 255
}
