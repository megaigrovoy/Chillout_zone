import { sampleField, sampleHue } from './field'
import { drawRibbon } from './ribbon'
import type { Field } from './field'
import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * A living growth front.
 *
 * The fractal is a *population of tips* that survives across frames: each tip
 * advances, lays down a tapering ribbon segment, and occasionally splits. The
 * drawn result accumulates on a canvas layer, so the structure keeps growing
 * without us storing a single line of it.
 *
 * Tips travel on logarithmic spirals rather than straight lines — a constant
 * turn rate against a shrinking radius. That is the curve behind every shell
 * and every classic spiral fractal, and it is what makes the form coil into
 * itself instead of spraying outward.
 */
export interface Tip {
  x: number
  y: number
  /** Heading, radians. */
  angle: number
  /**
   * Remaining growth budget. Splitting divides it between children, so a
   * lineage cannot branch forever — this is what bounds the population without
   * a hard cutoff that would visibly chop branches off.
   */
  energy: number
  /** Distance travelled since the last branch, px. */
  sinceBranch: number
  /** Current half-width of the ribbon, px. Grows as the tip travels. */
  width: number
  /** Half-width at birth — the base the widening is measured from. */
  birthWidth: number
  /** Turn rate, rad/px — the signed tightness of this lineage's spiral. */
  curl: number
  hue: number
  /** Generation depth, used to thin and darken descendants. */
  depth: number
  /** Which hand seeded this lineage; -1 for ambient seeds. */
  owner: number
  age: number
  /** Total distance travelled, px — drives taper and shading. */
  travelled: number
  /** Lifetime distance budget at birth, for normalising taper. */
  span: number
}

/**
 * Hard ceiling on live tips. Ribbons cost far more per tip than threads did
 * (a filled quad plus layers plus lace), so this is materially lower than the
 * thread-era limit — the population must stay small enough that each tip can
 * afford to be visually rich.
 */
const MAX_TIPS = 1100

/** Growth distance per second, px. Scaled by params.energy at use site. */
const SPEED = 150

export class GrowthSystem {
  tips: Tip[] = []
  private scratch = { x: 0, y: 0 }
  private seedCooldown: number[] = []

  /** Drop the whole population — used on resize and on manual reset. */
  clear() {
    this.tips.length = 0
    this.seedCooldown.length = 0
  }

  /**
   * Emit new ribbons from the fingertips of each hand, fanned across the full
   * circle so the fractal grows out of the hand in every direction rather than
   * only where the fingers point.
   */
  seedFromHands(
    hands: HandState[],
    width: number,
    height: number,
    params: FractalParams,
    dt: number,
  ) {
    hands.forEach((hand, index) => {
      this.seedCooldown[index] = (this.seedCooldown[index] ?? 0) - dt
      if (this.seedCooldown[index] > 0) return
      // Ribbons are expensive and long-lived, so emission is slower than it
      // was for threads; an open hand still sprouts faster than a fist.
      this.seedCooldown[index] = 0.20 - hand.openness * 0.11

      if (this.tips.length > MAX_TIPS * 0.85) return

      const base = Math.min(width, height)
      const cx = (1 - hand.center.x) * width
      const cy = hand.center.y * height

      // Fan seeds evenly around the palm. Fingertips still set the emission
      // ring, but the directions sweep the whole circle so growth radiates
      // outward on all sides.
      const arms = 3 + Math.round(hand.openness * 3)
      const spin = hand.rotation

      for (let i = 0; i < arms; i++) {
        const angle = (i / arms) * Math.PI * 2 + spin
        // Start slightly off the palm so ribbons appear to leave the hand.
        const r = base * 0.035
        // Long enough to cross the frame: a ribbon must be able to reach the
        // edge, otherwise growth visibly stalls in a halo around the hand.
        const span = base * params.length * (7 + params.depth * 1.8)

        this.tips.push({
          x: cx + Math.cos(angle) * r,
          y: cy + Math.sin(angle) * r,
          angle,
          energy: span,
          span,
          sinceBranch: 0,
          // Narrow at the hand and opening outward, so the form reads as
          // erupting from the palm rather than terminating at it.
          width: base * (0.004 + params.energy * 0.004),
          birthWidth: base * (0.004 + params.energy * 0.004),
          // Alternating spin makes neighbouring arms coil opposite ways, which
          // is what produces interleaved shells rather than a uniform pinwheel.
          curl: (i % 2 === 0 ? 1 : -1) * (0.004 + Math.random() * 0.006),
          hue: hand.handedness === 'Left' ? 205 : 288,
          depth: 0,
          owner: index,
          age: 0,
          travelled: 0,
        })
      }
    })
  }

  /** Ambient seeds so the canvas is never empty before hands appear. */
  seedAmbient(width: number, height: number, params: FractalParams) {
    if (this.tips.length > 26) return
    const base = Math.min(width, height)
    const arms = 5
    for (let i = 0; i < arms; i++) {
      const a = (i / arms) * Math.PI * 2 + Math.random() * 0.4
      const span = base * 0.85
      this.tips.push({
        x: width / 2 + Math.cos(a) * base * 0.04,
        y: height / 2 + Math.sin(a) * base * 0.04,
        angle: a,
        energy: span,
        span,
        sinceBranch: 0,
        width: base * 0.004,
        birthWidth: base * 0.004,
        curl: (i % 2 === 0 ? 1 : -1) * (0.004 + Math.random() * 0.005),
        hue: params.hue,
        depth: 0,
        owner: -1,
        age: 0,
        travelled: 0,
      })
    }
  }

