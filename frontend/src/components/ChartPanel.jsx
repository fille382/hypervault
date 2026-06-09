import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries } from 'lightweight-charts'
import { getCandles } from '../api.js'

const TIMEFRAMES = [
  { label: '5m', value: '5m' },
  { label: '15m', value: '15m' },
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1D', value: '1d' },
  { label: '3D', value: '3d' },
]

// How many candles to load per timeframe (more bars = more history depth).
const BARS = { '5m': 300, '15m': 400, '1h': 500, '4h': 500, '1d': 700, '3d': 500 }

// TradingView-style candlestick chart fed by Hyperliquid's own candle data.
export default function ChartPanel({ coin, position }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const linesRef = useRef([])
  const [timeframe, setTimeframe] = useState('1h')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  // Create the chart once.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#8a9aa0', fontSize: 11 },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      timeScale: { borderColor: '#1a2a2d', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1a2a2d' },
      crosshair: { mode: 1 },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#34e2a8',
      downColor: '#ff5d73',
      wickUpColor: '#34e2a8',
      wickDownColor: '#ff5d73',
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      linesRef.current = []
    }
  }, [])

  // Load candles whenever the coin or timeframe changes.
  useEffect(() => {
    if (!coin || !seriesRef.current) return undefined
    let cancelled = false
    setLoading(true)
    setErr(null)
    getCandles(coin, timeframe, BARS[timeframe] || 300)
      .then((data) => {
        if (cancelled || !seriesRef.current) return
        seriesRef.current.setData(data.candles || [])
        chartRef.current?.timeScale().fitContent()
      })
      .catch((e) => {
        if (!cancelled) setErr(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [coin, timeframe])

  // Entry / liquidation price lines from the selected position.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    linesRef.current.forEach((l) => series.removePriceLine(l))
    linesRef.current = []
    if (!position) return
    if (position.entryPx) {
      linesRef.current.push(
        series.createPriceLine({
          price: position.entryPx,
          color: position.side === 'short' ? '#ff5d73' : '#34e2a8',
          lineStyle: 2,
          lineWidth: 1,
          axisLabelVisible: true,
          title: 'Entry',
        }),
      )
    }
    if (position.liquidationPx) {
      linesRef.current.push(
        series.createPriceLine({
          price: position.liquidationPx,
          color: '#ff5d73',
          lineStyle: 3,
          lineWidth: 1,
          axisLabelVisible: true,
          title: 'Liq',
        }),
      )
    }
  }, [position, coin, timeframe])

  return (
    <div className="chart-panel">
      <div className="chart-head">
        <div className="chart-title">
          {coin ? (
            <>
              <span className="ct-coin">{coin}</span>
              <span className="ct-sub">· Hyperliquid</span>
            </>
          ) : (
            'Select a coin'
          )}
        </div>
        <div className="chart-intervals">
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              className={`iv ${timeframe === tf.value ? 'active' : ''}`}
              onClick={() => setTimeframe(tf.value)}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-wrap">
        <div className="chart-body" ref={containerRef} />
        {loading && <div className="chart-status">loading…</div>}
        {err && <div className="chart-status err">chart error: {err}</div>}
      </div>
    </div>
  )
}
