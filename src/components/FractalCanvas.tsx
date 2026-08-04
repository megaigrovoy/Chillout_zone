import { useEffect, useImperativeHandle, useRef } from 'react'
import { FractalRenderer } from '../fractal/render'
import { DEFAULT_PARAMS, easeParams, paramsFromFrame } from '../fractal/params'
import type { FractalParams } from '../fractal/params'
import type { TrackingFrame } from '../tracking/types'

export interface FractalHandle {
  /** Clear the accumulated drawing and the live growth front. */
  reset(): void
}

interface Props {
  frameRef: React.RefObject<TrackingFrame>
  handleRef?: React.Ref<FractalHandle>
  /** Reports eased params + live tip count upward, throttled to ~5Hz. */
  onStats?: (params: FractalParams, tips: number) => void
}

/**
 * The render loop. Deliberately isolated from React's update cycle: it reads
 * tracking through a ref and never sets state per frame, so the component
 * mounts once and then runs entirely on rAF.
 */
export function FractalCanvas({ frameRef, handleRef, onStats }: Props) {
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

    // Cap the backing store at 2x: on a 4K display a full-DPR canvas doing
    // additive blending over thousands of segments will not hold 60fps.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const sizeOf = () => ({
      w: Math.max(1, Math.floor(canvas.clientWidth)),
      h: Math.max(1, Math.floor(canvas.clientHeight)),
    })

    const applySize = () => {
      const { w, h } = sizeOf()
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { w, h }
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
      // step that would fling every growth tip off screen at once.
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      const frame = frameRef.current ?? { hands: [], timestamp: 0 }
      const target = paramsFromFrame(frame)
      paramsRef.current = easeParams(paramsRef.current, target, dt)

      renderer.render(ctx, paramsRef.current, frame.hands, dt)

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
  }, [frameRef])

  return <canvas ref={canvasRef} className="fractal-canvas" />
}