  /**
   * Advance every tip one step and stroke its ribbon onto `ctx`.
   *
   * Drawing happens here rather than in a separate pass because each segment's
   * geometry is only known during integration, and buffering it would mean
   * allocating per segment per frame.
   */
  step(
    ctx: CanvasRenderingContext2D,
    field: Field,
    params: FractalParams,
    dt: number,
    width: number,
    height: number,
  ) {
    const step = SPEED * (0.45 + params.energy) * dt
    // Branch often: dense splitting is what fills the frame with nested
    // spirals rather than a few lonely arms.
    const branchEvery = 34 + (1 - params.ratio) * 66
    // Ceiling on ribbon half-width, tied to frame size so it scales with the
    // display rather than being a magic pixel count.
    const maxWidth = Math.min(width, height) * 0.022
    const spread = params.spread
    const next: Tip[] = []

    for (const tip of this.tips) {
      const a1 = tip.angle
      const w1 = tip.width

      // Two steering influences: the tip's own spiral curl, and the hand
      // vortex field. The curl dominates so lineages keep their character,
      // while the field bends whole families of ribbons around the hands.
      sampleField(field, tip.x, tip.y, this.scratch)
      const fieldAngle = Math.atan2(this.scratch.y, this.scratch.x)
      const fieldMag = Math.hypot(this.scratch.x, this.scratch.y)
      const pull = Math.min(fieldMag * 0.02, 1) * 0.10

      let delta = ((fieldAngle - tip.angle + Math.PI) % (Math.PI * 2)) - Math.PI
      if (delta < -Math.PI) delta += Math.PI * 2

      // Curvature decays with distance travelled — the defining property of a
      // logarithmic spiral, and the reason the form escapes instead of winding
      // into a tight ball near the hand. A constant turn rate would close every
      // ribbon into a circle within a few hundred pixels.
      const unwind = tip.curl / (1 + tip.travelled * 0.012)
      tip.angle += unwind * step + delta * pull

      const nx = tip.x + Math.cos(tip.angle) * step
      const ny = tip.y + Math.sin(tip.angle) * step

      tip.travelled += step
      // Ribbons *widen* as they travel away from the hand. Tapering to a point
      // made the form die on the spot and read as a fur ball around the palm;
      // growing outward is what sells an expanding structure escaping to
      // infinity. Width is driven by distance from the seed, not by a lifetime
      // fraction, so it keeps opening for as long as the ribbon survives.
      const reach = tip.travelled / Math.max(tip.span, 1)
      // Widening is capped: unbounded growth compounds across generations into
      // bands hundreds of pixels wide that merge into flat fill and destroy the
      // structure. sqrt keeps the opening fast at first and gentle later.
      const w2 = Math.min(tip.birthWidth * (1 + Math.sqrt(reach) * 2.2), maxWidth)

      const hue = sampleHue(field, tip.x, tip.y, tip.hue)
      // Brightness rises with reach so the outer, larger structure is the lit
      // part and the tangle near the hand stays dark and dense.
      const shade = Math.min(reach * 0.9, 1) * (0.55 + params.energy * 0.45)
      // Lace follows the *current* curvature, so curls cluster where the
      // ribbon is still coiling and thin out as it straightens away.
      const lace = Math.min(Math.abs(unwind) * 90, 1) * (0.35 + params.energy * 0.5)

      drawRibbon(ctx, {
        x1: tip.x,
        y1: tip.y,
        x2: nx,
        y2: ny,
        w1,
        w2,
        a1,
        a2: tip.angle,
        hue,
        shade,
        lace,
        curl: tip.curl,
      })

      tip.x = nx
      tip.y = ny
      tip.width = w2
      tip.energy -= step
      tip.sinceBranch += step
      tip.age += dt

      // Off-screen tips are dead weight — they cost time and draw nothing.
      // Nothing dies of thinness any more: ribbons only end by running out of
      // energy or by leaving the frame, which is what lets them keep opening
      // all the way to the edge instead of fading out mid-flight.
      const margin = 120
      const onScreen =
        nx > -margin && nx < width + margin && ny > -margin && ny < height + margin
      if (tip.energy <= 0 || !onScreen) continue

      if (tip.sinceBranch >= branchEvery && next.length + this.tips.length < MAX_TIPS) {
        tip.sinceBranch = 0
        const children = Math.max(2, Math.round(params.branches))
        const childEnergy = (tip.energy / children) * 1.5
        for (let i = 0; i < children; i++) {
          const offset = children === 1 ? 0 : (i / (children - 1) - 0.5) * 2
          next.push({
            x: tip.x,
            y: tip.y,
            angle: tip.angle + offset * spread * 0.7,
            energy: childEnergy,
            span: childEnergy,
            sinceBranch: 0,
            // Children continue from the parent's current width rather than
            // shrinking off it, so a lineage keeps opening across generations
            // instead of thinning away a few branches out.
            width: tip.width,
            birthWidth: tip.width,
            // Children curl harder than the parent: successive generations
            // coil tighter, which is exactly the self-similar nesting that
            // makes the reference image read as a fractal.
            curl: tip.curl * (1.25 + Math.random() * 0.3) * (offset >= 0 ? 1 : -1),
            hue,
            depth: tip.depth + 1,
            owner: tip.owner,
            age: 0,
            travelled: 0,
          })
        }
        continue // the parent is replaced by its children
      }

      next.push(tip)
    }

    this.tips = next.length > MAX_TIPS ? next.slice(0, MAX_TIPS) : next
  }
}
