import { Histogram, iterate, toneMap } from './flame'
import { handFlame, buildPalette } from './presets'
import type { HandControl } from './presets'
import { drawSkeleton } from './skeleton'
import { FingerTrails } from './fingerTrails'
import type { FlameSpec } from './flame'
import type { FractalParams } from './params'
import type { HandState } from '../tracking/types'

/**
 * Fractal flame renderer.
 *
 * Unlike the shape-drawing versions this replaces, nothing is ever "drawn":
 * the chaos game splats millions of points into a density histogram, and the
 * image is derived from that density by log tone mapping. That accumulation is
 * also what makes the picture keep refining the longer a pose is held — and
 * what gives the soft, luminous gradients of real flame fractals.
 */

/**
 * Chaos game samples per frame. The cost is linear in this number and it is
 * the dominant term in the frame, so it is set for headroom at full-screen
 * resolution rather than for the fastest possible convergence — the histogram
 * accumulates across frames, so quality builds up over roughly a second
 * regardless.
 */
const SAMPLES_PER_FRAME = 22000

/**
 * Per-frame decay of the histogram, expressed per 1/60s. This is the trail
 * length control, and the factor compounds, so small changes matter a lot:
 * 0.90 is a 0.11s half-life (points vanish almost immediately), 0.985 is
 * 0.76s, 0.996 is nearly 3s.
 *
 * Long trails do not blow out or smear the way one might expect — log tone
 * mapping normalises against peak density, and because the flame is rebuilt
 * every frame the trail repeats the figure's own shape rather than averaging
 * into mush. Measured dynamic range holds at ~1.8 decades even at a 2.9s
 * half-life, so this is free to raise for taste.
 */
const DECAY = 0.985

export class FractalRenderer {
  private hist: Histogram
  private image: ImageData
  private palette: Float32Array
  private spec: FlameSpec
  private hueShift = 0.6
  private samples = 0
  private decayAccum = 0
  private time = 0
  private camScale = 0.22
  private trails = new FingerTrails()

  constructor(private width: number, private height: number) {
    this.hist = new Histogram(Math.max(1, width), Math.max(1, height))
    this.image = new ImageData(Math.max(1, width), Math.max(1, height))
    this.palette = buildPalette(this.hueShift, 0.3)
    this.spec = handFlame({ hands: [], energy: 0.2, time: 0 })
  }

  /**
   * Resize reallocates the histogram. The accumulated image cannot be
   * meaningfully rescaled — density per pixel is resolution-dependent — so it
   * restarts rather than producing a wrong-looking stretch.
   */
  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.hist = new Histogram(Math.max(1, width), Math.max(1, height))
    this.image = new ImageData(Math.max(1, width), Math.max(1, height))
    this.samples = 0
  }

  reset() {
    this.hist.clear()
    this.samples = 0
    this.trails.clear()
  }

  /** Live sample count, surfaced in the debug HUD. */
  get tipCount() {
    return Math.round(this.samples / 1000)
  }

  render(
    ctx: CanvasRenderingContext2D,
    params: FractalParams,
    hands: HandState[],
    dt: number,
  ) {
    this.time += dt

    // Convert every tracked hand into flame space. Both hands contribute —
    // each gets its own transform cluster anchored at its position, so the
    // structure grows out of the hands rather than out of a fixed centre.
    const controls: HandControl[] = hands.map((h) => {
      const speed = Math.hypot(h.velocity.x, h.velocity.y)
      return {
        // Mirrored to match the video, and mapped to the flame's -1..1 space.
        x: ((1 - h.center.x) - 0.5) * 2.4,
        y: (h.center.y - 0.5) * 2.4,
        openness: h.openness,
        rotation: h.rotation,
        energy: Math.min(1, speed * 1.6),
        scale: h.scale,
        colorBase: h.handedness === 'Left' ? 0.06 : 0.62,
      }
    })

    this.spec = handFlame({
      hands: controls,
      energy: params.energy,
      time: this.time,
    })

    // Palette follows the hands. Two hands average their positions, so
    // sweeping either one recolours the whole figure.
    const targetHue =
      controls.length > 0
        ? 0.42 + controls.reduce((s2, h) => s2 + h.x, 0) / controls.length * 0.22
        : 0.6
    // Eased fast enough to feel responsive but not so fast that tracking
    // jitter makes the colour flicker.
    this.hueShift += (targetHue - this.hueShift) * Math.min(1, dt * 4)
    this.palette = buildPalette(this.hueShift, params.energy)

    // Decay is batched: running it every frame costs ~11ms at 1080p, and since
    // exponential decay composes, applying a stronger factor every Nth frame is
    // visually equivalent at a fraction of the cost.
    //
    // Motion no longer shortens the trail. Speeding decay up while moving cut
    // the trail exactly when a gesture was drawing it, which defeated the
    // point; the flame is rebuilt every frame anyway, so a stale pose fades on
    // its own without help.
    this.decayAccum += dt
    const DECAY_INTERVAL = 0.06
    if (this.decayAccum >= DECAY_INTERVAL) {
      this.hist.decay(Math.pow(DECAY, this.decayAccum * 60))
      this.decayAccum = 0
    }

    // The camera frames whatever is on screen. Because the transforms are
    // anchored at the hands, the figure already sits under them; the camera
    // only needs a stable scale, so it does not chase the hands and make the
    // whole image lurch.
    const proximity =
      controls.length > 0
        ? controls.reduce((s2, h) => s2 + h.scale, 0) / controls.length
        : 0.16
    const targetScale = 0.20 * (0.85 + proximity * 1.1)
    this.camScale += (targetScale - this.camScale) * Math.min(1, dt * 3)

    const camera = { scale: this.camScale, ox: 0.5, oy: 0.5 }

    iterate(this.spec, this.hist, this.palette, SAMPLES_PER_FRAME, camera)
    this.samples = this.samples * 0.98 + SAMPLES_PER_FRAME

    toneMap(this.hist, this.image, 2.2, 1.6)
    ctx.putImageData(this.image, 0, 0)

    // Trails go under the skeleton so the hand always reads on top of its
    // own wake.
    this.trails.update(hands)
    this.trails.draw(ctx, this.width, this.height, this.palette, this.time, params.energy)

    for (const h of hands) {
      drawSkeleton(ctx, this.width, this.height, h, this.palette, this.time, params.energy)
    }
  }
}
