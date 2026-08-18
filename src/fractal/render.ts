import { Histogram, iterate, toneMap } from './flame'
import { grandJulian, buildPalette } from './presets'
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
 * Per-frame decay of the histogram. Slow enough that structure accumulates
 * and refines over seconds; fast enough that moving your hand reshapes the
 * image rather than smearing new structure over stale structure forever.
 */
const DECAY = 0.90

export class FractalRenderer {
  private hist: Histogram
  private image: ImageData
  private palette: Float32Array
  private spec: FlameSpec
  private hueShift = 0.6
  private samples = 0
  private decayAccum = 0

  constructor(private width: number, private height: number) {
    this.hist = new Histogram(Math.max(1, width), Math.max(1, height))
    this.image = new ImageData(Math.max(1, width), Math.max(1, height))
    this.palette = buildPalette(this.hueShift, 0.3)
    this.spec = grandJulian({
      openness: 0.5,
      rotation: 0,
      height: 0.5,
      energy: 0.2,
      hueShift: this.hueShift,
    })
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
    const hand = hands[0]

    // Hand state drives the flame's construction. With no hand, the figure
    // drifts slowly so the screen is never static.
    const controls = {
      openness: hand ? hand.openness : 0.45 + Math.sin(performance.now() * 0.0002) * 0.25,
      rotation: hand ? hand.rotation : performance.now() * 0.00012,
      height: hand ? hand.center.y : 0.5,
      energy: params.energy,
      hueShift: this.hueShift,
    }

    this.spec = grandJulian(controls)

    // Palette follows hand x so sliding across the frame recolours the figure.
    const targetHue = hand ? 0.5 + (1 - hand.center.x) * 0.35 : 0.6
    this.hueShift += (targetHue - this.hueShift) * Math.min(1, dt * 2)
    this.palette = buildPalette(this.hueShift, params.energy)

    // Decay is batched: running it every frame costs ~11ms at 1080p, and since
    // exponential decay composes, applying a stronger factor every Nth frame is
    // visually equivalent at a fraction of the cost.
    this.decayAccum += dt
    const DECAY_INTERVAL = 0.1
    if (this.decayAccum >= DECAY_INTERVAL) {
      this.hist.decay(Math.pow(DECAY, this.decayAccum * 60))
      this.decayAccum = 0
    }

    const camera = {
      // Zoom follows hand proximity; the flame is roughly unit-scaled, so the
      // 0.25 factor frames it with margin.
      scale: 0.25 * (hand ? 0.8 + hand.scale * 1.6 : 1),
      ox: 0.5,
      oy: 0.5,
    }

    iterate(this.spec, this.hist, this.palette, SAMPLES_PER_FRAME, camera)
    this.samples = this.samples * 0.98 + SAMPLES_PER_FRAME

    toneMap(this.hist, this.image, 2.2, 1.6)
    ctx.putImageData(this.image, 0, 0)

    if (hand) drawCursor(ctx, this.width, this.height, hand, params)
  }
}

/** Palm ring, so the player can see the app is tracking them. */
function drawCursor(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hand: HandState,
  params: FractalParams,
) {
  const cx = (1 - hand.center.x) * width
  const cy = hand.center.y * height
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = `hsla(190, 90%, 75%, ${0.22 + params.energy * 0.2})`
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(cx, cy, 18 + hand.openness * 30, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalCompositeOperation = 'source-over'
}
