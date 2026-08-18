import { useCallback, useEffect, useRef, useState } from 'react'
import { FractalCanvas } from './components/FractalCanvas'
import type { FractalHandle } from './components/FractalCanvas'
import { useHandTracking } from './tracking/useHandTracking'
import type { FractalParams } from './fractal/params'
import './App.css'

interface Stats {
  params: FractalParams
  tips: number
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fractalRef = useRef<FractalHandle | null>(null)
  const { status, frameRef, start, stop } = useHandTracking(videoRef)
  const [stats, setStats] = useState<Stats | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)

  // Track the real fullscreen state rather than a local flag: the user can
  // leave with Escape or the browser's own control, and a flag would then
  // disagree with reality and leave the button showing the wrong label.
  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', sync)
    sync()
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  const toggleFullscreen = useCallback(() => {
    // Both calls reject when the browser refuses (no user gesture, disallowed
    // by permissions policy). Nothing to recover, so the rejection is
    // swallowed rather than left as an unhandled promise.
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    } else {
      document.documentElement.requestFullscreen().catch(() => {})
    }
  }, [])

  const handleStats = useCallback(
    (params: FractalParams, tips: number) => {
      if (showDebug) setStats({ params, tips })
    },
    [showDebug],
  )

  return (
    <div className="app">
      <FractalCanvas frameRef={frameRef} handleRef={fractalRef} onStats={handleStats} />

      {/* Kept mounted and hidden: MediaPipe reads pixels straight off this
          element, so it must exist and be playing whenever tracking runs. */}
      <video ref={videoRef} className="camera-feed" playsInline muted />

      {status.kind !== 'running' && (
        <div className="overlay">
          <div className="panel">
            <h1>Chillout Zone</h1>
            <p className="lead">
              Настоящие фрактальные пламёна (fractal flames) — те самые светящиеся
              спирали из Apophysis. Фрактал вырастает прямо из ваших ладоней и
              пересобирается движением. Разрешите доступ к камере и поднимите
              обе руки перед собой.
            </p>

            <ul className="hints">
              <li>Обе руки — из каждой ладони растёт своя половина фрактала</li>
              <li>Сведите ладони — формы сплетаются в одну</li>
              <li>Раскрытая ладонь — спираль раскрывается и закручивается</li>
              <li>Резкое движение — из руки выбрасываются нити</li>
              <li>Поворот кисти вращает свою половину фигуры</li>
              <li>Ближе к камере — фигура крупнее</li>
            </ul>

            {status.kind === 'error' && <p className="error">{status.message}</p>}

            <button className="primary" onClick={start} disabled={status.kind === 'loading'}>
              {status.kind === 'loading' ? 'Загрузка модели…' : 'Включить камеру'}
            </button>
            <p className="privacy">
              Видео обрабатывается локально в браузере и никуда не передаётся.
            </p>
            {/* Also offered before starting: going fullscreen first avoids a
                canvas resize (and the histogram reset it forces) mid-session. */}
            <button className="ghost" onClick={toggleFullscreen}>
              {isFullscreen ? 'Свернуть' : 'На весь экран'}
            </button>
          </div>
        </div>
      )}

      {status.kind === 'running' && (
        <div className="hud">
          <button onClick={stop}>Стоп</button>
          <button onClick={() => fractalRef.current?.reset()}>Очистить</button>
          <button onClick={toggleFullscreen}>
            {isFullscreen ? 'Свернуть' : 'На весь экран'}
          </button>
          <button onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? 'Скрыть данные' : 'Показать данные'}
          </button>
          {showDebug && stats && (
            <dl className="debug">
              <div><dt>выборок</dt><dd>{stats.tips}K</dd></div>
              <div><dt>глубина</dt><dd>{stats.params.depth.toFixed(1)}</dd></div>
              <div><dt>ветви</dt><dd>{stats.params.branches.toFixed(1)}</dd></div>
              <div><dt>разброс</dt><dd>{stats.params.spread.toFixed(2)}</dd></div>
              <div><dt>энергия</dt><dd>{stats.params.energy.toFixed(2)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
