import { useState, useEffect } from 'react'
import { apiUrl } from '../config'

interface SourceEntry {
  label: string
  table: string
  url: string
}

type Sources = Record<string, SourceEntry>

export default function SourcesPage({ activeRace }: { activeRace: number | null }) {
  const [sources, setSources] = useState<Sources>({})
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [reloading, setReloading] = useState<Record<string, boolean>>({})
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(apiUrl('/api/sources'))
      .then(r => r.json())
      .then((data: Sources) => {
        setSources(data)
        setEdits(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.url])))
      })
      .catch(() => setError('Failed to load sources'))
  }, [])

  const isDirty = (key: string) => edits[key] !== sources[key]?.url

  const handleSave = async (key: string) => {
    setSaving(p => ({ ...p, [key]: true }))
    try {
      const res = await fetch(apiUrl(`/api/sources/${key}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: edits[key] }),
      })
      if (!res.ok) throw new Error(await res.text())
      setSources(p => ({ ...p, [key]: { ...p[key], url: edits[key] } }))
      setSavedKeys(p => { const n = new Set(p); n.add(key); return n })
      setTimeout(() => setSavedKeys(p => { const n = new Set(p); n.delete(key); return n }), 2000)
    } catch (e: any) {
      setError(`Save failed: ${e.message}`)
    } finally {
      setSaving(p => ({ ...p, [key]: false }))
    }
  }

  const handleReload = async (key: string) => {
    setReloading(p => ({ ...p, [key]: true }))
    try {
      const qs = activeRace && key !== 'live_bets' ? `?race_no=${activeRace}` : ''
      const res = await fetch(apiUrl(`/api/sources/${key}/reload${qs}`), { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
    } catch (e: any) {
      setError(`Reload failed: ${e.message}`)
    } finally {
      setTimeout(() => setReloading(p => ({ ...p, [key]: false })), 1200)
    }
  }

  // Group by table
  const grouped: Record<string, [string, SourceEntry][]> = {}
  for (const [key, entry] of Object.entries(sources)) {
    if (!grouped[entry.table]) grouped[entry.table] = []
    grouped[entry.table].push([key, entry])
  }

  const inputStyle: React.CSSProperties = {
    flex: 1,
    background: '#0f172a',
    border: '1px solid #334155',
    borderRadius: 6,
    padding: '7px 10px',
    color: '#e2e8f0',
    fontSize: 12,
    fontFamily: 'monospace',
    outline: 'none',
    minWidth: 0,
  }

  const btnStyle = (variant: 'save' | 'reload' | 'saved'): React.CSSProperties => ({
    padding: '6px 14px',
    borderRadius: 6,
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    background: variant === 'saved' ? '#14532d' : variant === 'save' ? '#1d4ed8' : '#334155',
    color: variant === 'saved' ? '#4ade80' : '#e2e8f0',
    opacity: variant === 'saved' ? 1 : undefined,
  })

  return (
    <div style={{ padding: '24px 20px', maxWidth: 900, margin: '0 auto' }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 }}>
        Data Sources
      </h2>
      <p style={{ fontSize: 13, color: '#64748b', marginBottom: 24 }}>
        Edit the URLs used to scrape each table. Changes take effect on the next reload.
      </p>

      {error && (
        <div style={{
          background: '#450a0a', border: '1px solid #7f1d1d', borderRadius: 6,
          padding: '10px 14px', color: '#fca5a5', fontSize: 12, marginBottom: 20,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          {error}
          <button onClick={() => setError(null)} style={{ background: 'none', border: 'none', color: '#fca5a5', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>×</button>
        </div>
      )}

      {Object.entries(grouped).map(([table, entries]) => (
        <section key={table} style={{ marginBottom: 28 }}>
          <div style={{
            fontSize: 12, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase',
            letterSpacing: '0.08em', marginBottom: 10, paddingBottom: 6,
            borderBottom: '1px solid #1e293b',
          }}>
            {table}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {entries.map(([key, entry]) => (
              <div key={key} style={{
                background: '#1e293b', borderRadius: 8, padding: '14px 16px',
              }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#cbd5e1', marginBottom: 10 }}>
                  {entry.label}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    style={inputStyle}
                    value={edits[key] ?? ''}
                    onChange={e => setEdits(p => ({ ...p, [key]: e.target.value }))}
                    spellCheck={false}
                  />
                  <a
                    href={edits[key]}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#60a5fa', fontSize: 18, lineHeight: 1, textDecoration: 'none', flexShrink: 0 }}
                    title="Open link"
                  >
                    ↗
                  </a>
                  {savedKeys.has(key) ? (
                    <button style={btnStyle('saved')} disabled>✓ Saved</button>
                  ) : (
                    <button
                      style={{ ...btnStyle('save'), opacity: (!isDirty(key) || saving[key]) ? 0.4 : 1 }}
                      disabled={!isDirty(key) || saving[key]}
                      onClick={() => handleSave(key)}
                    >
                      {saving[key] ? 'Saving…' : 'Save'}
                    </button>
                  )}
                  <button
                    style={{ ...btnStyle('reload'), opacity: reloading[key] ? 0.5 : 1 }}
                    disabled={reloading[key]}
                    onClick={() => handleReload(key)}
                    title={
                      key !== 'live_bets' && !activeRace
                        ? 'Select a race first'
                        : 'Reload data from this source'
                    }
                  >
                    {reloading[key] ? '…' : '↺ Reload'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
