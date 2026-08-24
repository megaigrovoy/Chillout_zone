import { drosteShear, toLogPolar, wrap } from './logPolar'
import type { LogPolar } from './logPolar'
import type { HandState } from '../tracking/types'

/**
 * The three infinite-zoom modes.
 *
 * All three are per-pixel field evaluations rather than drawn shapes, so they
 * share one renderer and differ only in the function applied once the pixel has
 * been mapped into log-polar space:
 *
 *   logpolar — tile rho directly: nested shells growing outward forever
 *   droste   — shear the tiling so one full turn advances one tile: a seamless
 *              spiral that loops onto itself
 *   kifs     — fold the plane repeatedly, giving kaleidoscopic detail that
 *              refines without bound
 */
export type InfiniteVariant = 'logpolar' | 'droste' | 'kifs'

/**
 * Working resolution.
 *
 * Every pixel costs a log, a handful of trig calls and (for KIFS) an inner
 * loop, so full-screen evaluation is far past the frame budget. The output is
 * smooth, continuous-tone imagery with no hard edges, which upscales without
 * anyone noticing — the same trade the flame renderer makes.
 */
const BUFFER_W = 360
const BUFFER_H = 202

/**
 * Iterations of the fold for the KIFS variant.
 *
 * Each iteration doubles the structure, so detail saturates well before the
 * buffer can resolve it; measured at 12 the fold loop dominated the frame, and
 * 9 is visually indistinguishable at this resolution.
 */
const KIFS_ITERATIONS = 9

export class InfiniteRenderer {
  private buf: HTMLCanvasElement
  private bufCtx: CanvasRenderingContext2D
  private image: ImageData
  private lp: LogPolar = { rho: 0, theta: 0 }
  private time = 0

  /** Eased control values, so tracking jitter does not shake the whole field. */
  private zoom = 0
  private tileWidth = 0.9
  private twist = 0.5
  private centerX = 0.5
  private centerY = 0.5
  private hue = 0.55
  private energy = 0

  constructor(
    private width: number,
    private height: number,
    private variant: InfiniteVariant,
  ) {
    this.buf = document.createElement('canvas')
    this.buf.width = BUFFER_W
    this.buf.height = BUFFER_H
    const c = this.buf.getContext('2d')
    if (!c) throw new Error('2D context unavailable for infinite buffer')
    this.bufCtx = c
    this.image = c.createImageData(BUFFER_W, BUFFER_H)
  }

  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  reset() {
    this.time = 0
    this.zoom = 0
  }

  /** Surfaced in the debug HUD. */
  get depth() {
    return this.zoom
  }

  render(ctx: CanvasRenderingContext2D, hands: HandState[], dt: number) {
    this.time += dt
    this.applyHands(hands, dt)

    // Zoom advances continuously: this is the "infinitely growing" part. It is
    // never reset and never wraps here — the pattern's own periodicity in log
    // space makes any value equivalent to one inside a single tile, so the
    // number growing without bound costs nothing.
    this.zoom += dt * (0.16 + this.energy * 0.5)

    this.paint()

    ctx.imageSmoothingEnabled = true
    ctx.drawImage(this.buf, 0, 0, this.width, this.height)
  }

  /**
   * Hands steer the field.
   *
   * Everything is eased rather than applied directly: this is a full-screen
   * field, so unsmoothed tracking noise would make the entire image shudder,
   * far more visibly than it does on a small overlay.
   */
  private applyHands(hands: HandState[], dt: number) {
    const k = Math.min(1, dt * 3)

    if (hands.length === 0) {
      // Drift home slowly so an empty frame settles rather than freezing
      // wherever the last hand left it.
      this.tileWidth += (0.9 - this.tileWidth) * k * 0.5
      this.twist += (0.5 - this.twist) * k * 0.5
      this.centerX += (0.5 - this.centerX) * k * 0.5
      this.centerY += (0.5 - this.centerY) * k * 0.5
      this.energy += (0 - this.energy) * k
      return
    }

    const primary = hands[0]
    const speed = hands.reduce((m, h) => Math.max(m, Math.hypot(h.velocity.x, h.velocity.y)), 0)

    // The hand is the zoom centre — the point everything grows out of.
    const tx = 1 - primary.center.x
    const ty = primary.center.y
    this.centerX += (tx - this.centerX) * k
    this.centerY += (ty - this.centerY) * k

    // Openness sets how tightly the shells nest: a fist packs many small
    // repetitions, an open hand gives a few large ones.
    const targetTile = 0.45 + primary.openness * 1.5
    this.tileWidth += (targetTile - this.tileWidth) * k

    // Wrist rotation twists the spiral.
    const targetTwist = 0.5 + Math.sin(primary.rotation) * 0.85
    this.twist += (targetTwist - this.twist) * k

    // A second hand shifts the palette, so two hands are not redundant.
    const targetHue =
      hands.length > 1 ? 0.35 + (1 - hands[1].center.x) * 0.5 : 0.55 + primary.center.y * 0.25
    this.hue += (targetHue - this.hue) * k

    this.energy += (Math.min(1, speed * 1.6) - this.energy) * k
  }

