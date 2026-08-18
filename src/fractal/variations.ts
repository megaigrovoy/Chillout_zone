/**
 * Fractal flame variations, transcribed from Scott Draves' flam3 reference
 * implementation (variations.c) and "The Fractal Flame Algorithm" (2003).
 *
 * These are the real published formulas, not approximations. The hand-rolled
 * spiral generator this replaces produced polygonal curls that did not read as
 * fractal at all; flames are what actually generates the imagery people
 * recognise from Apophysis.
 *
 * Each variation maps an affine-transformed point to a new point. They are
 * blended by weight inside a transform, which is where the visual richness
 * comes from — a single variation alone is rarely interesting.
 */

const EPS = 1e-10

export interface Vec2 {
  x: number
  y: number
}

/**
 * Precomputed per-point quantities shared by the variations, matching flam3's
 * `precalc_*` fields. Computing these once per transform application rather
 * than per variation matters: the chaos game runs tens of thousands of
 * iterations per frame.
 */
export interface Precalc {
  sumsq: number
  sqrt: number
  atan: number
  sina: number
  cosa: number
}

export function precalc(x: number, y: number, out: Precalc): Precalc {
  out.sumsq = x * x + y * y
  out.sqrt = Math.sqrt(out.sumsq)
  // Note the argument order: flam3 uses atan2(x, y), not atan2(y, x).
  out.atan = Math.atan2(x, y)
  const r = out.sqrt + EPS
  out.sina = x / r
  out.cosa = y / r
  return out
}

export type Variation = (
  x: number,
  y: number,
  w: number,
  p: Precalc,
  out: Vec2,
) => void

/** V0 linear */
export const linear: Variation = (x, y, w, _p, out) => {
  out.x += w * x
  out.y += w * y
}

/** V1 sinusoidal */
export const sinusoidal: Variation = (x, y, w, _p, out) => {
  out.x += w * Math.sin(x)
  out.y += w * Math.sin(y)
}

/** V2 spherical — inverts the plane through the unit circle */
export const spherical: Variation = (x, y, w, p, out) => {
  const r2 = w / (p.sumsq + EPS)
  out.x += r2 * x
  out.y += r2 * y
}

/** V3 swirl — rotates by an amount that grows with radius */
export const swirl: Variation = (x, y, w, p, out) => {
  const r2 = p.sumsq
  const c1 = Math.sin(r2)
  const c2 = Math.cos(r2)
  out.x += w * (c1 * x - c2 * y)
  out.y += w * (c2 * x + c1 * y)
}

/** V4 horseshoe */
export const horseshoe: Variation = (x, y, w, p, out) => {
  const r = w / (p.sqrt + EPS)
  out.x += (x - y) * (x + y) * r
  out.y += 2 * x * y * r
}

/** V5 polar */
export const polar: Variation = (_x, _y, w, p, out) => {
  out.x += w * (p.atan / Math.PI)
  out.y += w * (p.sqrt - 1)
}

/** V6 handkerchief */
export const handkerchief: Variation = (_x, _y, w, p, out) => {
  const a = p.atan
  const r = p.sqrt
  out.x += w * r * Math.sin(a + r)
  out.y += w * r * Math.cos(a - r)
}

/** V7 heart */
export const heart: Variation = (_x, _y, w, p, out) => {
  const a = p.sqrt * p.atan
  const r = w * p.sqrt
  out.x += r * Math.sin(a)
  out.y += -r * Math.cos(a)
}

/** V8 disc — wraps the plane into concentric rings */
export const disc: Variation = (_x, _y, w, p, out) => {
  const a = p.atan / Math.PI
  const r = Math.PI * p.sqrt
  out.x += w * Math.sin(r) * a
  out.y += w * Math.cos(r) * a
}

/** V9 spiral */
export const spiral: Variation = (_x, _y, w, p, out) => {
  const r = p.sqrt + EPS
  const r1 = w / r
  out.x += r1 * (p.cosa + Math.sin(r))
  out.y += r1 * (p.sina - Math.cos(r))
}

/** V10 hyperbolic */
export const hyperbolic: Variation = (_x, _y, w, p, out) => {
  const r = p.sqrt + EPS
  out.x += (w * p.sina) / r
  out.y += w * p.cosa * r
}

/** V11 diamond */
export const diamond: Variation = (_x, _y, w, p, out) => {
  const r = p.sqrt
  out.x += w * p.sina * Math.cos(r)
  out.y += w * p.cosa * Math.sin(r)
}

/**
 * V13 julia — the variation behind the classic "grand julian" spirals, and
 * the closest single formula to the reference imagery. The random branch is
 * essential: it picks one of the two square roots, and without it the figure
 * collapses to half of itself.
 */
export const julia: Variation = (_x, _y, w, p, out) => {
  let a = 0.5 * p.atan
  if (Math.random() < 0.5) a += Math.PI
  const r = w * Math.sqrt(p.sqrt)
  out.x += r * Math.cos(a)
  out.y += r * Math.sin(a)
}

/** V18 exponential */
export const exponential: Variation = (x, y, w, _p, out) => {
  const dx = w * Math.exp(x - 1)
  const dy = Math.PI * y
  out.x += dx * Math.cos(dy)
  out.y += dx * Math.sin(dy)
}

/** V19 power */
export const power: Variation = (_x, _y, w, p, out) => {
  const r = w * Math.pow(p.sqrt, p.sina)
  out.x += r * p.cosa
  out.y += r * p.sina
}

/** V27 eyefish */
export const eyefish: Variation = (x, y, w, p, out) => {
  const r = (w * 2) / (p.sqrt + 1)
  out.x += r * x
  out.y += r * y
}

/** V28 bubble */
export const bubble: Variation = (x, y, w, p, out) => {
  const r = w / (0.25 * p.sumsq + 1)
  out.x += r * x
  out.y += r * y
}

export const VARIATIONS: Record<string, Variation> = {
  linear,
  sinusoidal,
  spherical,
  swirl,
  horseshoe,
  polar,
  handkerchief,
  heart,
  disc,
  spiral,
  hyperbolic,
  diamond,
  julia,
  exponential,
  power,
  eyefish,
  bubble,
}
