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
export const THRESHOLD = 0.55

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
  private cols = 0
  private rows = 0
  /** Highest field value in the last build, used to place relative levels. */
  private peak = 0

  constructor(width: number, height: number) {
    this.resize(width, height)
  }

  resize(width: number, height: number) {
    this.cols = Math.ceil(width / CELL) + 1
    this.rows = Math.ceil(height / CELL) + 1
    const n = (this.cols + 1) * (this.rows + 1)
    this.field = new Float32Array(n)
  }

  /**
   * Accumulate every droplet into the field.
   *
   * Each droplet only touches the cells within its influence radius, so this is
   * linear in droplet count rather than in grid size — scattering from the
   * particles is far cheaper than gathering at every sample, since the field is
   * empty almost everywhere.
   */
  build(x: Float32Array, y: Float32Array, count: number) {
    this.field.fill(0)
    this.peak = 0

    const { cols, rows } = this
    const reach = Math.ceil(INFLUENCE / CELL)
    const invR2 = 1 / (INFLUENCE * INFLUENCE)

    for (let i = 0; i < count; i++) {
      const px = x[i]
      const py = y[i]

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
          const v = this.field[idx] + w
          this.field[idx] = v
          if (v > this.peak) this.peak = v
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

  /**
   * An iso-level a given fraction of the way from the surface to the field's
   * peak.
   *
   * A fixed level cannot work: how high the field climbs depends entirely on
   * how much paint is piled up. Measured on a settled blob the field reached
   * 8.7 while the interior level sat at 1.10 — 7% up the slope, hard against
   * the surface, so both iso-lines hugged the same near-vertical step and the
   * inner one inherited its staircase however well it was interpolated.
   */
  levelAt(fraction: number): number {
    return THRESHOLD + (Math.max(this.peak, THRESHOLD) - THRESHOLD) * fraction
  }

  /**
   * Emit the interior as horizontal runs plus boundary polygons.
   *
   * Filling cell by cell meant ~15500 subpaths per frame at 800 droplets, and
   * almost all of them were plain squares tiling a solid region — 4-5 path
   * commands each for area already covered by their neighbours. A real canvas
   * has to tessellate every one of those, which is where the frame went; the
   * arithmetic itself was never the cost.
   *
   * Merging each row's solid interior into one rectangle keeps the same area
   * with a fraction of the commands, while boundary cells still emit their own
   * interpolated polygon so the edge stays smooth.
   */
  forEachSpan(
    poly: number[],
    onRun: (x: number, y: number, w: number, h: number) => void,
    onCell: (poly: number[]) => void,
    level = THRESHOLD,
  ) {
    const { cols, rows, field } = this

    for (let gy = 0; gy < rows; gy++) {
      const row0 = gy * (cols + 1)
      const row1 = (gy + 1) * (cols + 1)

      // Start of the current run of fully-interior cells, or -1 for none.
      let runStart = -1

      for (let gx = 0; gx < cols; gx++) {
        const a = field[row0 + gx]
        const b = field[row0 + gx + 1]
        const c = field[row1 + gx + 1]
        const d = field[row1 + gx]

        const full = a > level && b > level && c > level && d > level

        if (full) {
          if (runStart < 0) runStart = gx
          continue
        }

        // The run ends here; flush it before handling this cell.
        if (runStart >= 0) {
          onRun(runStart * CELL, gy * CELL, (gx - runStart) * CELL, CELL)
          runStart = -1
        }

        let code = 0
        if (a > level) code |= 1
        if (b > level) code |= 2
        if (c > level) code |= 4
        if (d > level) code |= 8
        if (code === 0) continue

        const px = gx * CELL
        const py = gy * CELL
        const px1 = px + CELL
        const py1 = py + CELL

        const top = px + CELL * ((level - a) / (b - a))
        const right = py + CELL * ((level - b) / (c - b))
        const bottom = px + CELL * ((level - d) / (c - d))
        const left = py + CELL * ((level - a) / (d - a))

        poly.length = 0
        if (a > level) poly.push(px, py)
        if ((code & 1) !== (code & 2) >> 1) poly.push(top, py)
        if (b > level) poly.push(px1, py)
        if ((code & 2) >> 1 !== (code & 4) >> 2) poly.push(px1, right)
        if (c > level) poly.push(px1, py1)
        if ((code & 4) >> 2 !== (code & 8) >> 3) poly.push(bottom, py1)
        if (d > level) poly.push(px, py1)
        if ((code & 8) >> 3 !== (code & 1)) poly.push(px, left)

        if (poly.length < 6) continue

        onCell(poly)
      }

      if (runStart >= 0) onRun(runStart * CELL, gy * CELL, (cols - runStart) * CELL, CELL)
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
