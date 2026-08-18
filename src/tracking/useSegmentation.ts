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

/**
 * Category index the selfie model assigns to the person.
 *
 * The model emits 0 for the subject and 255 for the background, which is the
 * reverse of what one would guess; treating it the other way round outlines
 * the entire frame border instead of the body.
 */
const PERSON_CATEGORY = 0

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
        if (!el || !seg || el.readyState < 2) return

        const now = performance.now()
        if (now - lastRun < INTERVAL) return
        if (el.currentTime === lastVideoTime) return
        lastVideoTime = el.currentTime
        lastRun = now

        const result = seg.segmentForVideo(el, now)
        const mask = result.categoryMask
        if (!mask) return

        try {
          // Read the mask as an explicit array rather than going through
          // mask.canvas: that canvas belongs to the MediaPipe task and is not
          // a ready-to-draw image of the mask, and the mask may live as a
          // WebGL texture with no canvas at all.
          const raw = mask.getAsUint8Array()
          const mw = mask.width
          const mh = mask.height

          if (raw.length >= mw * mh) {
            const grid = silhouetteRef.current.grid

            // Box-filter downsample: average every mask pixel falling inside
            // a trace cell rather than picking one. Nearest-neighbour made the
            // occupancy strictly 0 or 1, which quantised the outline into a
            // staircase; averaging yields fractional coverage at the boundary,
            // so the edge can sit between cells.
            const bx = mw / TRACE_W
            const by = mh / TRACE_H
            for (let y = 0; y < TRACE_H; y++) {
              const sy0 = (y * by) | 0
              const sy1 = Math.max(sy0 + 1, ((y + 1) * by) | 0)
              const drow = y * TRACE_W
              for (let x = 0; x < TRACE_W; x++) {
                const sx0 = (x * bx) | 0
                const sx1 = Math.max(sx0 + 1, ((x + 1) * bx) | 0)

                let hit = 0
                let total = 0
                for (let sy = sy0; sy < sy1; sy++) {
                  const srow = sy * mw
                  for (let sx = sx0; sx < sx1; sx++) {
                    // selfie_segmenter labels the PERSON as category 0 and the
                    // background as 255 — the opposite of the intuitive
                    // reading, and getting it backwards outlines the whole
                    // frame instead of the body.
                    if (raw[srow + sx] === PERSON_CATEGORY) hit++
                    total++
                  }
                }

                const target = total > 0 ? hit / total : 0
                const i = drow + x
                // Ease toward the new value so the outline settles smoothly
                // between segmentation frames.
                grid[i] += (target - grid[i]) * 0.5
              }
            }
            if (!silhouetteRef.current.ready) {
              console.info(`[chillout] segmentation active (mask ${mw}x${mh})`)
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
    } catch (err) {
      // The aura is decorative: if segmentation cannot start (model fetch
      // blocked, no GPU delegate), the app keeps working without it rather
      // than surfacing an error over the whole experience. It is still logged,
      // because a silent failure here is indistinguishable from the effect
      // simply not being implemented.
      console.warn('[chillout] segmentation unavailable, aura disabled:', err)
      activeRef.current = false
    }
  }, [videoRef])

  useEffect(() => stop, [stop])

  return { silhouetteRef, start, stop }
}
