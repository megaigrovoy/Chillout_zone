import { spiralSpine, attachPoints } from './ifs'
import type { IfsSpec, SpinePoint } from './ifs'
import { drawSpiralBand } from './band'

/**
 * A growing self-similar bloom.
 *
 * One bloom is a whole IFS figure: a spiral arm, child arms on its rim, their
 * children on theirs. It is revealed progressively rather than drawn at once,
 * so the pattern appears to grow — and because every level shares one `IfsSpec`,
 * the small parts are exact scaled copies of the large ones.
 *
 * "Infinite" growth comes from two nested loops: each bloom deepens over time
 * *and* expands outward, while new blooms keep being emitted from the hand.
 */

interface Arm {
  /** Local-space spine, computed once at creation. */
  spine: SpinePoint[]
  /** World transform of this arm. */
  ox: number
  oy: number
  rot: number
  scale: number
  depth: number
  /** How much of this arm has been revealed, 0..1. */
  progress: number
  /** Whether children have already been spawned. */
  seeded: boolean
  hue: number
}

export class Bloom {
  private arms: Arm[] = []
  private spec: IfsSpec
  /** Total lifetime in seconds, used for fade-in of the whole figure. */
  age = 0

  constructor(x: number, y: number, rotation: number, spec: IfsSpec) {
    this.spec = spec
    this.arms.push(this.makeArm(x, y, rotation, 1, 0, spec.hue))
  }

  private makeArm(
    ox: number,
    oy: number,
    rot: number,
    scale: number,
    depth: number,
    hue: number,
  ): Arm {
    // Fewer sample points at depth: a level-3 arm is a few pixels across, and
    // sampling it as finely as the trunk would burn most of the frame budget
    // on curves nobody can resolve.
    const steps = Math.max(10, Math.round(46 / (1 + depth)))
    return {
      spine: spiralSpine(this.spec, steps),
      ox,
      oy,
      rot,
      scale,
      depth,
      progress: 0,
      seeded: false,
      hue,
    }
  }

  get armCount() {
    return this.arms.length
  }

  /** True once every arm is fully drawn and the deepest level is reached. */
  get finished() {
    return this.arms.every((a) => a.progress >= 1 && (a.seeded || a.depth >= this.spec.depth))
  }

  /**
   * Advance the reveal and draw. `speed` is fraction-of-arm per second, so
   * growth reads at the same rate regardless of framerate.
   */
  step(ctx: CanvasRenderingContext2D, dt: number, speed: number, maxArms: number) {
    this.age += dt
    const spawned: Arm[] = []

    for (const arm of this.arms) {
      const before = arm.progress
      if (arm.progress < 1) {
        // Deeper arms complete faster, so detail fills in behind the leading
        // edge instead of lagging visibly far behind it.
        arm.progress = Math.min(1, arm.progress + dt * speed * (1 + arm.depth * 0.6))
      }

      this.drawArm(ctx, arm, before, arm.progress)

      // Children appear once the parent's rim exists to carry them.
      if (!arm.seeded && arm.progress >= 0.55 && arm.depth < this.spec.depth) {
        arm.seeded = true
        if (this.arms.length + spawned.length < maxArms) {
          spawned.push(...this.spawnChildren(arm))
        }
      }
    }

    if (spawned.length) this.arms.push(...spawned)
  }

  /**
   * Attach scaled copies along the parent's rim.
   *
   * This is the step that creates self-similarity: children get the *same*
   * spec, only a smaller scale and a rotation taken from the parent's local
   * tangent, so the figure repeats itself exactly at every level.
   */
  private spawnChildren(parent: Arm): Arm[] {
    const out: Arm[] = []
    const spots = attachPoints(this.spec.branches)

    for (let i = 0; i < spots.length; i++) {
      const at = spots[i]
      const idx = Math.min(parent.spine.length - 1, Math.floor(at * parent.spine.length))
      const p = parent.spine[idx]

      const cos = Math.cos(parent.rot)
      const sin = Math.sin(parent.rot)
      const wx = parent.ox + (p.x * cos - p.y * sin) * parent.scale
      const wy = parent.oy + (p.x * sin + p.y * cos) * parent.scale

      // Alternate the side children sit on, which is what produces the
      // symmetric fringe along a band rather than a one-sided comb.
      const side = i % 2 === 0 ? 1 : -1
      const rot = parent.rot + p.angle + this.spec.branchAngle * side

      out.push(
        this.makeArm(
          wx,
          wy,
          rot,
          parent.scale * this.spec.ratio,
          parent.depth + 1,
          // Hue shifts a fixed amount per level, so depth is readable as
          // colour and the palette stays coherent across the whole figure.
          parent.hue + 8,
        ),
      )
    }

    return out
  }

  /** Draw the newly revealed slice of an arm. */
  private drawArm(ctx: CanvasRenderingContext2D, arm: Arm, from: number, to: number) {
    if (to <= from) return
    const n = arm.spine.length - 1
    const i0 = Math.max(0, Math.floor(from * n))
    const i1 = Math.min(n, Math.ceil(to * n))

    const cos = Math.cos(arm.rot)
    const sin = Math.sin(arm.rot)

    for (let i = i0; i < i1; i++) {
      const a = arm.spine[i]
      const b = arm.spine[i + 1]

      const ax = arm.ox + (a.x * cos - a.y * sin) * arm.scale
      const ay = arm.oy + (a.x * sin + a.y * cos) * arm.scale
      const bx = arm.ox + (b.x * cos - b.y * sin) * arm.scale
      const by = arm.oy + (b.x * sin + b.y * cos) * arm.scale

      drawSpiralBand(ctx, {
        x1: ax,
        y1: ay,
        x2: bx,
        y2: by,
        w1: a.width * arm.scale,
        w2: b.width * arm.scale,
        a1: a.angle + arm.rot,
        a2: b.angle + arm.rot,
        hue: arm.hue,
        t: a.t,
        depth: arm.depth,
      })
    }
  }
}
