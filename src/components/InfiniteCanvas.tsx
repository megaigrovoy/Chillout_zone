import { useEffect, useImperativeHandle, useRef } from 'react'
import { InfiniteRenderer } from '../infinite/render'
import type { InfiniteVariant } from '../infinite/render'
import type { TrackingFrame } from '../tracking/types'

export interface InfiniteHandle {
  reset(): void
}

interface Props {
  frameRef: React.RefObject<TrackingFrame>
  variant: InfiniteVariant
  handleRef?: React.Ref<InfiniteHandle>
  /** Reports zoom depth for the debug HUD, throttled to ~5Hz. */
  onStats?: (depth: number) => void
}

/**
 * Render loop for the infinite-zoom modes.
 *
 * Mirrors the other canvases: tracking is read from a ref and no state is set
 * per frame, so the component mounts once and then runs on rAF alone.
 */
export function InfiniteCanvas({ frameRef, variant, handleRef, onStats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<InfiniteRenderer | null>(null)
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

    // The field is evaluated into a small buffer and stretched, so the canvas
    // backing store gains nothing from extra device pixels.
    const applySize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth))
      const h = Math.max(1, Math.floor(canvas.clientHeight))
      canvas.width = w
      canvas.height = h
      return { w, h }
    }

    const initial = applySize()
    const renderer = new InfiniteRenderer(initial.w, initial.h, variant)
    rendererRef.current = renderer

    const observer = new ResizeObserver(() => {
      const { w, h } = applySize()
      renderer.resize(w, h)
    })
    observer.observe(canvas)

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      // Clamped so a backgrounded tab does not resume with one enormous zoom
      // step that would skip whole shells.
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now

      const frame = frameRef.current ?? { hands: [], timestamp: 0 }
      renderer.render(ctx, frame.hands, dt)

      if (onStatsRef.current && now - lastReport > 200) {
        lastReport = now
        onStatsRef.current(renderer.depth)
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      rendererRef.current = null
    }
    // variant is included: switching it must rebuild the renderer, since the
    // variant is fixed at construction.
  }, [frameRef, variant])

  return <canvas ref={canvasRef} className="fractal-canvas" />
}
