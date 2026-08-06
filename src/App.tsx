import { useCallback, useRef, useState } from 'react'
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
              Из ладони раскрываются самоподобные спиральные узоры: каждый завиток
              повторяет себя в меньшем масштабе, снова и снова. Разрешите доступ к камере
              и поднимите ладонь перед собой.
            </p>

            <ul className="hints">
              <li>Раскрытая ладонь — узор ветвится шире и рождается чаще</li>
              <li>Сжатый кулак — тугая плотная спираль</li>
              <li>Поворот кисти задаёт наклон всей фигуры</li>
              <li>Поднимите руку выше — больше уровней вложенности</li>
              <li>Ближе к камере — фигура крупнее</li>
            </ul>

            {status.kind === 'error' && <p className="error">{status.message}</p>}

            <button className="primary" onClick={start} disabled={status.kind === 'loading'}>
              {status.kind === 'loading' ? 'Загрузка модели…' : 'Включить камеру'}
            </button>
            <p className="privacy">
              Видео обрабатывается локально в браузере и никуда не передаётся.
            </p>
          </div>
        </div>
      )}

      {status.kind === 'running' && (
        <div className="hud">
          <button onClick={stop}>Стоп</button>
          <button onClick={() => fractalRef.current?.reset()}>Очистить</button>
          <button onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? 'Скрыть данные' : 'Показать данные'}
          </button>
          {showDebug && stats && (
            <dl className="debug">
              <div><dt>сегментов</dt><dd>{stats.tips}</dd></div>
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
