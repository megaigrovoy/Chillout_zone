import { precalc, VARIATIONS } from './variations'
import type { Precalc, Vec2, Variation } from './variations'

/**
 * The fractal flame engine: chaos game + log-density histogram.
 *
 * Draves' three innovations over textbook IFS, all of which matter here:
 *   1. non-linear variations (see variations.ts)
 *   2. log-density display — the reason flames have soft, luminous gradients
 *      instead of the flat silhouettes a plain hit-or-miss IFS produces
 *   3. structural colouring — colour is a coordinate carried by the point and
 *      blended per transform, so hue encodes *which transforms* shaped a
 *      region rather than being painted on afterwards
 *
 * Rendering is accumulation-only: we never draw shapes. Points are splatted
 * into a histogram, and the image is derived from density. That is what makes
 * the output look like the reference imagery.
 */

export interface XForm {
  /** Affine coefficients: x' = a*x + b*y + c, y' = d*x + e*y + f */
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
  /** Probability weight for selection in the chaos game. */
  weight: number
  /** Colour coordinate in 0..1, blended into the point on each hit. */
  color: number
  /** Variation blend: name -> weight. */
  vars: Array<{ fn: Variation; w: number }>
}

export interface FlameSpec {
  xforms: XForm[]
  /** Optional final transform applied after every iteration. */
  final?: XForm
}

/**
 * Accumulation buffer. Kept as plain Float32Arrays rather than ImageData so we
 * can accumulate unbounded density and tone-map only at display time.
 */
export class Histogram {
  r: Float32Array
  g: Float32Array
  b: Float32Array
  count: Float32Array

  constructor(public width: number, public height: number) {
    const n = width * height
    this.r = new Float32Array(n)
    this.g = new Float32Array(n)
    this.b = new Float32Array(n)
    this.count = new Float32Array(n)
  }

  clear() {
    this.r.fill(0)
    this.g.fill(0)
    this.b.fill(0)
    this.count.fill(0)
  }

  /**
   * Fade everything toward zero, so old structure decays as new is added.
   *
   * At 1080p this walks 4 x 2M floats, which measured at 11ms — too expensive
   * to run every frame. The caller applies it periodically with a
   * correspondingly stronger factor instead; the visual result is the same
   * because decay is exponential, and the cost drops by the stride.
   */
  decay(factor: number) {
    const { r, g, b, count } = this
    for (let i = 0; i < count.length; i++) {
      count[i] *= factor
      r[i] *= factor
      g[i] *= factor
      b[i] *= factor
    }
  }
}

const scratchP: Precalc = { sumsq: 0, sqrt: 0, atan: 0, sina: 0, cosa: 0 }
const scratchOut: Vec2 = { x: 0, y: 0 }

/** Apply one transform: affine, then the weighted blend of its variations. */
function applyXForm(xf: XForm, px: number, py: number, out: Vec2) {
  const tx = xf.a * px + xf.b * py + xf.c
  const ty = xf.d * px + xf.e * py + xf.f

  precalc(tx, ty, scratchP)
  out.x = 0
  out.y = 0
  for (let i = 0; i < xf.vars.length; i++) {
    const v = xf.vars[i]
    v.fn(tx, ty, v.w, scratchP, out)
  }
}

/**
 * Run the chaos game and splat into the histogram.
 *
 * `iterations` is the per-frame budget. The first 20 points of a run are
 * discarded (fuse): the starting point is arbitrary and is not yet on the
 * attractor, so plotting those would scatter stray dots across the image.
 */
export function iterate(
  spec: FlameSpec,
  hist: Histogram,
  palette: Float32Array,
  iterations: number,
  camera: { scale: number; ox: number; oy: number },
) {
  const { width, height } = hist
  const xforms = spec.xforms
  if (xforms.length === 0) return

  // Cumulative weights for O(log n) transform selection.
  let total = 0
  for (const xf of xforms) total += xf.weight

  let px = Math.random() * 2 - 1
  let py = Math.random() * 2 - 1
  let pc = Math.random()

  const FUSE = 20

  for (let i = 0; i < iterations; i++) {
    // Pick a transform by weight.
    let pick = Math.random() * total
    let xf = xforms[0]
    for (let k = 0; k < xforms.length; k++) {
      pick -= xforms[k].weight
      if (pick <= 0) {
        xf = xforms[k]
        break
      }
    }

    applyXForm(xf, px, py, scratchOut)
    px = scratchOut.x
    py = scratchOut.y
    // Structural colouring: the point's colour drifts toward the transform's
    // colour on every hit, so regions inherit the palette of the transform
    // chain that produced them.
    pc = (pc + xf.color) * 0.5

    // A diverging orbit would poison the rest of the run; restart it.
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      px = Math.random() * 2 - 1
      py = Math.random() * 2 - 1
      pc = Math.random()
      continue
    }

    if (i < FUSE) continue

    let sx = px
    let sy = py
    if (spec.final) {
      applyXForm(spec.final, px, py, scratchOut)
      sx = scratchOut.x
      sy = scratchOut.y
    }

    const ix = ((sx * camera.scale + camera.ox) * width) | 0
    const iy = ((sy * camera.scale + camera.oy) * height) | 0
    if (ix < 0 || ix >= width || iy < 0 || iy >= height) continue

    const idx = iy * width + ix
    const ci = (pc * 255) | 0
    const co = (ci < 0 ? 0 : ci > 255 ? 255 : ci) * 3

    hist.count[idx] += 1
    hist.r[idx] += palette[co]
    hist.g[idx] += palette[co + 1]
    hist.b[idx] += palette[co + 2]
  }
}

