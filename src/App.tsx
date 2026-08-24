import { useCallback, useEffect, useRef, useState } from 'react'
import { FractalCanvas } from './components/FractalCanvas'
import type { FractalHandle } from './components/FractalCanvas'
import { ParticleCanvas } from './components/ParticleCanvas'
import type { ParticleHandle } from './components/ParticleCanvas'
import { InfiniteCanvas } from './components/InfiniteCanvas'
import type { InfiniteHandle } from './components/InfiniteCanvas'
import { useHandTracking } from './tracking/useHandTracking'
import { useFaceTracking } from './tracking/useFaceTracking'
import type { FractalParams } from './fractal/params'
import './App.css'

interface Stats {
  params: FractalParams
  tips: number
}

/**
 * The visual engines.
 *
 * Genuinely different systems rather than settings on one: the flame has no
 * objects to collide, so real physics needs a particle simulation, and the
 * log-space modes are per-pixel field evaluations with no objects at all. The
 * mode is chosen before starting and fixed for the session, which keeps each
 * renderer owning its own canvas and lifecycle.
 */
type Mode = 'flame' | 'collision' | 'logpolar' | 'droste' | 'kifs'

/** The three log-space modes share one renderer, parameterised by variant. */
const INFINITE_MODES: Mode[] = ['logpolar', 'droste', 'kifs']