  /** Evaluate the field for every pixel of the working buffer. */
  private paint() {
    const data = this.image.data
    const cx = this.centerX * BUFFER_W
    const cy = this.centerY * BUFFER_H
    // Aspect correction, or the shells come out elliptical.
    const aspect = this.width / this.height
    const scale = 2.4 / BUFFER_H

    const tile = this.tileWidth
    const shear = drosteShear(tile, this.twist)

    let p = 0
    for (let py = 0; py < BUFFER_H; py++) {
      const y = (py - cy) * scale
      for (let px = 0; px < BUFFER_W; px++) {
        const x = (px - cx) * scale * aspect

        toLogPolar(x, y, this.lp)
        let rho = this.lp.rho
        const theta = this.lp.theta

        // The zoom lives here: subtracting time from rho slides the whole
        // pattern outward through the tiling, so shells emerge from the centre
        // and expand away indefinitely.
        rho -= this.zoom

        let v: number
        switch (this.variant) {
          case 'droste': {
            // Shearing the tiling by theta makes one full turn advance exactly
            // `twist` tiles, which is what closes the spiral seamlessly.
            const sheared = rho - theta * shear
            const cell = wrap(sheared, tile) / tile
            v = drosteField(cell, theta, sheared / tile)
            break
          }
          case 'kifs': {
            const cell = wrap(rho, tile) / tile
            v = kifsField(x, y, cell, this.time)
            break
          }
          default: {
            const cell = wrap(rho, tile) / tile
            v = shellField(cell, theta, rho / tile)
          }
        }

        writePixel(data, p, v, this.hue, this.energy)
        p += 4
      }
    }

    this.bufCtx.putImageData(this.image, 0, 0)
  }
}

/**
 * Concentric shells: the plain log-polar variant.
 *
 * `cell` is the position within one tile, so anything built from it repeats
 * identically at every scale. The angular term adds ribs so the shells read as
 * structure rather than as flat rings.
 */
function shellField(cell: number, theta: number, index: number): number {
  // Soft band across the tile, so shells have thickness and blend rather than
  // showing a hard boundary where the modulo wraps.
  const band = Math.sin(cell * Math.PI)
  const ribs = 0.5 + 0.5 * Math.sin(theta * 6 + index * 2.4)
  const fine = 0.5 + 0.5 * Math.sin(theta * 18 - index * 3.1)
  return band * band * (0.45 + ribs * 0.4 + fine * 0.15)
}

/**
 * Droste spiral.
 *
 * Because the tiling is sheared, following a ring around the centre also walks
 * through the tiles — so the pattern joins onto itself and the zoom loops with
 * no visible seam.
 */
function drosteField(cell: number, theta: number, index: number): number {
  const band = Math.sin(cell * Math.PI)
  // Arms along the spiral rather than radial ribs: they follow the shear.
  const arms = 0.5 + 0.5 * Math.sin(theta * 3 + index * Math.PI * 2)
  const detail = 0.5 + 0.5 * Math.sin(theta * 12 + index * 6.2)
  return band * band * (0.35 + arms * 0.5 + detail * 0.15)
}

/**
 * Kaleidoscopic IFS.
 *
 * Space is folded repeatedly — reflect, scale, offset — which manufactures
 * unbounded detail from a few operations. Each fold doubles the structure, so
 * twelve iterations is already far more detail than the buffer can resolve.
 */
function kifsField(x: number, y: number, cell: number, time: number): number {
  // Work in the tile's local frame so the fold repeats per shell, which is what
  // ties the KIFS detail to the same infinite log-polar scaffold.
  const s = Math.exp(cell * 1.4)
  let zx = x * s * 2.2
  let zy = y * s * 2.2

  const angle = 0.6 + Math.sin(time * 0.11) * 0.25
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)

  const scale = 1.62
  let dist = 1

  for (let i = 0; i < KIFS_ITERATIONS; i++) {
    // Absolute-value folds: the reflections that make the kaleidoscope.
    zx = Math.abs(zx)
    zy = Math.abs(zy)
    if (zx - zy < 0) {
      const t = zx
      zx = zy
      zy = t
    }

    // Rotate, scale, translate — the IFS proper.
    const rx = zx * ca - zy * sa
    const ry = zx * sa + zy * ca
    zx = rx * scale - 0.7
    zy = ry * scale - 0.28

    dist *= scale
  }

  // The distance estimate: length(z) / scale^n, the standard KIFS DE.
  const d = Math.hypot(zx, zy) / dist
  // Map to a band; the exponent sharpens the filaments.
  return Math.pow(Math.max(0, 1 - d * 5.5), 2.2)
}

/**
 * Write one pixel.
 *
 * Colour comes from a cosine palette, the same formulation the flame mode uses,
 * so the modes look like they belong to one piece of software.
 */
function writePixel(
  data: Uint8ClampedArray,
  p: number,
  v: number,
  hue: number,
  energy: number,
) {
  const t = hue + v * 0.35
  const boost = 0.75 + energy * 0.5
  const i = v * boost

  const r = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (t + 0.0))
  const g = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (t + 0.22))
  const b = 0.5 + 0.5 * Math.cos(Math.PI * 2 * (t + 0.45))

  data[p] = Math.min(255, r * i * 210 + 4)
  data[p + 1] = Math.min(255, g * i * 235 + 9)
  data[p + 2] = Math.min(255, b * i * 255 + 22)
  data[p + 3] = 255
}
