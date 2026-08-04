import { useCallback, useRef, useState } from 'react'
import { FractalCanvas } from './components/FractalCanvas'
import { useHandTracking } from './tracking/useHandTracking'
import type { FractalParams } from './fractal/params'
import './App.css'

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const { status, frameRef, start, stop } = useHandTracking(videoRef)
  const [params, setParams] = useState<FractalParams | null>(null)
  const [showDebug, setShowDebug] = useState(false)

  const handleParams = useCallback(
    (p: FractalParams) => {
      if (showDebug) setParams(p)
    },
    [showDebug],
  )

  return (
    <div className="app">
      <FractalCanvas frameRef={frameRef} onParams={handleParams} />

      {/* Kept mounted and hidden: MediaPipe reads pixels straight off this
          element, so it must exist and be playing whenever tracking runs. */}
      <video ref={videoRef} className="camera-feed" playsInline muted />

      {status.kind !== 'running' && (
        <div className="overlay">
          <div className="panel">
            <h1>Chillout Zone</h1>
            <p className="lead">
              Интерактивные фракталы, которыми вы управляете руками. Разрешите доступ к камере,
              поднимите ладони перед собой и меняйте форму движением кистей.
            </p>

            <ul className="hints">
              <li>Раскрывайте и сжимайте ладонь — меняется ветвление формы</li>
              <li>Поднимайте и опускайте руку — растёт глубина фрактала</li>
              <li>Поворачивайте кисть — форма закручивается</li>
              <li>Двигайтесь быстрее — фрактал становится ярче</li>
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
          <button onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? 'Скрыть данные' : 'Показать данные'}
          </button>
          {showDebug && params && (
            <dl className="debug">
              <div><dt>глубина</dt><dd>{params.depth.toFixed(1)}</dd></div>
              <div><dt>ветви</dt><dd>{params.branches.toFixed(1)}</dd></div>
              <div><dt>разброс</dt><dd>{params.spread.toFixed(2)}</dd></div>
              <div><dt>закрутка</dt><dd>{params.twist.toFixed(2)}</dd></div>
              <div><dt>энергия</dt><dd>{params.energy.toFixed(2)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