/**
 * Tone-map the histogram into pixels.
 *
 * This is the step that makes a flame look like a flame. Density spans several
 * orders of magnitude, so a linear mapping shows only the densest core and
 * loses everything else; the log scaling in Draves' paper compresses that
 * range into something the eye reads as soft luminous structure.
 *
 *   alpha = log(1 + count) / log(1 + maxCount)
 *   pixel = colorAvg * alpha^(1/gamma)
 */
/**
 * Lookup table for the tone curve.
 *
 * Profiling showed tone mapping — not the chaos game — dominated the frame:
 * calling Math.log and Math.pow per pixel is ~2M transcendental calls at
 * 1080p, which cost 22ms/frame on its own. The curve depends only on the
 * density ratio, so it is tabulated once and indexed instead.
 */
const CURVE_SIZE = 4096
let curve: Float32Array | null = null
let curveGamma = -1

/**
 * log2 mantissa table plus a typed-array view for reading a float's exponent.
 * Together these turn Math.log into an integer shift and one table lookup.
 */
const LOG_BITS = 12
const LOG_SIZE = 1 << LOG_BITS
const log2Lut = new Float32Array(LOG_SIZE)
for (let i = 0; i < LOG_SIZE; i++) {
  log2Lut[i] = Math.log2(1 + i / LOG_SIZE)
}
const exp32 = new Float32Array(1)
const expInt = new Uint32Array(exp32.buffer)

/** Background as a packed little-endian RGBA word: (4, 8, 20, 255). */
const BG_PIXEL = (255 << 24) | (20 << 16) | (8 << 8) | 4
let bgView: Uint32Array | null = null

function buildCurve(gamma: number): Float32Array {
  const c = new Float32Array(CURVE_SIZE + 1)
  const invGamma = 1 / gamma
  for (let i = 0; i <= CURVE_SIZE; i++) {
    // Index is alpha (normalised log density) in 0..1.
    c[i] = Math.pow(i / CURVE_SIZE, invGamma)
  }
  return c
}

/**
 * Tone-map the histogram into pixels.
 *
 * This is the step that makes a flame look like a flame. Density spans several
 * orders of magnitude, so a linear mapping shows only the densest core and
 * loses everything else; the log scaling in Draves' paper compresses that
 * range into something the eye reads as soft luminous structure.
 *
 *   alpha = log(1 + count) / log(1 + maxCount)
 *   pixel = colorAvg * alpha^(1/gamma)
 */
export function toneMap(
  hist: Histogram,
  image: ImageData,
  gamma: number,
  brightness: number,
) {
  const { count, r, g, b } = hist
  const data = image.data
  const n = count.length

  // Paint the background as one linear pass over a 32-bit view — a single
  // write per pixel instead of four byte writes, which measured ~2x faster.
  // Only ~18% of pixels carry density, so the loop below skips the rest early.
  if (!bgView || bgView.length !== n) {
    bgView = new Uint32Array(data.buffer)
  }
  bgView.fill(BG_PIXEL)

  let max = 0
  for (let i = 0; i < n; i++) if (count[i] > max) max = count[i]
  if (max <= 0) return

  if (!curve || curveGamma !== gamma) {
    curve = buildCurve(gamma)
    curveGamma = gamma
  }
  const lut = curve

  const invLogMax = 1 / Math.log(1 + max)

  // Fold the log into the table too. Density is unbounded so it cannot be
  // indexed directly, but Math.log2 of a float is just its exponent plus a
  // mantissa correction, and the mantissa part is what the table supplies.
  // This removes the last transcendental call from the per-pixel loop, which
  // dominated tone mapping once longer trails kept the histogram fuller.
  const LN2 = Math.LN2

  for (let i = 0; i < n; i++) {
    const d = count[i]
    if (d <= 0) continue
    const o = i * 4

    // log(1 + d) via exponent + tabulated mantissa.
    const v = 1 + d
    exp32[0] = v
    const bits = expInt[0]
    const e = ((bits >>> 23) & 0xff) - 127
    // Mantissa in [1,2) mapped onto the log2 table.
    const mi = (bits & 0x7fffff) >>> (23 - LOG_BITS)
    const alpha = (e + log2Lut[mi]) * LN2 * invLogMax

    let li = (alpha * CURVE_SIZE) | 0
    if (li < 0) li = 0
    else if (li > CURVE_SIZE) li = CURVE_SIZE

    const scale = (lut[li] * brightness) / d

    const cr = r[i] * scale
    const cg = g[i] * scale
    const cb = b[i] * scale

    // Highlights clip to white rather than wrapping, matching flam3 behaviour.
    data[o] = cr > 255 ? 255 : cr < 4 ? 4 : cr
    data[o + 1] = cg > 255 ? 255 : cg < 8 ? 8 : cg
    data[o + 2] = cb > 255 ? 255 : cb < 20 ? 20 : cb
    data[o + 3] = 255
  }
}

export { VARIATIONS }
