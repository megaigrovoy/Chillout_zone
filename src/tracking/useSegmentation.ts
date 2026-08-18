import { useCallback, useEffect, useRef } from 'react'
import { FilesetResolver, ImageSegmenter } from '@mediapipe/tasks-vision'

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'

/**
 * Resolution the silhouette is traced at.
 *
 * The mask arrives at the video's size, and reading it costs a GPU-to-CPU
 * transfer plus a full scan. Tracing at a fraction of that is far cheaper and
 * costs nothing visually, because the result is drawn as a soft glow — a
 * blurred outline has no detail to lose.
 */
const TRACE_W = 160
const TRACE_H = 120

export interface Silhouette {
  /**
   * Occupancy grid at TRACE_W x TRACE_H: 1 where a person is, 0 elsewhere.
   * Kept as a grid rather than a polygon because the glow is rendered by
   * sampling neighbours, which needs random access.
   */
  grid: Float32Array
  width: number
  height: number
  /** True once at least one frame has been segmented. */
  ready: boolean
  /**
   * Increments on every segmentation update. Lets the renderer skip rebuilding
   * its cached aura layer while the silhouette is unchanged — segmentation
   * runs at 15Hz against a 60Hz render loop.
   */
  stamp: number
}

/**
 * Person segmentation, used to draw a glowing aura around the player.
 *
 * Runs as a separate task from hand tracking rather than sharing one: the
 * segmenter is much heavier, so it is throttled to a lower rate. The aura is a
 * slow, soft effect, so it does not need to update every frame.
 */
export function useSegmentation(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const silhouetteRef = useRef<Silhouette>({
    grid: new Float32Array(TRACE_W * TRACE_H),
    width: TRACE_W,
    height: TRACE_H,
    ready: false,
    stamp: 0,
  })

  const segmenterRef = useRef<ImageSegmenter | null>(null)
  const rafRef = useRef<number | null>(null)
  const activeRef = useRef(false)
  /** Scratch canvas used to downscale the mask before reading it back. */
  const scratchRef = useRef<{ c: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null>(null)

  const stop = useCallback(() => {
    activeRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    segmenterRef.current?.close()
    segmenterRef.current = null
    silhouetteRef.current.grid.fill(0)
    silhouetteRef.current.ready = false
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT)
      const segmenter = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      })
      if (!activeRef.current) {
        segmenter.close()
        return
      }
      segmenterRef.current = segmenter

      const c = document.createElement('canvas')
      c.width = TRACE_W
      c.height = TRACE_H
      const sctx = c.getContext('2d', { willReadFrequently: true })
      if (!sctx) throw new Error('2D context unavailable for mask scratch')
      scratchRef.current = { c, ctx: sctx }

      let lastVideoTime = -1
      let lastRun = 0
      // Segmentation is the expensive half of the vision pipeline, and the aura
      // is a soft slow effect — 15Hz is indistinguishable from 60 here.
      const INTERVAL = 1000 / 15

      const tick = () => {
        if (!activeRef.current) return
        rafRef.current = requestAnimationFrame(tick)

        const el = videoRef.current
        const seg = segmenterRef.current
        const scratch = scratchRef.current
        if (!el || !seg || !scratch || el.readyState < 2) return

        const now = performance.now()
        if (now - lastRun < INTERVAL) return
        if (el.currentTime === lastVideoTime) return
        lastVideoTime = el.currentTime
        lastRun = now

        const result = seg.segmentForVideo(el, now)
        const mask = result.categoryMask
        if (!mask) return

        try {
          // Draw the mask's backing canvas scaled down, then read it back once.
          // Reading the full-size mask directly would mean a GPU-to-CPU
          // transfer of the whole frame every time.
          const src = mask.canvas
          if (src) {
            scratch.ctx.clearRect(0, 0, TRACE_W, TRACE_H)
            scratch.ctx.drawImage(src as CanvasImageSource, 0, 0, TRACE_W, TRACE_H)
            const data = scratch.ctx.getImageData(0, 0, TRACE_W, TRACE_H).data

            const grid = silhouetteRef.current.grid
            for (let i = 0; i < grid.length; i++) {
              // The selfie model marks background as category 0; anything else
              // is the person. The mask is drawn into the red channel.
              const v = data[i * 4]
              // Ease toward the new value so the outline breathes rather than
              // snapping between segmentation frames.
              const target = v > 0 ? 1 : 0
              grid[i] += (target - grid[i]) * 0.5
            }
            silhouetteRef.current.ready = true
            silhouetteRef.current.stamp++
          }
        } finally {
          // Masks hold GPU resources; leaking one per frame would exhaust
          // memory within seconds.
          mask.close()
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    } catch {
      // The aura is decorative: if segmentation cannot start (model fetch
      // blocked, no GPU delegate), the app keeps working without it rather
      // than surfacing an error over the whole experience.
      activeRef.current = false
    }
  }, [videoRef])

  useEffect(() => stop, [stop])

  return { silhouetteRef, start, stop }
}
