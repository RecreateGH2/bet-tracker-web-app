import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../config'
import { TipImage, TipsAnalysisResponse, TrainerGridResponse } from '../types'

interface MeetingsResponse { meetings: string[]; extractor_ready: boolean }

// Auto-refresh analysis at most every 15 min (matches backend cache TTL).
const ANALYSIS_POLL_MS = 15 * 60 * 1000
// Image list polling stays fast — it's a cheap filesystem listing.
const IMAGES_POLL_MS = 5 * 1000

function todayISO(): string {
  // Returns YYYY-MM-DD in HKT for the default meeting day picker.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Hong_Kong',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

export default function TipsPage() {
  const [meeting, setMeeting] = useState<string>(todayISO())
  const [meetings, setMeetings] = useState<string[]>([])
  const [extractorReady, setExtractorReady] = useState<boolean>(true)
  const [images, setImages] = useState<TipImage[]>([])
  const [analysis, setAnalysis] = useState<TipsAnalysisResponse | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadCount, setUploadCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [uploadsExpanded, setUploadsExpanded] = useState(false)

  // Auto-pick today's meeting from the trainer-grid summary if available
  useEffect(() => {
    fetch(apiUrl('/api/meeting/trainer-grid')).then(r => r.json()).then((d: TrainerGridResponse) => {
      if (d.summary?.race_date) setMeeting(d.summary.race_date)
    }).catch(() => {})
  }, [])

  // Load list of historical meetings (for the dropdown)
  useEffect(() => {
    fetch(apiUrl('/api/tips/meetings')).then(r => r.json()).then((d: MeetingsResponse) => {
      setMeetings(d.meetings)
      setExtractorReady(d.extractor_ready)
    }).catch(() => {})
  }, [uploadCount])

  // Load uploaded images for the currently selected meeting (polled while
  // extractions are still pending so the UI updates as they complete)
  const loadImages = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/api/tips/${meeting}/images`))
      if (!res.ok) return
      const d = await res.json()
      setImages(d.images ?? [])
    } catch { /* ignore */ }
  }, [meeting])

  useEffect(() => {
    loadImages()
    const id = setInterval(loadImages, IMAGES_POLL_MS)
    return () => clearInterval(id)
  }, [loadImages])

  const handleFiles = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setError(null)
    for (const file of Array.from(files)) {
      const fd = new FormData()
      fd.append('file', file)
      try {
        const r = await fetch(apiUrl(`/api/tips/${meeting}/upload`), { method: 'POST', body: fd })
        if (!r.ok) throw new Error(`upload failed: ${file.name}`)
      } catch (e: any) {
        setError(e?.message ?? 'upload error')
      }
    }
    setUploadCount(c => c + 1)
    loadImages()
  }, [meeting, loadImages])

  const handleDelete = useCallback(async (filename: string) => {
    if (!confirm(`Delete ${filename}?`)) return
    await fetch(apiUrl(`/api/tips/${meeting}/${filename}`), { method: 'DELETE' })
    loadImages()
  }, [meeting, loadImages])

  const handleReExtract = useCallback(async (filename: string) => {
    await fetch(apiUrl(`/api/tips/${meeting}/re-extract/${filename}`), { method: 'POST' })
    loadImages()
  }, [meeting, loadImages])

  const runAnalysis = useCallback(async (force = false) => {
    setAnalyzing(true)
    try {
      const u = force
        ? apiUrl(`/api/tips/${meeting}/analysis?force=true`)
        : apiUrl(`/api/tips/${meeting}/analysis`)
      const r = await fetch(u)
      if (!r.ok) throw new Error('analysis failed')
      setAnalysis(await r.json())
    } catch (e: any) {
      setError(e?.message ?? 'analysis error')
    } finally {
      setAnalyzing(false)
    }
  }, [meeting])

  // Fetch analysis on meeting change, then refresh at most every 15 min
  // (matches backend cache). The cache lets us safely re-fetch — if the
  // window is still warm we just read the cached object.
  useEffect(() => {
    runAnalysis(false)
    const id = setInterval(() => runAnalysis(false), ANALYSIS_POLL_MS)
    return () => clearInterval(id)
  }, [runAnalysis])

  const extractedCount = images.filter(i => i.extracted).length
  const meetingOptions = useMemo(() => {
    const s = new Set(meetings)
    s.add(meeting)
    s.add(todayISO())
    return Array.from(s).sort().reverse()
  }, [meetings, meeting])

  return (
    <div style={{ padding: '20px 24px', maxWidth: 1200, margin: '0 auto' }}>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>
        馬王貼士
      </h2>
      <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 18 }}>
        上載各家貼士截圖,系統會自動分析共識頭馬同大票房入飛比較。
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ fontSize: 12, color: '#94a3b8' }}>賽馬日:</label>
        <select
          value={meeting}
          onChange={e => setMeeting(e.target.value)}
          style={{
            background: '#0f172a', color: '#e2e8f0',
            border: '1px solid #334155', borderRadius: 6,
            padding: '6px 10px', fontSize: 13,
          }}
        >
          {meetingOptions.map(m => (<option key={m} value={m}>{m}</option>))}
        </select>
        <span style={{ fontSize: 12, color: '#64748b' }}>
          {images.length} 張圖 · {extractedCount} 張已分析
        </span>
        {!extractorReady && (
          <span style={{ fontSize: 11, color: '#f59e0b' }}>
            ⚠ 後台未設定 ANTHROPIC_API_KEY — 上載後不會自動讀取貼士。
          </span>
        )}
        <button
          onClick={() => runAnalysis(true)}
          disabled={analyzing || extractedCount === 0}
          style={{
            marginLeft: 'auto',
            padding: '6px 14px', borderRadius: 6, border: 'none',
            background: extractedCount === 0 ? '#475569' : '#3b82f6',
            color: '#fff', fontSize: 12, fontWeight: 700,
            cursor: extractedCount === 0 ? 'not-allowed' : 'pointer',
          }}
          title="跳過快取,即時重新分析"
        >
          {analyzing ? '分析中…' : '重新分析'}
        </button>
      </div>

      <p style={{ fontSize: 11, color: '#64748b', marginTop: -8, marginBottom: 14 }}>
        分析每 15 分鐘自動更新一次。按「重新分析」可即時刷新。
      </p>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6,
          padding: '8px 12px', color: '#fca5a5', fontSize: 12, marginBottom: 14,
        }}>
          {error}
        </div>
      )}

      {/* Analysis */}
      {analysis && Object.keys(analysis.races).length > 0 && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#cbd5e1', marginBottom: 8 }}>
            共識分析 (合共 {analysis.source_count} 個來源)
          </h3>
          <div style={{ display: 'grid', gap: 12 }}>
            {Object.keys(analysis.races).sort((a, b) => parseInt(a) - parseInt(b)).map(rn => {
              const r = analysis.races[rn]
              const summary = analysis.summaries[rn] || ''
              return (
                <section key={rn} style={{
                  background: '#1e293b', borderRadius: 8, padding: 14,
                  border: '1px solid #334155',
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10 }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: '#93c5fd' }}>R{rn}</span>
                    {r.key_pick_consensus && (
                      <span style={{ fontSize: 12, color: '#fbbf24' }}>
                        重心 #{r.key_pick_consensus.horse_no} ({r.key_pick_consensus.votes} 來源)
                      </span>
                    )}
                  </div>

                  {/* Top 4 consensus */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    {r.top4.map((h, i) => {
                      const inBetTop4 = r.bet_ranking.slice(0, 4).some(b => b.horse_no === h.horse_no)
                      return (
                        <div key={h.horse_no} style={{
                          background: i === 0 ? '#1e3a8a' : '#0f172a',
                          border: `1px solid ${inBetTop4 ? '#22c55e' : '#334155'}`,
                          borderRadius: 6, padding: '6px 10px', minWidth: 90,
                        }}>
                          <div style={{ fontSize: 11, color: '#64748b' }}>第 {i + 1} 位</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9' }}>
                            #{h.horse_no}
                          </div>
                          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                            {h.votes} 票 / {h.sources.length} 來源
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Bet ranking row */}
                  {r.bet_ranking.length > 0 && (
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8 }}>
                      大票房入飛排名:&nbsp;
                      {r.bet_ranking.slice(0, 4).map((b, i) => (
                        <span key={b.horse_no} style={{ color: '#cbd5e1', marginRight: 10 }}>
                          {i + 1}. #{b.horse_no} (${(b.total_bet / 1000).toFixed(0)}K)
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Generated summary */}
                  {summary && (
                    <div style={{
                      fontSize: 14, color: '#e2e8f0', lineHeight: 1.6,
                      background: '#0f172a', borderRadius: 6, padding: 12,
                      borderLeft: '3px solid #3b82f6',
                    }}>
                      {summary}
                    </div>
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )}

      {!analysis && images.length > 0 && extractedCount === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
          {extractorReady
            ? '貼士分析中,請稍候…'
            : '請設定 POE_API_KEY 後再重試。'}
        </div>
      )}

      {/* ── Upload & uploaded list — collapsed at bottom ─────────────── */}
      <section style={{ marginTop: 28, border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setUploadsExpanded(p => !p)}
          style={{
            width: '100%', textAlign: 'left', padding: '12px 14px',
            background: '#1e293b', border: 'none', color: '#cbd5e1',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span style={{ color: '#64748b' }}>{uploadsExpanded ? '▾' : '▸'}</span>
          上載 / 管理貼士
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b', fontWeight: 400 }}>
            {images.length} 張 ({extractedCount} 已分析)
          </span>
        </button>

        {uploadsExpanded && (
          <div style={{ padding: 14, background: '#0f172a' }}>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
              style={{
                border: `2px dashed ${dragOver ? '#3b82f6' : '#334155'}`,
                background: dragOver ? '#1e293b' : '#172032',
                borderRadius: 10, padding: 20,
                textAlign: 'center', marginBottom: 14,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <div style={{ fontSize: 13, color: '#cbd5e1', marginBottom: 6 }}>
                📥 將貼士截圖拖到呢度,或者
              </div>
              <label style={{
                display: 'inline-block',
                padding: '6px 14px', borderRadius: 6, cursor: 'pointer',
                background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 700,
              }}>
                選擇檔案
                <input
                  type="file" multiple accept="image/png,image/jpeg"
                  onChange={e => handleFiles(e.target.files)}
                  style={{ display: 'none' }}
                />
              </label>
            </div>

            {images.length > 0 && (
              <div>
                <h3 style={{ fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 8 }}>
                  已上載貼士
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {images.map(img => (
                    <div key={img.filename} style={{
                      background: '#1e293b', borderRadius: 8, padding: 8,
                      border: '1px solid #334155', fontSize: 11,
                    }}>
                      <img
                        src={apiUrl(`/api/tips/${meeting}/image/${img.filename}`)}
                        alt={img.filename}
                        style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 4, marginBottom: 6 }}
                      />
                      <div style={{ color: '#e2e8f0', fontWeight: 600, marginBottom: 2 }}>
                        {img.source_name || img.filename}
                      </div>
                      <div style={{ color: '#64748b' }}>
                        {img.extracted
                          ? `✓ ${img.race_count} 場已讀取`
                          : (extractorReady ? '⏳ 分析中…' : '✗ 未分析')}
                      </div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        <button
                          onClick={() => handleReExtract(img.filename)}
                          style={{ flex: 1, fontSize: 10, padding: '3px 6px', background: '#334155', border: 'none', color: '#cbd5e1', borderRadius: 4, cursor: 'pointer' }}
                        >↺ 重讀</button>
                        <button
                          onClick={() => handleDelete(img.filename)}
                          style={{ flex: 1, fontSize: 10, padding: '3px 6px', background: '#7f1d1d', border: 'none', color: '#fecaca', borderRadius: 4, cursor: 'pointer' }}
                        >✕ 刪除</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
