/**
 * Deterministic self-similar spiral generator.
 *
 * The organic grower this replaces produced a bush, not a fractal: every
 * branch got randomised curl, field deflection and random child multipliers,
 * so no two parts of the form were ever the same shape. What makes the
 * reference image read as *fractal* is exact self-similarity — a small curl on
 * the rim of a large one is the same curve at a smaller scale, not a similar
 * one.
 *
 * So the structure here is an IFS: a fixed set of similarity transforms
 * (rotate + scale + translate) applied recursively. Every parameter that
 * varies does so per *emission*, never per node, which is what preserves
 * self-similarity within a single form while still letting the hand shape it.
 */

/** One point along a spiral arm's spine, in local (unit) space. */
export interface SpinePoint {
  x: number
  y: number
  /** Tangent direction, radians. */
  angle: number
  /** Local half-width multiplier at this point. */
  width: number
  /** 0..1 position along the arm, for shading. */
  t: number
}

export interface IfsSpec {
  /** Turns the spiral makes from core to rim. */
  turns: number
  /**
   * Logarithmic growth rate: radius multiplies by e^(b * theta). This single
   * number sets the "openness" of the spiral and is shared by every level, so
   * a child arm traces the identical curve at a smaller size.
   */
  b: number
  /** Child arms spawned per parent. */
  branches: number
  /** Uniform scale factor applied at each recursion level. */
  ratio: number
  /** Angular offset of child arms relative to the parent's rim tangent. */
  branchAngle: number
  /** How many levels deep to recurse. */
  depth: number
  /** Base half-width of a level-0 arm, px. */
  width: number
  /** Overall size of the level-0 arm, px. */
  scale: number
  hue: number
}

/**
 * Sample a logarithmic spiral arm.
 *
 * Points are spaced by angle rather than arc length: the curve is dense where
 * it coils tightly at the core and opens out toward the rim, which is exactly
 * the density distribution the reference image shows.
 */
export function spiralSpine(spec: IfsSpec, steps: number): SpinePoint[] {
  const pts: SpinePoint[] = []
  const total = spec.turns * Math.PI * 2

  // Normalise so the arm always ends at `scale` regardless of turns/b.
  const rEnd = Math.exp(spec.b * total)

  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const theta = t * total
    const r = (Math.exp(spec.b * theta) / rEnd) * spec.scale

    const x = Math.cos(theta) * r
    const y = Math.sin(theta) * r

    // Tangent of a log spiral: the angle between radius and tangent is
    // constant (that is what makes it equiangular), so this is exact.
    const angle = theta + Math.atan2(1, spec.b)

    // The arm is thickest at the rim and vanishes into the core, matching the
    // way the reference's bands emerge from a dark centre.
    pts.push({ x, y, angle, width: spec.width * (0.15 + t * 0.85), t })
  }

  return pts
}

/**
 * Where child arms attach along the parent, as fractions of arc position.
 *
 * Spacing them evenly over the outer half concentrates the lace on the rim —
 * the parent's core is already dense, and clusters there would just smear.
 */
export function attachPoints(count: number): number[] {
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    out.push(0.45 + (i / Math.max(count - 1, 1)) * 0.55)
  }
  return out
}
