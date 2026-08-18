import type { HandState } from '../tracking/types'

/**
 * Glowing trails behind the fingertips.
 *
 * The flame layer cannot carry these: it is rebuilt from a histogram every
 * frame via putImageData, so anything drawn onto it is overwritten. Instead we
 * keep our own short history of each fingertip and redraw it as a fading
 * ribbon each frame.
 *
 * History is stored in preallocated ring buffers — five fingertips times two
 * hands times a 40-frame history is 400 points updated 60 times a second, and
 * allocating those as objects would produce steady GC pressure for no reason.
 */

/** Fingertip landmark indices: thumb, index, middle, ring, pinky. */
const TIPS = [4, 8, 12, 16, 20]

/** Points kept per fingertip. At 60fps this is the trail's length in frames. */
const HISTORY = 44

interface Trail {
  /** Interleaved x,y in normalized coords; length HISTORY * 2. */
  pts: Float32Array
  /** Next write index into the ring. */
  head: number
  /** How many slots hold real data (< HISTORY until the ring first fills). */
  filled: number
}

function makeTrail(): Trail {
  return { pts: new Float32Array(HISTORY * 2), head: 0, filled: 0 }
}

export class FingerTrails {
  /** Keyed by handedness so a trail follows the same physical hand. */
  private trails = new Map<string, Trail[]>()
  /** Frames since a hand was last seen, so vanished hands drop their trails. */
  private missing = new Map<string, number>()

  clear() {
    this.trails.clear()
    this.missing.clear()
  }

  /** Record the current fingertip positions for every visible hand. */
  update(hands: HandState[]) {
    const seen = new Set<string>()

    for (const hand of hands) {
      if (!hand.landmarks || hand.landmarks.length < 21) continue
      const key = hand.handedness
      seen.add(key)
      this.missing.set(key, 0)

      let bank = this.trails.get(key)
      if (!bank) {
        bank = TIPS.map(makeTrail)
        this.trails.set(key, bank)
      }

      for (let f = 0; f < TIPS.length; f++) {
        const p = hand.landmarks[TIPS[f]]
        const t = bank[f]
        t.pts[t.head * 2] = p.x
        t.pts[t.head * 2 + 1] = p.y
        t.head = (t.head + 1) % HISTORY
        if (t.filled < HISTORY) t.filled++
      }
    }

    // A hand that leaves the frame keeps its trail briefly, so brief tracking
    // dropouts do not make the trails blink out and restart.
    for (const key of this.trails.keys()) {
      if (seen.has(key)) continue
      const n = (this.missing.get(key) ?? 0) + 1
      this.missing.set(key, n)
      if (n > 12) {
        this.trails.delete(key)
        this.missing.delete(key)
      }
    }
  }

  /**
   * Draw every trail, oldest end faintest.
   *
   * Colour comes from the flame's own palette so the trails shimmer with the
   * fractal, matching the skeleton overlay.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    palette: Float32Array,
    time: number,
    energy: number,
  ) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    for (const [handedness, bank] of this.trails) {
      const phase = time * 0.12 + (handedness === 'Left' ? 0 : 0.5)
      // A hand that has left the frame fades its trail out over the grace
      // period rather than having it vanish on one frame.
      const gone = this.missing.get(handedness) ?? 0
      const presence = gone === 0 ? 1 : Math.max(0, 1 - gone / 12)
      if (presence <= 0) continue

      for (let f = 0; f < bank.length; f++) {
        const t = bank[f]
        if (t.filled < 2) continue

        // Each finger sits at its own point in the palette, so the five trails
        // read as distinct ribbons rather than one smear.
        const hueT = (f / bank.length + phase) % 1
        const ci = Math.max(0, Math.min(255, Math.round(hueT * 255))) * 3
        const r = Math.min(255, palette[ci] * 1.6 + 30) | 0
        const g = Math.min(255, palette[ci + 1] * 1.6 + 30) | 0
        const b = Math.min(255, palette[ci + 2] * 1.6 + 30) | 0

        // Oldest sample first, so age increases along the drawn path.
        const start = t.filled < HISTORY ? 0 : t.head

        // Two passes: a wide faint glow, then a thin bright core.
        //
        // Segments are batched into a handful of paths rather than stroked
        // individually. A per-segment stroke() meant ~860 calls per frame with
        // two hands; grouping by opacity band cuts that by an order of
        // magnitude, since stroke() is the expensive part, not the geometry.
        const BANDS = 5
        for (let pass = 0; pass < 2; pass++) {
          const glow = pass === 0

          for (let band = 0; band < BANDS; band++) {
            // Representative age for this band, used for width and alpha.
            const bandT = (band + 0.5) / BANDS
            const fade = bandT * bandT
            const alpha =
              (glow ? fade * (0.05 + energy * 0.05) : fade * (0.32 + energy * 0.3)) * presence
            if (alpha < 0.004) continue

            ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
            ctx.lineWidth = glow ? 7 * fade + 2 : 2.1 * fade + 0.3
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
      }
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}
