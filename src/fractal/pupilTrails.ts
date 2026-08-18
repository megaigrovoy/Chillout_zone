import type { FaceState } from '../tracking/useFaceTracking'

/**
 * Glowing trails behind the pupils.
 *
 * Same approach as the fingertip trails: the flame layer is rewritten every
 * frame via putImageData, so nothing drawn on it survives, and the history has
 * to be kept here. Ring buffers again, preallocated — two pupils at 60Hz is
 * modest, but the allocation-free pattern is already established and costs
 * nothing to follow.
 *
 * The trail is deliberately longer and finer than the fingertip one: eyes move
 * in quick saccades rather than sweeps, so a short trail would barely register.
 */

const HISTORY = 56

interface Trail {
  pts: Float32Array
  head: number
  filled: number
}

const makeTrail = (): Trail => ({ pts: new Float32Array(HISTORY * 2), head: 0, filled: 0 })

export class PupilTrails {
  private trails: Trail[] = [makeTrail(), makeTrail()]
  /** Frames since a face was last seen, so a vanished face releases its trail. */
  private missing = 0

  clear() {
    for (const t of this.trails) {
      t.head = 0
      t.filled = 0
    }
    this.missing = 0
  }

  update(face: FaceState | null | undefined) {
    if (!face || !face.pupils || face.pupils.length < 2) {
      this.missing++
      if (this.missing > 14) this.clear()
      return
    }
    this.missing = 0

    for (let i = 0; i < 2; i++) {
      const p = face.pupils[i]
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
      const t = this.trails[i]
      t.pts[t.head * 2] = p.x
      t.pts[t.head * 2 + 1] = p.y
      t.head = (t.head + 1) % HISTORY
      if (t.filled < HISTORY) t.filled++
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    palette: Float32Array,
    time: number,
    energy: number,
  ) {
    if (this.missing > 14) return

    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    // Presence fades a vanished face out rather than cutting the trail dead.
    const presence = this.missing === 0 ? 1 : Math.max(0, 1 - this.missing / 14)

    for (let e = 0; e < this.trails.length; e++) {
      const t = this.trails[e]
      if (t.filled < 2) continue

      // The two eyes sit at slightly different palette points so their trails
      // are distinguishable when they cross.
      const hueT = (time * 0.12 + 0.3 + e * 0.08) % 1
      const ci = Math.max(0, Math.min(255, Math.round(((hueT % 1) + 1) % 1 * 255))) * 3
      const r = Math.min(255, palette[ci] * 1.7 + 45) | 0
      const g = Math.min(255, palette[ci + 1] * 1.7 + 45) | 0
      const b = Math.min(255, palette[ci + 2] * 1.7 + 50) | 0

      const start = t.filled < HISTORY ? 0 : t.head

      // Batched into opacity bands rather than stroked per segment, matching
      // the fingertip trails: stroke() is the expensive call, not the geometry.
      const BANDS = 5
      for (let pass = 0; pass < 2; pass++) {
        const glow = pass === 0

        for (let band = 0; band < BANDS; band++) {
          const bandT = (band + 0.5) / BANDS
          const fade = bandT * bandT
          const alpha =
            (glow ? fade * (0.05 + energy * 0.05) : fade * (0.36 + energy * 0.3)) * presence
          if (alpha < 0.004) continue

          ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
          ctx.lineWidth = glow ? 5 * fade + 1.4 : 1.5 * fade + 0.25
          ctx.beginPath()

          let any = false
          const lo = Math.floor((band / BANDS) * t.filled)
          const hi = Math.floor(((band + 1) / BANDS) * t.filled)

          for (let i = Math.max(1, lo); i < hi; i++) {
            const i0 = (start + i - 1) % HISTORY
            const i1 = (start + i) % HISTORY

            const x0 = (1 - t.pts[i0 * 2]) * width
            const y0 = t.pts[i0 * 2 + 1] * height
            const x1 = (1 - t.pts[i1 * 2]) * width
            const y1 = t.pts[i1 * 2 + 1] * height

            // Skip the seam segment when the ring wraps mid-trail.
            const dx = x1 - x0
            const dy = y1 - y0
            if (dx * dx + dy * dy > width * width * 0.25) continue

            ctx.moveTo(x0, y0)
            ctx.lineTo(x1, y1)
            any = true
          }

          if (any) ctx.stroke()
        }
      }

      // A bright head at the pupil itself, so the eye reads as the source.
      const hi = (start + t.filled - 1) % HISTORY
      const hx = (1 - t.pts[hi * 2]) * width
      const hy = t.pts[hi * 2 + 1] * height
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${0.5 * presence})`
      ctx.beginPath()
      ctx.arc(hx, hy, 2.6 + energy * 1.6, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}
