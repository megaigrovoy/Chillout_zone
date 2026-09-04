/**
 * Metaball field and contour extraction.
 *
 * Drawing each droplet as its own blob makes a crowd of circles: the eye reads
 * the individual dots, not a substance. Metaballs invert that — every droplet
 * contributes to one scalar field, and the surface is wherever that field
 * crosses a threshold. Two droplets close together produce a single smooth
 * outline that bulges and necks between them, which is exactly how thick liquid
 * behaves, and it means far fewer droplets are needed since the body comes from
 * the field rather than from sheer count.
 *
 * The field is sampled on a coarse grid and contoured with marching squares.
 * Sampling per screen pixel would be far past the frame budget, and the coarse
 * grid costs nothing visually — the surface is smooth by construction, so
 * interpolating along cell edges recovers a clean curve.
 */

/**
 * Grid cell size in pixels.
 *
 * Smaller resolves finer detail in the surface at a cost quadratic in cell
 * count. With the body filled as interpolated polygons the edge is smooth at
 * any size, so this now controls how much *shape* detail survives rather than
 * how jagged the boundary looks.
 */
export const CELL = 6

/**
 * Field value defining the surface.
 *
 * Below what a single droplet contributes at its centre, deliberately. At 1.0
 * a lone droplet peaked at exactly 1.0 in the best case and 0.94 when its
 * centre fell between grid samples, so it produced no surface at all — measured
 * as zero contours for any droplet more than 20px from a neighbour. Setting the
 * threshold under that guarantees every droplet has a skin, while pairs still
 * merge because their contributions sum.
 */
const THRESHOLD = 0.55

/**
 * Influence radius of one droplet, in pixels.
 *
 * This is what sets how eagerly droplets merge: large enough that neighbours in
 * a stream fuse into one body, small enough that a droplet flung away still
 * separates instead of trailing a permanent bridge.
 */
export const INFLUENCE = 26

export class MetaballField {
  /** Scalar field, (cols+1) x (rows+1) samples. */
  private field = new Float32Array(0)
  /** Dominant hue per sample, so the contour can be coloured by what fed it. */
  private hueField = new Float32Array(0)
  private weightField = new Float32Array(0)
  private cols = 0
  private rows = 0

  constructor(width: number, height: number) {
    this.resize(width, height)
  }

  resize(width: number, height: number) {
    this.cols = Math.ceil(width / CELL) + 1
    this.rows = Math.ceil(height / CELL) + 1
    const n = (this.cols + 1) * (this.rows + 1)
    this.field = new Float32Array(n)
    this.hueField = new Float32Array(n)
    this.weightField = new Float32Array(n)
  }

  /**
   * Accumulate every droplet into the field.
   *
   * Each droplet only touches the cells within its influence radius, so this is
   * linear in droplet count rather than in grid size — scattering from the
   * particles is far cheaper than gathering at every sample, since the field is
   * empty almost everywhere.
   */
  build(x: Float32Array, y: Float32Array, hue: Float32Array, count: number) {
    this.field.fill(0)
    this.hueField.fill(0)
    this.weightField.fill(0)

    const { cols, rows } = this
    const reach = Math.ceil(INFLUENCE / CELL)
    const invR2 = 1 / (INFLUENCE * INFLUENCE)

    for (let i = 0; i < count; i++) {
      const px = x[i]
      const py = y[i]
      const h = hue[i]

      const cx = Math.round(px / CELL)
      const cy = Math.round(py / CELL)

      const x0 = Math.max(0, cx - reach)
      const x1 = Math.min(cols, cx + reach)
      const y0 = Math.max(0, cy - reach)
      const y1 = Math.min(rows, cy + reach)

      for (let gy = y0; gy <= y1; gy++) {
        const sy = gy * CELL - py
        const row = gy * (cols + 1)
        for (let gx = x0; gx <= x1; gx++) {
          const sx = gx * CELL - px
          const d2 = sx * sx + sy * sy * 1
          const t = 1 - d2 * invR2
          if (t <= 0) continue
          // Squared falloff: smooth at the rim, so the surface has no visible
          // seam where a droplet's influence ends.
          const w = t * t
          const idx = row + gx
          this.field[idx] += w
          this.hueField[idx] += h * w
          this.weightField[idx] += w
        }
      }
    }
  }

