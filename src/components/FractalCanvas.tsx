import { useEffect, useImperativeHandle, useRef } from 'react'
import { FractalRenderer } from '../fractal/render'
import { DEFAULT_PARAMS, easeParams, paramsFromFrame } from '../fractal/params'
import type { FractalParams } from '../fractal/params'
import type { TrackingFrame } from '../tracking/types'
import type { FaceFrame } from '../tracking/useFaceTracking'

export interface FractalHandle {
  /** Clear the accumulated drawing and the live growth front. */
  reset(): void
}

interface Props {
  frameRef: React.RefObject<TrackingFrame>
  /** Optional face landmarks; absent if face tracking failed to start. */
  faceRef?: React.RefObject<FaceFrame>
  handleRef?: React.Ref<FractalHandle>
  /** Reports eased params + live tip count upward, throttled to ~5Hz. */
  onStats?: (params: FractalParams, tips: number) => void
}

/**
 * The render loop. Deliberately isolated from React's update cycle: it reads
 * tracking through a ref and never sets state per frame, so the component
 * mounts once and then runs entirely on rAF.
 */
export function FractalCanvas({ frameRef, faceRef, handleRef, onStats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paramsRef = useRef<FractalParams>(DEFAULT_PARAMS)
  const rendererRef = useRef<FractalRenderer | null>(null)
  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats

  useImperativeHandle(handleRef, () => ({ reset: () => rendererRef.current?.reset() }), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    let lastReport = 0

    // The flame renderer writes pixels directly via putImageData, whose cost
    // is per backing-store pixel and which ignores canvas transforms. A full
    // DPR buffer would quadruple the tone-mapping work for no visible gain, so
    // the histogram is kept at CSS resolution.
    const dpr = 1

    const sizeOf = () => ({
      w: Math.max(1, Math.floor(canvas.clientWidth)),
      h: Math.max(1, Math.floor(canvas.clientHeight)),
    })

    const applySize = () => {
      const { w, h } = sizeOf()
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { w: canvas.width, h: canvas.height }
    }

    const initial = applySize()
    const renderer = new FractalRenderer(initial.w, initial.h)
    rendererRef.current = renderer

    const observer = new ResizeObserver(() => {
      const { w, h } = applySize()
      renderer.resize(w, h)
    })
    observer.observe(canvas)

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      // Clamping dt keeps a backgrounded tab from resuming with one enormous
      // step that would decay the whole histogram away in a single frame.
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      const frame = frameRef.current ?? { hands: [], timestamp: 0 }
      const target = paramsFromFrame(frame)
      paramsRef.current = easeParams(paramsRef.current, target, dt)

      renderer.render(ctx, paramsRef.current, frame.hands, dt, faceRef?.current?.face)

      if (onStatsRef.current && now - lastReport > 200) {
        lastReport = now
        onStatsRef.current(paramsRef.current, renderer.tipCount)
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      rendererRef.current = null
    }
  }, [frameRef, faceRef])

  return <canvas ref={canvasRef} className="fractal-canvas" />
}
