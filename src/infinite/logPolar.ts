/**
 * Log-polar machinery shared by the three infinite-zoom modes.
 *
 * The whole family rests on one identity: in log-polar coordinates
 *
 *   rho = log(hypot(x, y)),  theta = atan2(y, x)
 *
 * multiplication becomes addition. So *uniform tiling along rho* — an ordinary
 * modulo — comes back as *exponential scaling* in ordinary space: shells inside
 * shells, each larger than the last by a constant ratio, repeating forever.
 * Adding time to rho makes the whole structure grow outward without ever
 * changing statistically, which is what "infinitely growing repeating pattern"
 * actually means.
 *
 * See osar.fr/notes/logspherical and roy.red/posts/droste for the derivations.
 */

export interface LogPolar {
  rho: number
  theta: number
}

/** Forward transform. `out` is written in place to avoid per-pixel garbage. */
export function toLogPolar(x: number, y: number, out: LogPolar): LogPolar {
  // Guarded: log(0) is -Infinity, and the origin is exactly the point every
  // zoom converges on, so it is hit constantly rather than rarely.
  const r = Math.hypot(x, y)
  out.rho = Math.log(Math.max(r, 1e-6))
  out.theta = Math.atan2(y, x)
  return out
}

/** Inverse transform. */
export function fromLogPolar(rho: number, theta: number, out: { x: number; y: number }) {
  const r = Math.exp(rho)
  out.x = Math.cos(theta) * r
  out.y = Math.sin(theta) * r
  return out
}

/**
 * Scale ratio between neighbouring shells for a given tile width in log space.
 *
 * This is the number that decides how the pattern reads: a small ratio nests
 * many similar shells close together, a large one gives a few dramatic jumps.
 */
export const shellRatio = (tileWidth: number) => Math.exp(tileWidth)

/**
 * Wrap a value into [0, size), correctly for negatives.
 *
 * A plain `%` returns a negative remainder for negative input, which would
 * tear the pattern along the seam where rho crosses zero — and rho is negative
 * for everything inside the unit circle, i.e. the entire centre of the screen.
 */
export function wrap(v: number, size: number): number {
  const m = v % size
  return m < 0 ? m + size : m
}

/**
 * Twist factor for the Droste spiral.
 *
 * The straight Droste effect tiles log-space on an axis-aligned grid; the
 * spiral version shears that grid so a full 2*PI turn also advances exactly one
 * tile. `strength` 0 gives concentric rings, 1 gives the classic twist.
 */
export function drosteShear(tileWidth: number, strength: number): number {
  return (tileWidth / (Math.PI * 2)) * strength
}