  /**
   * Trace the surface with marching squares, emitting line segments.
   *
   * Segments rather than closed loops: stitching them into ordered contours
   * would cost more than it buys, since they are stroked and filled as one
   * batched path and the renderer never needs to know which loop is which.
   */
  contour(out: number[]): number {
    const { cols, rows, field } = this
    let n = 0
    out.length = 0

    for (let gy = 0; gy < rows; gy++) {
      const row0 = gy * (cols + 1)
      const row1 = (gy + 1) * (cols + 1)
      for (let gx = 0; gx < cols; gx++) {
        const a = field[row0 + gx]
        const b = field[row0 + gx + 1]
        const c = field[row1 + gx + 1]
        const d = field[row1 + gx]

        // Corner mask: which corners are inside the surface.
        let code = 0
        if (a > THRESHOLD) code |= 1
        if (b > THRESHOLD) code |= 2
        if (c > THRESHOLD) code |= 4
        if (d > THRESHOLD) code |= 8
        if (code === 0 || code === 15) continue

        const px = gx * CELL
        const py = gy * CELL

        // Linear interpolation along each crossed edge. Without it the contour
        // would snap to cell corners and look faceted at this grid size.
        const top = px + CELL * ((THRESHOLD - a) / (b - a))
        const right = py + CELL * ((THRESHOLD - b) / (c - b))
        const bottom = px + CELL * ((THRESHOLD - d) / (c - d))
        const left = py + CELL * ((THRESHOLD - a) / (d - a))

        // Marching-squares cases. 5 and 10 are the ambiguous saddles; both
        // resolutions are visually equivalent here, so one is picked
        // arbitrarily rather than sampling the centre to disambiguate.
        switch (code) {
          case 1: case 14: n = push(out, n, top, py, px, left); break
          case 2: case 13: n = push(out, n, top, py, px + CELL, right); break
          case 3: case 12: n = push(out, n, px, left, px + CELL, right); break
          case 4: case 11: n = push(out, n, px + CELL, right, bottom, py + CELL); break
          case 6: case 9: n = push(out, n, top, py, bottom, py + CELL); break
          case 7: case 8: n = push(out, n, px, left, bottom, py + CELL); break
          case 5:
            n = push(out, n, top, py, px, left)
            n = push(out, n, px + CELL, right, bottom, py + CELL)
            break
          case 10:
            n = push(out, n, top, py, px + CELL, right)
            n = push(out, n, px, left, bottom, py + CELL)
            break
        }
      }
    }

    return n
  }

  /** Mean hue at a point, for tinting the surface by what produced it. */
  hueAt(px: number, py: number): number {
    const gx = Math.max(0, Math.min(this.cols, Math.round(px / CELL)))
    const gy = Math.max(0, Math.min(this.rows, Math.round(py / CELL)))
    const idx = gy * (this.cols + 1) + gx
    const w = this.weightField[idx]
    return w > 0 ? this.hueField[idx] / w : 0
  }

  /**
   * Iterate the interior as filled polygons.
   *
   * Emitting square cells is what made the body pixelated: the contour is
   * interpolated along cell edges and therefore smooth, while a fillRect snaps
   * to the grid, so the two disagreed by up to half a cell all along the
   * boundary. Each boundary cell is instead filled with the polygon marching
   * squares actually describes, which puts the edge of the body exactly under
   * the outline.
   *
   * `poly` is reused between calls; the callback must consume it immediately.
   */
  forEachInsidePolygon(
    poly: number[],
    fn: (poly: number[], hue: number, depth: number) => void,
  ) {
    const { cols, rows, field } = this

    for (let gy = 0; gy < rows; gy++) {
      const row0 = gy * (cols + 1)
      const row1 = (gy + 1) * (cols + 1)
      for (let gx = 0; gx < cols; gx++) {
        const a = field[row0 + gx]
        const b = field[row0 + gx + 1]
        const c = field[row1 + gx + 1]
        const d = field[row1 + gx]

        let code = 0
        if (a > THRESHOLD) code |= 1
        if (b > THRESHOLD) code |= 2
        if (c > THRESHOLD) code |= 4
        if (d > THRESHOLD) code |= 8
        if (code === 0) continue

        const px = gx * CELL
        const py = gy * CELL
        const px1 = px + CELL
        const py1 = py + CELL

        poly.length = 0

        if (code === 15) {
          // Fully inside: the whole cell, no interpolation needed.
          poly.push(px, py, px1, py, px1, py1, px, py1)
        } else {
          const top = px + CELL * ((THRESHOLD - a) / (b - a))
          const right = py + CELL * ((THRESHOLD - b) / (c - b))
          const bottom = px + CELL * ((THRESHOLD - d) / (c - d))
          const left = py + CELL * ((THRESHOLD - a) / (d - a))

          // Walk the cell corner by corner, inserting the interpolated
          // crossing wherever an edge changes from inside to outside.
          if (a > THRESHOLD) poly.push(px, py)
          if ((code & 1) !== (code & 2) >> 1) poly.push(top, py)
          if (b > THRESHOLD) poly.push(px1, py)
          if ((code & 2) >> 1 !== (code & 4) >> 2) poly.push(px1, right)
          if (c > THRESHOLD) poly.push(px1, py1)
          if ((code & 4) >> 2 !== (code & 8) >> 3) poly.push(bottom, py1)
          if (d > THRESHOLD) poly.push(px, py1)
          if ((code & 8) >> 3 !== (code & 1)) poly.push(px, left)
        }

        if (poly.length < 6) continue

        const w = this.weightField[row0 + gx]
        // Depth beyond the threshold, used to shade the interior: the middle of
        // a mass is denser than its rim, which is what gives it volume.
        fn(poly, w > 0 ? this.hueField[row0 + gx] / w : 0, a - THRESHOLD)
      }
    }
  }

  /** True where the point is inside the surface. */
  insideAt(px: number, py: number): boolean {
    const gx = Math.max(0, Math.min(this.cols, Math.round(px / CELL)))
    const gy = Math.max(0, Math.min(this.rows, Math.round(py / CELL)))
    return this.field[gy * (this.cols + 1) + gx] > THRESHOLD
  }
}

/** Append one segment as four numbers. Flat array: no per-segment objects. */
function push(out: number[], n: number, x1: number, y1: number, x2: number, y2: number): number {
  out.push(x1, y1, x2, y2)
  return n + 1
}
