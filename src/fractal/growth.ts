import { sampleField, sampleHue } from './field'
import type { Field } from './field'
import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * A living growth front.
 *
 * The old renderer rebuilt the whole fractal by recursion every frame, so
 * nothing could persist or evolve. Here the fractal is a *population of tips*
 * that survives across frames: each tip advances a little, lays down a segment,
 * and occasionally splits. The drawn result accumulates on a canvas layer, so
 * the structure keeps growing without us storing a single line of it.
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
  width: number
  hue: number
  /** Generation depth, used to thin and fade descendants. */
  depth: number
  /** Which hand seeded this lineage; -1 for ambient seeds. */
  owner: number
  age: number
}

/**
 * Hard ceiling on live tips. Reached only under sustained heavy branching;
 * the energy budget usually keeps the population well below it. Exceeding it
 * costs frame time linearly, so it is a real limit rather than a safety net.
 */
const MAX_TIPS = 2600

/** Growth distance per second, px. Scaled by params.energy at use site. */
const SPEED = 190

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
   * Emit new tips from the fingertips of each hand, so growth literally
   * originates at the player's fingers rather than at an abstract palm point.
   * Cooldown is per hand to stop a still hand from firehosing tips.
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
      // An open hand sprouts faster; a fist nearly stops emitting.
      this.seedCooldown[index] = 0.10 - hand.openness * 0.055

      if (this.tips.length > MAX_TIPS * 0.9) return

      const base = Math.min(width, height)
      // Fingertips are the emitters, so a splayed hand sprays five streams and
      // a closed hand emits one tight bundle.
      const tips = hand.tips
      const emitCount = Math.max(1, Math.round(1 + hand.openness * (tips.length - 1)))

      for (let i = 0; i < emitCount; i++) {
        const tip = tips[i % tips.length]
        const x = (1 - tip.x) * width
        const y = tip.y * height
        // Aim outward from the palm through the fingertip: growth shoots the
        // way the finger points.
        const angle = Math.atan2(y - hand.center.y * height, x - (1 - hand.center.x) * width)

        this.tips.push({
          x,
          y,
          angle: angle + (Math.random() - 0.5) * 0.4,
          energy: base * params.length * (2.4 + params.depth * 0.5),
          sinceBranch: 0,
          width: 1.4 + params.energy * 2.6,
          hue: hand.handedness === 'Left' ? 195 : 310,
          depth: 0,
          owner: index,
          age: 0,
        })
      }
    })
  }

  /** Ambient seeds so the canvas is never empty before hands appear. */
  seedAmbient(width: number, height: number, params: FractalParams) {
    if (this.tips.length > 120) return
    const base = Math.min(width, height)
    const count = 3
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2
      this.tips.push({
        x: width / 2 + Math.cos(a) * base * 0.05,
        y: height / 2 + Math.sin(a) * base * 0.05,
        angle: a,
        energy: base * 0.9,
        sinceBranch: 0,
        width: 1.2,
        hue: params.hue,
        depth: 0,
        owner: -1,
        age: 0,
      })
    }
  }

  /**
   * Advance every tip one step and stroke its segment onto `ctx`.
   *
   * Drawing happens here rather than in a separate pass because each tip's
   * segment is only known during integration, and buffering them would mean
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
    const branchEvery = 26 + (1 - params.ratio) * 90
    const spread = params.spread
    const next: Tip[] = []

    ctx.lineCap = 'round'

    for (const tip of this.tips) {
      // Steer by the field. Blending toward the field direction (rather than
      // adding to it) keeps turns smooth and stops tips from spinning.
      sampleField(field, tip.x, tip.y, this.scratch)
      const fieldAngle = Math.atan2(this.scratch.y, this.scratch.x)
      const fieldMag = Math.hypot(this.scratch.x, this.scratch.y)
      const pull = Math.min(fieldMag * 0.02, 1) * 0.35

      let delta = ((fieldAngle - tip.angle + Math.PI) % (Math.PI * 2)) - Math.PI
      if (delta < -Math.PI) delta += Math.PI * 2
      tip.angle += delta * pull + (Math.random() - 0.5) * params.twist * 0.5

      const nx = tip.x + Math.cos(tip.angle) * step
      const ny = tip.y + Math.sin(tip.angle) * step

      const hue = sampleHue(field, tip.x, tip.y, tip.hue)
      // Fade with depth and with remaining energy so the growth front is
      // bright and the old interior settles back.
      const fade = Math.max(0, 1 - tip.depth * 0.12)
      ctx.strokeStyle = `hsla(${hue}, 88%, ${58 + params.energy * 14}%, ${0.16 + fade * 0.34})`
      ctx.lineWidth = tip.width
      ctx.beginPath()
      ctx.moveTo(tip.x, tip.y)
      ctx.lineTo(nx, ny)
      ctx.stroke()

      tip.x = nx
      tip.y = ny
      tip.energy -= step
      tip.sinceBranch += step
      tip.age += dt

      // Off-screen tips are dead weight — they cost time and draw nothing.
      const margin = 80
      const onScreen =
        nx > -margin && nx < width + margin && ny > -margin && ny < height + margin
      if (tip.energy <= 0 || !onScreen) continue

      if (tip.sinceBranch >= branchEvery && next.length + this.tips.length < MAX_TIPS) {
        tip.sinceBranch = 0
        const children = Math.max(2, Math.round(params.branches))
        // Energy splits between children, so branching trades reach for
        // richness instead of multiplying the population without bound.
        const childEnergy = (tip.energy / children) * 1.35
        for (let i = 0; i < children; i++) {
          const offset = children === 1 ? 0 : (i / (children - 1) - 0.5) * 2
          next.push({
            x: tip.x,
            y: tip.y,
            angle: tip.angle + offset * spread + params.twist * 0.6,
            energy: childEnergy,
            sinceBranch: 0,
            width: Math.max(0.5, tip.width * 0.82),
            hue,
            depth: tip.depth + 1,
            owner: tip.owner,
            age: 0,
          })
        }
        continue // the parent is replaced by its children
      }

      next.push(tip)
    }

    this.tips = next.length > MAX_TIPS ? next.slice(0, MAX_TIPS) : next
  }
}
