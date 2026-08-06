import type { HandState, TrackingFrame } from '../tracking/types'

/**
 * The full parameter set that defines one frame of the fractal. Hands write
 * into a target set; the renderer eases toward it so the visuals stay smooth
 * even when tracking is jittery or briefly drops out.
 */
export interface FractalParams {
  /** Growth budget multiplier — how far a lineage travels before dying. */
  depth: number
  /** Child branches per split. */
  branches: number
  /** Angular spread between sibling branches, radians. */
  spread: number
  /** Inverse branching frequency: low splits often, high runs long and sparse. */
  ratio: number
  /** Whole-form rotation, radians. */
  rotation: number
  /** Base hue, degrees. */
  hue: number
  /** Trunk length as a fraction of the smaller viewport dimension. */
  length: number
  /** Twist applied per depth level — turns symmetric trees into spirals. */
  twist: number
  /** 0..1 overall energy; drives glow and stroke weight. */
  energy: number
}

export const DEFAULT_PARAMS: FractalParams = {
  depth: 7,
  branches: 2,
  spread: 0.6,
  ratio: 0.72,
  rotation: 0,
  hue: 190,
  length: 0.17,
  twist: 0,
  energy: 0.25,
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Map the tracked hands onto fractal parameters.
 *
 * The mapping is deliberately split by hand so two-handed play feels like two
 * distinct controls rather than one averaged blob:
 *   left hand  -> form (spread, branch count, twist)
 *   right hand -> growth (depth, reach, rotation)
 * With one hand visible it drives both, so single-hand play still reaches the
 * whole parameter space.
 */
export function paramsFromFrame(frame: TrackingFrame): FractalParams {
  const { hands } = frame
  if (hands.length === 0) return DEFAULT_PARAMS

  const left = hands.find((h) => h.handedness === 'Left') ?? hands[0]
  const right = hands.find((h) => h.handedness === 'Right') ?? hands[0]

  const speed = hands.reduce((m, h) => Math.max(m, Math.hypot(h.velocity.x, h.velocity.y)), 0)

  return {
    // An open left hand splays new branches wide; a fist keeps them in a
    // tight bundle that reads as a single directed stream.
    spread: lerp(0.15, 1.1, left.openness),
    branches: Math.round(lerp(2, 4, left.openness)),
    twist: lerp(-0.4, 0.4, normalizeRotation(left.rotation)),

    // Right hand height controls how long a lineage survives before its
    // energy runs out — reach up and the growth travels much further.
    depth: lerp(3, 9, 1 - right.center.y),
    // Ratio now sets how often a growing tip splits rather than a length
    // falloff: low ratio branches densely, high ratio runs long and sparse.
    ratio: lerp(0.35, 0.9, right.openness),
    rotation: right.rotation,

    // Proximity to the camera scales the reach of each emission.
    length: clamp(lerp(0.10, 0.26, right.scale / 0.22), 0.08, 0.3),

    // Horizontal position tints the ambient palette (per-hand hues are set in
    // the field); motion adds energy, which drives speed, glow and decay.
    // Kept inside the blue..violet band so the form stays in the cool palette
    // of the reference rather than sweeping the whole colour wheel.
    hue: 190 + left.center.x * 110,
    energy: clamp(0.2 + speed * 0.5, 0, 1),
  }
}

/** Map a -PI..PI rotation into 0..1, with a flat palm sitting mid-range. */
function normalizeRotation(r: number): number {
  return clamp((r + Math.PI) / (2 * Math.PI), 0, 1)
}

/**
 * Ease current params toward target. `rate` is per-second so the feel stays
 * identical whether the machine renders at 30 or 144fps.
 */
export function easeParams(
  current: FractalParams,
  target: FractalParams,
  dt: number,
  rate = 6,
): FractalParams {
  const t = 1 - Math.exp(-rate * dt)
  return {
    depth: lerp(current.depth, target.depth, t),
    branches: lerp(current.branches, target.branches, t),
    spread: lerp(current.spread, target.spread, t),
    ratio: lerp(current.ratio, target.ratio, t),
    rotation: lerpAngle(current.rotation, target.rotation, t),
    hue: lerpAngle360(current.hue, target.hue, t),
    length: lerp(current.length, target.length, t),
    twist: lerp(current.twist, target.twist, t),
    energy: lerp(current.energy, target.energy, t),
  }
}

/** Angular lerp that takes the short way around, avoiding a spin at the seam. */
function lerpAngle(a: number, b: number, t: number): number {
  const diff = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI
  return a + (diff < -Math.PI ? diff + Math.PI * 2 : diff) * t
}

function lerpAngle360(a: number, b: number, t: number): number {
  const diff = ((b - a + 180) % 360) - 180
  return a + (diff < -180 ? diff + 360 : diff) * t
}

export type { HandState }
