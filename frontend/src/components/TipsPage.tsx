import { useCallback, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../config'
import { ExtractedResponse, TipImage, TipsAnalysisResponse, TrainerGridResponse } from '../types'

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
  const [venue, setVenue] = useState<string>('')
  const [meetings, setMeetings] = useState<string[]>([])
  const [extractorReady, setExtractorReady] = useState<boolean>(true)
  const [images, setImages] = useState<TipImage[]>([])
  const [analysis, setAnalysis] = useState<TipsAnalysisResponse | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploadCount, setUploadCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [uploadsExpanded, setUploadsExpanded] = useState(false)
  const [extracted, setExtracted] = useState<ExtractedResponse['extracted']>({})
  const [handles, setHandles] = useState<string[]>([])
  const [newHandle, setNewHandle] = useState('')
  const [handlesExpanded, setHandlesExpanded] = useState(false)
  const [autoFetching, setAutoFetching] = useState(false)
  const [editingFile, setEditingFile] = useState<string | null>(null)
  const [creatingText, setCreatingText] = useState(false)

  // Auto-pick today's meeting + venue from the trainer-grid summary
  useEffect(() => {
    fetch(apiUrl('/api/meeting/trainer-grid')).then(r => r.json()).then((d: TrainerGridResponse) => {
      if (d.summary?.race_date) setMeeting(d.summary.race_date)
      if (d.summary?.venue_name) setVenue(d.summary.venue_name)
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
      const [imgRes, exRes] = await Promise.all([
        fetch(apiUrl(`/api/tips/${meeting}/images`)),
        fetch(apiUrl(`/api/tips/${meeting}/extracted`)),
      ])
      if (imgRes.ok) {
        const d = await imgRes.json()
        setImages(d.images ?? [])
      }
      if (exRes.ok) {
        const d = await exRes.json()
        setExtracted(d.extracted ?? {})
      }
    } catch { /* ignore */ }
  }, [meeting])

  // Load Threads handles list
  const loadHandles = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/tips/handles'))
      if (!r.ok) return
      const d = await r.json()
      setHandles(d.handles ?? [])
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadHandles() }, [loadHandles])

  const addHandle = useCallback(async () => {
    const h = newHandle.trim()
    if (!h) return
    await fetch(apiUrl('/api/tips/handles'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: h }),
    })
    setNewHandle('')
    loadHandles()
  }, [newHandle, loadHandles])

  const removeHandle = useCallback(async (h: string) => {
    await fetch(apiUrl(`/api/tips/handles/${encodeURIComponent(h)}`), { method: 'DELETE' })
    loadHandles()
  }, [loadHandles])

  const triggerAutoFetch = useCallback(async () => {
    setAutoFetching(true)
    try {
      const qs = new URLSearchParams({ meeting_date: meeting })
      if (venue) qs.set('venue', venue)
      await fetch(apiUrl(`/api/tips/auto-fetch?${qs.toString()}`), { method: 'POST' })
    } finally {
      setTimeout(() => setAutoFetching(false), 2000)
    }
  }, [meeting, venue])

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
          {venue && <span style={{ color: '#cbd5e1', marginRight: 8 }}>📍 {venue}</span>}
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
              const results = r.results || {}
              const winnerHorse = results['1']
              const placedHorses = new Set<number>([
                ...(results['2'] !== undefined ? [results['2']] : []),
                ...(results['3'] !== undefined ? [results['3']] : []),
              ])
              const hasResults = Object.keys(results).length > 0

              const resultBadge = (hn: number) => {
                if (hn === winnerHorse) return { text: 'W', bg: '#16a34a', fg: '#fff' }
                if (placedHorses.has(hn)) return { text: 'Q', bg: '#2563eb', fg: '#fff' }
                return null
              }

              return (
                <section key={rn} style={{
                  background: '#1e293b', borderRadius: 8, padding: 14,
                  border: '1px solid #334155',
                }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 16, fontWeight: 700, color: '#93c5fd' }}>R{rn}</span>
                    {r.key_pick_consensus && (
                      <span style={{ fontSize: 13, color: '#fbbf24', fontWeight: 600 }}>
                        重心 #{r.key_pick_consensus.horse_no}
                        <span style={{ fontWeight: 400, marginLeft: 4, color: '#d97706' }}>
                          ({r.key_pick_consensus.votes} 票 · {r.key_pick_consensus.source_count} 來源)
                        </span>
                      </span>
                    )}
                    {hasResults && (
                      <span style={{
                        marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center',
                        background: '#0f172a', padding: '4px 10px', borderRadius: 6,
                        border: '1px solid #334155', fontSize: 13,
                      }}>
                        <span style={{ color: '#94a3b8', fontSize: 11, marginRight: 2 }}>賽果</span>
                        {(['1', '2', '3'] as const).map(pos => results[pos] !== undefined && (
                          <span key={pos} style={{ color: pos === '1' ? '#fde047' : '#cbd5e1' }}>
                            {pos === '1' ? '🥇' : pos === '2' ? '🥈' : '🥉'} #{results[pos]}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>

                  {/* Top 4 consensus */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                    {r.top4.map((h, i) => {
                      const inBetTop4 = r.bet_ranking.slice(0, 4).some(b => b.horse_no === h.horse_no)
                      const badge = resultBadge(h.horse_no)
                      const won = badge?.text === 'W'
                      const placed = badge?.text === 'Q'
                      return (
                        <div key={h.horse_no} style={{
                          background: won ? '#14532d' : placed ? '#1e3a8a' : (i === 0 ? '#1e3a8a' : '#0f172a'),
                          border: `${won || placed ? 2 : 1}px solid ${won ? '#22c55e' : placed ? '#3b82f6' : (inBetTop4 ? '#22c55e' : '#334155')}`,
                          borderRadius: 6, padding: '6px 10px', minWidth: 90,
                          position: 'relative',
                        }}>
                          <div style={{ fontSize: 11, color: '#64748b' }}>第 {i + 1} 位</div>
                          <div style={{ fontSize: 14, fontWeight: 700, color: '#f1f5f9', display: 'flex', alignItems: 'center', gap: 6 }}>
                            #{h.horse_no}
                            {badge && (
                              <span style={{
                                background: badge.bg, color: badge.fg,
                                fontSize: 10, fontWeight: 800, borderRadius: 3,
                                padding: '0 5px', lineHeight: '15px',
                              }}>{badge.text}</span>
                            )}
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
                      {r.bet_ranking.slice(0, 4).map((b, i) => {
                        const badge = resultBadge(b.horse_no)
                        return (
                          <span key={b.horse_no} style={{
                            color: badge?.text === 'W' ? '#22c55e' : badge?.text === 'Q' ? '#60a5fa' : '#cbd5e1',
                            fontWeight: badge ? 700 : 400,
                            marginRight: 10,
                          }}>
                            {i + 1}. #{b.horse_no}
                            {badge && <span style={{ marginLeft: 3, fontSize: 10 }}>{badge.text}</span>}
                            <span style={{ color: '#475569', marginLeft: 3 }}>
                              (${(b.total_bet / 1000).toFixed(0)}K)
                            </span>
                          </span>
                        )
                      })}
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

      {/* ── Source breakdown ─────────────────────────────────────────── */}
      <section style={{ marginTop: 28 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, color: '#cbd5e1', margin: 0 }}>
            各來源讀數 (Source Breakdown)
          </h3>
          <button
            onClick={() => setCreatingText(p => !p)}
            style={{
              marginLeft: 'auto',
              background: creatingText ? '#475569' : '#16a34a',
              color: '#fff', border: 'none', borderRadius: 6,
              padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}
          >
            {creatingText ? '✕ 取消' : '+ 加入文字貼士'}
          </button>
        </div>
        <p style={{ fontSize: 11, color: '#64748b', marginTop: 4, marginBottom: 12 }}>
          以下係系統從每個貼士截圖讀出嚟嘅原始數據。可以對照截圖核對準確性,或撳每張卡嘅「✎ 修正」手動更正。
        </p>

        {creatingText && (
          <div style={{ marginBottom: 14 }}>
            <TextSourceCreator
              meeting={meeting}
              onCancel={() => setCreatingText(false)}
              onSaved={() => { setCreatingText(false); loadImages() }}
            />
          </div>
        )}

        {Object.keys(extracted).length === 0 && !creatingText && (
          <div style={{
            padding: 20, textAlign: 'center', color: '#64748b', fontSize: 12,
            background: '#0f172a', borderRadius: 6, border: '1px dashed #334155',
          }}>
            未有任何貼士。上載截圖或撳「+ 加入文字貼士」貼入文字版貼士。
          </div>
        )}
        {Object.keys(extracted).length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 12 }}>
            {Object.entries(extracted).map(([filename, data]) => (
              <SourceCard
                key={filename}
                filename={filename}
                meeting={meeting}
                data={data}
                editing={editingFile === filename}
                onEdit={() => setEditingFile(filename)}
                onCancel={() => setEditingFile(null)}
                onSaved={() => { setEditingFile(null); loadImages() }}
              />
            ))}
          </div>
        )}
      </section>

      {/* ── Threads auto-fetch (handles list) ─────────────────────────── */}
      <section style={{ marginTop: 24, border: '1px solid #334155', borderRadius: 8, overflow: 'hidden' }}>
        <button
          onClick={() => setHandlesExpanded(p => !p)}
          style={{
            width: '100%', textAlign: 'left', padding: '12px 14px',
            background: '#1e293b', border: 'none', color: '#cbd5e1',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <span style={{ color: '#64748b' }}>{handlesExpanded ? '▾' : '▸'}</span>
          Threads 自動拉取 — 追蹤帳號清單
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#64748b', fontWeight: 400 }}>
            {handles.length} 個帳號
          </span>
        </button>
        {handlesExpanded && (
          <div style={{ padding: 14, background: '#0f172a' }}>
            <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
              系統會喺賽馬日早上自動瀏覽以下 Threads 帳號,拉取近 72 小時嘅貼士帖,
              下載相關截圖後自動分析。每個帳號之間間隔 75 秒以避開反爬蟲機制。
              {venue && (
                <span style={{ color: '#cbd5e1' }}>
                  &nbsp;只接受提到「{venue}」嘅帖文,自動過濾愛爾蘭/日本等海外賽事。
                </span>
              )}
            </p>
            <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
              <input
                type="text"
                value={newHandle}
                onChange={e => setNewHandle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addHandle() }}
                placeholder="加入新的 Threads handle (例如 yimu_1212)"
                style={{
                  flex: 1, background: '#1e293b', border: '1px solid #334155',
                  color: '#e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12,
                }}
              />
              <button
                onClick={addHandle}
                style={{
                  padding: '6px 14px', background: '#3b82f6', color: '#fff',
                  border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                }}
              >+ 加入</button>
              <button
                onClick={triggerAutoFetch}
                disabled={autoFetching || handles.length === 0}
                style={{
                  padding: '6px 14px', background: '#16a34a', color: '#fff',
                  border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700,
                  cursor: autoFetching ? 'wait' : 'pointer', opacity: autoFetching ? 0.5 : 1,
                }}
              >
                {autoFetching ? '啟動中…' : '⚡ 即時拉取'}
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {handles.map(h => (
                <span key={h} style={{
                  background: '#1e293b', border: '1px solid #334155',
                  borderRadius: 12, padding: '4px 10px', fontSize: 12, color: '#cbd5e1',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                }}>
                  <a
                    href={`https://www.threads.com/@${h}`}
                    target="_blank" rel="noopener noreferrer"
                    style={{ color: '#93c5fd', textDecoration: 'none' }}
                  >@{h}</a>
                  <button
                    onClick={() => removeHandle(h)}
                    title="移除"
                    style={{
                      background: 'none', border: 'none', color: '#94a3b8',
                      cursor: 'pointer', fontSize: 13, padding: 0,
                    }}
                  >×</button>
                </span>
              ))}
              {handles.length === 0 && (
                <span style={{ color: '#64748b', fontSize: 12 }}>未有帳號,加入一個試試。</span>
              )}
            </div>
          </div>
        )}
      </section>

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


// ── Source card with inline edit ────────────────────────────────────────

interface SourceCardProps {
  filename: string
  meeting: string
  data: import('../types').ExtractedImageData & { edited?: boolean }
  editing: boolean
  onEdit: () => void
  onCancel: () => void
  onSaved: () => void
}

function SourceCard({ filename, meeting, data, editing, onEdit, onCancel, onSaved }: SourceCardProps) {
  const races = Object.entries(data.races || {})
    .sort((a, b) => parseInt(a[0]) - parseInt(b[0]))

  if (editing) {
    return (
      <SourceEditor
        filename={filename}
        meeting={meeting}
        data={data}
        onCancel={onCancel}
        onSaved={onSaved}
      />
    )
  }

  const textOnly = (data as any).text_only === true
  return (
    <div style={{
      background: '#1e293b', border: '1px solid #334155', borderRadius: 8,
      padding: 10, display: 'flex', gap: 10,
    }}>
      {textOnly ? (
        <div style={{
          width: 80, height: 110, borderRadius: 4, flexShrink: 0,
          background: '#0f172a', border: '1px dashed #334155',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, color: '#64748b', textAlign: 'center', padding: 4,
        }}>📝 文字<br />貼士</div>
      ) : (
        <img
          src={apiUrl(`/api/tips/${meeting}/image/${filename}`)}
          alt={filename}
          style={{ width: 80, height: 110, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {data.source_name || filename}
          </span>
          {(data as any).edited && (
            <span style={{ fontSize: 9, color: '#fbbf24', fontWeight: 700 }} title="人手校正">✎</span>
          )}
          <button
            onClick={onEdit}
            title="修正讀數"
            style={{
              background: '#334155', border: 'none', color: '#cbd5e1',
              fontSize: 10, padding: '2px 8px', borderRadius: 4, cursor: 'pointer',
            }}
          >✎ 修正</button>
        </div>
        <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6, wordBreak: 'break-all' }}>
          {filename}
        </div>
        {races.length > 0 ? (
          <div style={{ display: 'grid', gap: 2 }}>
            {races.map(([rn, pick]) => (
              <div key={rn} style={{ fontSize: 12, color: '#e2e8f0' }}>
                <span style={{ color: '#94a3b8', marginRight: 6 }}>R{rn}</span>
                <span style={{ fontFamily: 'monospace' }}>
                  {(pick.top4 || []).join(' · ')}
                </span>
                {pick.key_pick !== null && pick.key_pick !== undefined && (
                  <span style={{ color: '#fbbf24', marginLeft: 6 }}>
                    ★{pick.key_pick}
                  </span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: 11, color: '#7f1d1d' }}>
            ⚠ 未能讀取賽事數據 — 撳「修正」手動輸入
          </div>
        )}
      </div>
    </div>
  )
}


// Inline editor. Per-race input format: "1,2,3,4 *1" — first 4 comma- or
// space-separated numbers are top4, an optional " *N" or "★N" is the key.
function SourceEditor({
  filename, meeting, data, onCancel, onSaved,
}: {
  filename: string
  meeting: string
  data: import('../types').ExtractedImageData
  onCancel: () => void
  onSaved: () => void
}) {
  // Seed editor rows from existing races, plus an empty row for R12 if missing
  const initialRows: Record<string, string> = {}
  for (let n = 1; n <= 12; n++) {
    const pick = data.races?.[String(n)]
    if (!pick) {
      initialRows[String(n)] = ''
      continue
    }
    const top4 = (pick.top4 || []).slice(0, 4).join(',')
    const key = pick.key_pick !== null && pick.key_pick !== undefined ? ` *${pick.key_pick}` : ''
    initialRows[String(n)] = `${top4}${key}`
  }
  const [sourceName, setSourceName] = useState(data.source_name || '')
  const [rows, setRows] = useState<Record<string, string>>(initialRows)
  const [saving, setSaving] = useState(false)
  const [pasteText, setPasteText] = useState('')

  // Parse a free-form text feed (e.g. "R1: 2-10-8-3 \n R2: 1-7-6-4 ...")
  // and overwrite the per-race input rows. Same regex shape as backend's
  // parse_text_tips so the formats stay in sync.
  const parseAndFill = () => {
    if (!pasteText.trim()) return
    const next = { ...rows }
    for (const raw of pasteText.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const m = line.match(/^(?:R|r|第)\s*(\d+)\s*(?:場)?\s*[:：/.、\-\s]+(.*)$/)
      if (!m) continue
      const rn = m[1]
      let rest = m[2].replace(/[\[【].*?[\]】]/g, ' ')
      let key: number | null = null
      const km = rest.match(/[\*★]\s*(\d+)/)
      if (km) {
        key = parseInt(km[1])
        rest = rest.replace(km[0], '')
      }
      const nums = (rest.match(/\d+/g) || [])
        .map(s => parseInt(s))
        .filter(n => n >= 1 && n < 100)
        .slice(0, 4)
      if (nums.length === 0) continue
      next[rn] = `${nums.join(',')}${key !== null ? ` *${key}` : ''}`
    }
    setRows(next)
    setPasteText('')
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const races: Record<string, { top4: number[]; key_pick: number | null }> = {}
      for (const [rn, raw] of Object.entries(rows)) {
        const text = raw.trim()
        if (!text) continue
        // Split off the key pick (after * or ★)
        let body = text, key: number | null = null
        const km = text.match(/[\*★]\s*(\d+)/)
        if (km) {
          key = parseInt(km[1])
          body = text.replace(km[0], '')
        }
        const nums = body.split(/[\s,，·\-]+/)
          .map(s => parseInt(s.trim()))
          .filter(n => !isNaN(n) && n > 0 && n < 100)
          .slice(0, 4)
        if (nums.length === 0) continue
        races[rn] = { top4: nums, key_pick: key }
      }
      const payload = { source_name: sourceName.trim() || null, races }
      const r = await fetch(apiUrl(`/api/tips/${meeting}/extracted/${filename}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!r.ok) throw new Error(await r.text())
      onSaved()
    } catch (e: any) {
      alert('Save failed: ' + (e?.message ?? 'unknown'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      background: '#1e293b', border: '2px solid #3b82f6', borderRadius: 8,
      padding: 10, display: 'flex', gap: 10,
    }}>
      <img
        src={apiUrl(`/api/tips/${meeting}/image/${filename}`)}
        alt={filename}
        style={{ width: 80, height: 110, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input
            type="text"
            value={sourceName}
            onChange={e => setSourceName(e.target.value)}
            placeholder="來源名稱"
            style={{
              flex: 1, background: '#0f172a', border: '1px solid #334155',
              color: '#e2e8f0', borderRadius: 4, padding: '4px 8px', fontSize: 12,
            }}
          />
        </div>
        <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6 }}>
          格式: <code style={{ color: '#cbd5e1' }}>1,2,3,4 *1</code> — 前 4 個馬號 + 星號後係重心 (可選)
        </div>

        {/* Paste-to-fill textarea */}
        <div style={{ marginBottom: 8 }}>
          <textarea
            value={pasteText}
            onChange={e => setPasteText(e.target.value)}
            placeholder={"貼上文字貼士 (例如):\nR1: 2-10-8-3\nR2: 1-7-6-4\nR3: 1-6-10-2"}
            rows={4}
            style={{
              width: '100%', background: '#0f172a', border: '1px solid #334155',
              color: '#e2e8f0', borderRadius: 4, padding: '4px 8px', fontSize: 11,
              fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
          <button
            onClick={parseAndFill}
            disabled={!pasteText.trim()}
            style={{
              marginTop: 4, padding: '3px 10px', background: '#0891b2',
              color: '#fff', border: 'none', borderRadius: 4, fontSize: 11,
              fontWeight: 700, cursor: pasteText.trim() ? 'pointer' : 'not-allowed',
              opacity: pasteText.trim() ? 1 : 0.5,
            }}
          >↧ 解析並填入</button>
        </div>
        <div style={{ display: 'grid', gap: 3, marginBottom: 8 }}>
          {Object.entries(rows).map(([rn, val]) => (
            <div key={rn} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, color: '#94a3b8', minWidth: 24 }}>R{rn}</span>
              <input
                type="text"
                value={val}
                onChange={e => setRows(prev => ({ ...prev, [rn]: e.target.value }))}
                placeholder="(空)"
                style={{
                  flex: 1, background: '#0f172a', border: '1px solid #334155',
                  color: '#e2e8f0', borderRadius: 4, padding: '3px 8px',
                  fontSize: 12, fontFamily: 'monospace',
                }}
              />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={handleSave}
            disabled={saving}
            style={{
              flex: 1, background: '#3b82f6', color: '#fff', border: 'none',
              borderRadius: 4, padding: '5px 10px', fontSize: 11, fontWeight: 700,
              cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
            }}
          >{saving ? '儲存中…' : '✓ 儲存'}</button>
          <button
            onClick={onCancel}
            disabled={saving}
            style={{
              flex: 1, background: '#475569', color: '#e2e8f0', border: 'none',
              borderRadius: 4, padding: '5px 10px', fontSize: 11, fontWeight: 700,
              cursor: 'pointer',
            }}
          >取消</button>
        </div>
      </div>
    </div>
  )
}


// Standalone form for adding a new text-only tipster source from a pasted feed.
function TextSourceCreator({
  meeting, onCancel, onSaved,
}: { meeting: string; onCancel: () => void; onSaved: () => void }) {
  const [sourceName, setSourceName] = useState('')
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    if (!sourceName.trim() || !text.trim()) {
      alert('請輸入來源名稱同貼士文字')
      return
    }
    setSaving(true)
    try {
      const r = await fetch(apiUrl(`/api/tips/${meeting}/text-source`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_name: sourceName.trim(), text }),
      })
      if (!r.ok) throw new Error(await r.text())
      onSaved()
    } catch (e: any) {
      alert('Save failed: ' + (e?.message ?? 'unknown'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      background: '#1e293b', border: '2px solid #16a34a', borderRadius: 8,
      padding: 14,
    }}>
      <h4 style={{ fontSize: 13, fontWeight: 700, color: '#cbd5e1', margin: 0, marginBottom: 8 }}>
        加入文字貼士
      </h4>
      <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        貼上 Threads 帖文嘅文字內容,系統會自動解析每場嘅馬號。每行格式:
        <code style={{ marginLeft: 4, color: '#cbd5e1' }}>R1: 2-10-8-3</code>。
        重心 (可選) 用 <code style={{ color: '#cbd5e1' }}>*N</code> 或 <code style={{ color: '#cbd5e1' }}>★N</code> 標示。
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '0 0 200px' }}>
          <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
            來源名稱
          </label>
          <input
            type="text"
            value={sourceName}
            onChange={e => setSourceName(e.target.value)}
            placeholder="例:@yimu_1212"
            style={{
              width: '100%', background: '#0f172a', border: '1px solid #334155',
              color: '#e2e8f0', borderRadius: 4, padding: '6px 10px', fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ flex: 1, minWidth: 280 }}>
          <label style={{ fontSize: 11, color: '#94a3b8', display: 'block', marginBottom: 4 }}>
            貼士文字
          </label>
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={'R1: 2-10-8-3\nR2: 1-7-6-4\nR3: 1-6-10-2\nR4: 5-3-7-1\n...'}
            rows={9}
            style={{
              width: '100%', background: '#0f172a', border: '1px solid #334155',
              color: '#e2e8f0', borderRadius: 4, padding: '6px 10px', fontSize: 12,
              fontFamily: 'monospace', resize: 'vertical', boxSizing: 'border-box',
            }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '6px 16px', background: '#16a34a', color: '#fff',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700,
            cursor: saving ? 'wait' : 'pointer', opacity: saving ? 0.6 : 1,
          }}
        >{saving ? '儲存中…' : '✓ 加入'}</button>
        <button
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: '6px 16px', background: '#475569', color: '#e2e8f0',
            border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 700,
            cursor: 'pointer',
          }}
        >取消</button>
      </div>
    </div>
  )
}
