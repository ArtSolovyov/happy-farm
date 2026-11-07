/**
 * Home.tsx — the page that hosts the game canvas.
 *
 * React only owns the DOM shell (canvas + HUD overlay); everything inside the
 * render loop lives under src/game/ and never re-renders React. Start the game
 * in an effect and tear it down in the cleanup so React StrictMode's
 * mount → unmount → mount cycle does not leak a second renderer or loop.
 */

import { useEffect, useRef } from 'react'
import { startGame, stopGame } from '@/game/boot'

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    startGame(canvas)
    return () => stopGame()
  }, [])

  return (
    <div id="game-root">
      <canvas id="game-canvas" ref={canvasRef} />
      <div id="ui-overlay" />
    </div>
  )
}