export default function App() {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const fractalRef = useRef<FractalHandle | null>(null)
  const particleRef = useRef<ParticleHandle | null>(null)
  const infiniteRef = useRef<InfiniteHandle | null>(null)
  const { status, frameRef, start: startHands, stop: stopHands } = useHandTracking(videoRef)
  const { faceRef, start: startFace, stop: stopFace } = useFaceTracking(videoRef)
  const [stats, setStats] = useState<Stats | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [mode, setMode] = useState<Mode>('flame')
  const [particles, setParticles] = useState(0)
  const [depth, setDepth] = useState(0)

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

  const handleParticleStats = useCallback(
    (n: number) => {
      if (showDebug) setParticles(n)
    },
    [showDebug],
  )

  // Face tracking shares the video element, so it can only begin once hand
  // tracking has the camera running. It is skipped entirely in collision mode:
  // that mode does not draw the face, and the model is not free to run.
  const start = useCallback(async () => {
    await startHands()
    if (mode === 'flame') startFace()
  }, [startHands, startFace, mode])

  const stop = useCallback(() => {
    stopFace()
    stopHands()
  }, [stopFace, stopHands])

  const handleDepth = useCallback(
    (d: number) => {
      if (showDebug) setDepth(d)
    },
    [showDebug],
  )

  const resetScene = useCallback(() => {
    fractalRef.current?.reset()
    particleRef.current?.reset()
    infiniteRef.current?.reset()
  }, [])

  return (
    <div className="app">
      {mode === 'flame' && (
        <FractalCanvas
          frameRef={frameRef}
          faceRef={faceRef}
          handleRef={fractalRef}
          onStats={handleStats}
        />
      )}
      {mode === 'collision' && (
        <ParticleCanvas
          frameRef={frameRef}
          handleRef={particleRef}
          onStats={handleParticleStats}
        />
      )}
      {INFINITE_MODES.includes(mode) && (
        <InfiniteCanvas
          frameRef={frameRef}
          variant={mode as 'logpolar' | 'droste' | 'kifs'}
          handleRef={infiniteRef}
          onStats={handleDepth}
        />
      )}

      {/* Kept mounted and hidden: MediaPipe reads pixels straight off this
          element, so it must exist and be playing whenever tracking runs. */}
      <video ref={videoRef} className="camera-feed" playsInline muted />

      {status.kind !== 'running' && (
        <div className="overlay">
          <div className="panel">
            <h1>Chillout Zone</h1>
            <p className="lead">
              Пять визуальных движков, управляемых руками через веб-камеру.
              Выберите режим, разрешите доступ к камере и поднимите ладони
              перед собой.
            </p>

            <div className="modes">
              <button
                className={mode === 'flame' ? 'mode active' : 'mode'}
                onClick={() => setMode('flame')}
              >
                <strong>Фрактальные пламёна</strong>
                <span>Светящиеся спирали, вырастающие из ладоней</span>
              </button>
              <button
                className={mode === 'collision' ? 'mode active' : 'mode'}
                onClick={() => setMode('collision')}
              >
                <strong>Столкновение</strong>
                <span>Частицы двух рук сталкиваются по-настоящему</span>
              </button>
              <button
                className={mode === 'logpolar' ? 'mode active' : 'mode'}
                onClick={() => setMode('logpolar')}
              >
                <strong>Бесконечные оболочки</strong>
                <span>Узор вечно растёт наружу, повторяя сам себя</span>
              </button>
              <button
                className={mode === 'droste' ? 'mode active' : 'mode'}
                onClick={() => setMode('droste')}
              >
                <strong>Спираль Дросте</strong>
                <span>Бесшовная спираль, замкнутая сама на себя</span>
              </button>
              <button
                className={mode === 'kifs' ? 'mode active' : 'mode'}
                onClick={() => setMode('kifs')}
              >
                <strong>Калейдоскоп</strong>
                <span>Складывание пространства: детали без предела</span>
              </button>
            </div>

            <ul className="hints">
              {mode === 'flame' ? (
                <>
                  <li>Обе руки — из каждой ладони растёт своя половина фрактала</li>
                  <li>Сведите ладони — формы упираются друг в друга</li>
                  <li>Раскрытая ладонь — спираль раскрывается и закручивается</li>
                  <li>Резкое движение — из руки выбрасываются нити</li>
                  <li>Поворот кисти вращает свою половину фигуры</li>
                  <li>Лицо подсвечивается тем же переливающимся контуром</li>
                  <li>Откройте рот — фрактал раскрывается</li>
                  <li>Поворот и наклон головы разворачивают всю фигуру</li>
                  <li>За зрачками тянется светящийся след</li>
                </>
              ) : mode === 'collision' ? (
                <>
                  <li>Из каждой ладони бьёт поток частиц своего цвета</li>
                  <li>Раскрытая ладонь притягивает частицы, кулак отталкивает</li>
                  <li>Соберите облако и толкните его в чужой поток</li>
                  <li>В точках удара частицы вспыхивают белым</li>
                  <li>Резкое движение рукой швыряет частицы вперёд</li>
                </>
              ) : (
                <>
                  <li>Ладонь задаёт центр, из которого растёт узор</li>
                  <li>Сжатый кулак — плотная вложенность, раскрытая — крупная</li>
                  <li>Поворот кисти закручивает спираль</li>
                  <li>Вторая рука меняет палитру</li>
                  <li>Быстрое движение ускоряет рост</li>
                </>
              )}
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
          <button onClick={resetScene}>Очистить</button>
          <button onClick={toggleFullscreen}>
            {isFullscreen ? 'Свернуть' : 'На весь экран'}
          </button>
          <button onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? 'Скрыть данные' : 'Показать данные'}
          </button>
          {showDebug && mode === 'flame' && stats && (
            <dl className="debug">
              <div><dt>выборок</dt><dd>{stats.tips}K</dd></div>
              <div><dt>глубина</dt><dd>{stats.params.depth.toFixed(1)}</dd></div>
              <div><dt>ветви</dt><dd>{stats.params.branches.toFixed(1)}</dd></div>
              <div><dt>разброс</dt><dd>{stats.params.spread.toFixed(2)}</dd></div>
              <div><dt>энергия</dt><dd>{stats.params.energy.toFixed(2)}</dd></div>
            </dl>
          )}
          {showDebug && mode === 'collision' && (
            <dl className="debug">
              <div><dt>частиц</dt><dd>{particles}</dd></div>
            </dl>
          )}
          {showDebug && INFINITE_MODES.includes(mode) && (
            <dl className="debug">
              <div><dt>глубина</dt><dd>{depth.toFixed(1)}</dd></div>
            </dl>
          )}
        </div>
      )}
    </div>
  )
}
