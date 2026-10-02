import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

const panel = { position: 'fixed', bottom: 80, right: 16, width: 360, maxHeight: '75vh', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #ddd', borderRadius: 12, boxShadow: '0 4px 20px #0003', zIndex: 1000, fontFamily: 'system-ui, sans-serif', fontSize: 14 }
const small = { fontSize: 12, color: '#555' }

const GREETING = {
  role: 'agent',
  text: 'Γεια! Μετά από κάθε ανέβασμα ελέγχω μόνος μου αν ο ανιχνευτής έχασε κάτι. Αν δεις κάτι που δεν αναγνωρίζεται καλά (π.χ. "δεν βλέπει τις μπότες μου"), πες μου και βελτιώνω τον ανιχνευτή για τον λογαριασμό σου.',
}

function statusLabel(p) {
  if (p.status === 'active') return '✅ Ενεργή για τον λογαριασμό σου'
  if (p.status === 'rejected') return '⛔ Δεν ενεργοποιήθηκε (χειροτέρευε την ανίχνευση)'
  if (p.status === 'disabled') return '⏸ Απενεργοποιημένη'
  return '⏳ Δοκιμάζεται…'
}

export default function SupportChat() {
  const [open, setOpen] = useState(false)
  const [msgs, setMsgs] = useState([GREETING])
  const [input, setInput] = useState('')
  const [imageId, setImageId] = useState('')
  const [images, setImages] = useState([])
  const [busy, setBusy] = useState(false)
  const [unread, setUnread] = useState(0)
  const [hints, setHints] = useState(null) // null = κρυφή λίστα
  const endRef = useRef(null)
  const openRef = useRef(open)
  openRef.current = open

  const push = useCallback((m) => setMsgs((list) => [...list, m]), [])

  const loadImages = useCallback((preselect) => {
    api('/api/images')
      .then((list) => {
        const byKey = new Map()
        for (const r of list) {
          const key = r.sourceUrl || (r.url?.startsWith('/uploads/') ? r.url : null)
          if (!key) continue
          // Αν η επιλεγμένη εγγραφή ανήκει στην ίδια φωτογραφία, την προτιμάμε
          if (!byKey.has(key) || r.id === preselect) byKey.set(key, r)
        }
        setImages([...byKey.values()].slice(0, 30))
      })
      .catch(() => {})
  }, [])

  // Οδηγίες που πρόσθεσε ο agent μόνος του μετά από upload
  const checkUpdates = useCallback(async () => {
    try {
      const rules = await api('/api/support/updates')
      if (!rules.length) return false
      for (const r of rules) {
        const t = r.test_result
        push({
          role: 'agent',
          text: `Κοίταξα την τελευταία σου φωτογραφία και πρόσθεσα μόνος μου μια οδηγία για τον λογαριασμό σου:\n“${r.rule_text}”${t ? `\n(δοκιμή: ${t.before} → ${t.after} αντικείμενα)` : ''}`,
          reanalyzeId: r.source_image_id,
        })
      }
      await api('/api/support/updates/ack', { method: 'POST' })
      if (!openRef.current) setUnread((n) => n + rules.length)
      return true
    } catch {
      return false
    }
  }, [push])

  useEffect(() => { checkUpdates() }, [checkUpdates])

  useEffect(() => {
    if (open) { setUnread(0); loadImages(imageId) }
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [msgs])

  // Γεγονότα από το App: "λάθος ανίχνευση" σε κάρτα, ή ανέβασμα που τελείωσε
  useEffect(() => {
    let timer
    const onOpen = (e) => {
      const { imageId: id, text } = e.detail || {}
      setOpen(true)
      if (id) { setImageId(id); loadImages(id) }
      if (text) push({ role: 'agent', text })
    }
    const onUploaded = () => {
      // ο έλεγχος μετά το upload τρέχει στο παρασκήνιο· ρωτάμε λίγες φορές
      let tries = 0
      clearInterval(timer)
      timer = setInterval(async () => {
        tries += 1
        if ((await checkUpdates()) || tries >= 15) clearInterval(timer)
      }, 8000)
    }
    window.addEventListener('support:open', onOpen)
    window.addEventListener('catalog:uploaded', onUploaded)
    return () => {
      clearInterval(timer)
      window.removeEventListener('support:open', onOpen)
      window.removeEventListener('catalog:uploaded', onUploaded)
    }
  }, [checkUpdates, loadImages, push])

  async function reanalyze(id) {
    push({ role: 'agent', text: 'Ξαναδοκιμάζω τη φωτογραφία με τις νέες οδηγίες…' })
    try {
      const r = await api(`/api/images/${id}/reanalyze`, { method: 'POST' })
      push({
        role: 'agent',
        text: r.added.length
          ? `Βρήκα ${r.added.length} νέα αντικείμενα και τα πρόσθεσα στον κατάλογο.`
          : 'Δεν βρέθηκε κάτι καινούργιο σε αυτή τη φωτογραφία.',
      })
      window.dispatchEvent(new Event('catalog:refresh'))
    } catch (err) {
      push({ role: 'agent', text: err.message })
    }
  }

  function pollProposal(id, imgId, tries = 0) {
    if (tries > 30) return
    setTimeout(async () => {
      try {
        const list = await api('/api/support/proposals')
        const found = list.find((p) => p.id === id)
        if (!found) return
        setMsgs((m) => m.map((x) => (x.proposal?.id === id ? { ...x, proposal: { ...x.proposal, ...found } } : x)))
        if (found.status === 'pending') return pollProposal(id, imgId, tries + 1)
        if (found.status === 'active' && imgId) {
          push({ role: 'agent', text: 'Η οδηγία πέρασε τον έλεγχο και είναι ενεργή. Θέλεις να ξαναδοκιμάσω τη φωτογραφία;', reanalyzeId: imgId })
        }
      } catch { /* ignore */ }
    }, 4000)
  }

  async function send() {
    const text = input.trim()
    if (!text || busy) return
    const history = msgs.slice(-6).map(({ role, text }) => ({ role, text }))
    push({ role: 'user', text })
    setInput('')
    setBusy(true)
    try {
      const r = await api('/api/support/chat', { method: 'POST', body: { message: text, imageId: imageId || undefined, history } })
      push({ role: 'agent', text: r.reply, proposal: r.proposal })
      if (r.proposal?.status === 'pending') pollProposal(r.proposal.id, imageId)
    } catch (err) {
      push({ role: 'agent', text: err.message })
    } finally {
      setBusy(false)
    }
  }

  async function toggleHints() {
    if (hints) return setHints(null)
    try { setHints(await api('/api/support/proposals')) } catch (err) { push({ role: 'agent', text: err.message }) }
  }

  async function disableHint(id) {
    try {
      await api(`/api/support/rules/${id}/disable`, { method: 'POST' })
      setHints(await api('/api/support/proposals'))
    } catch (err) {
      push({ role: 'agent', text: err.message })
    }
  }

  return (
    <>
      <button onClick={() => setOpen((v) => !v)} style={{ position: 'fixed', bottom: 16, right: 16, zIndex: 1000, width: 52, height: 52, borderRadius: 26, border: 0, background: '#111', color: '#fff', fontSize: 22, cursor: 'pointer' }} aria-label="Live support">
        {open ? '×' : '💬'}
        {!open && unread > 0 && (
          <span style={{ position: 'absolute', top: -4, right: -4, background: '#e11d48', color: '#fff', borderRadius: 10, fontSize: 12, padding: '1px 6px' }}>{unread}</span>
        )}
      </button>
      {open && (
        <div style={panel}>
          <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee', fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
            <span>Live Support AI</span>
            <span style={{ display: 'flex', gap: 6 }}>
              {!hints && <button onClick={() => setMsgs([GREETING])} style={{ fontSize: 12 }}>Καθαρισμός</button>}
              <button onClick={toggleHints} style={{ fontSize: 12 }}>{hints ? 'Πίσω στη συζήτηση' : 'Οι οδηγίες μου'}</button>
            </span>
          </div>

          {hints ? (
            <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
              {hints.length === 0 && <p style={small}>Δεν έχει μάθει ακόμα κάτι ο ανιχνευτής για σένα.</p>}
              {hints.map((h) => (
                <div key={h.id} style={{ borderBottom: '1px solid #eee', padding: '8px 0' }}>
                  <div>{h.rule_text}</div>
                  <div style={small}>
                    {h.scope === 'global' ? 'Κοινή για όλους' : 'Δική σου'} · {h.status}
                    {h.source === 'auto' && ' · την πρόσθεσε ο agent μόνος του'}
                  </div>
                  {h.status === 'active' && h.scope === 'user' && (
                    <button style={{ marginTop: 4 }} onClick={() => disableHint(h.id)}>Απενεργοποίηση</button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
                {msgs.map((m, i) => (
                  <div key={i} style={{ marginBottom: 10, textAlign: m.role === 'user' ? 'right' : 'left' }}>
                    <div style={{ display: 'inline-block', maxWidth: '88%', padding: '8px 10px', borderRadius: 10, background: m.role === 'user' ? '#111' : '#f1f1f1', color: m.role === 'user' ? '#fff' : '#111', whiteSpace: 'pre-wrap', textAlign: 'left' }}>
                      {m.text}
                    </div>
                    {m.proposal && (
                      <div style={{ marginTop: 4, ...small }}>
                        Οδηγία: “{m.proposal.rule_text}”<br />{statusLabel(m.proposal)}
                      </div>
                    )}
                    {m.reanalyzeId && (
                      <div style={{ marginTop: 4 }}>
                        <button onClick={() => reanalyze(m.reanalyzeId)}>Ξαναδοκίμασε τη φωτογραφία</button>
                      </div>
                    )}
                  </div>
                ))}
                <div ref={endRef} />
              </div>
              <div style={{ padding: 10, borderTop: '1px solid #eee' }}>
                <select value={imageId} onChange={(e) => setImageId(e.target.value)} style={{ width: '100%', marginBottom: 6 }}>
                  <option value="">Χωρίς επισυναπτόμενη εικόνα</option>
                  {images.map((r) => (
                    <option key={r.id} value={r.id}>{r.originalFilename}{r.status === 'error' ? ' (πρόβλημα)' : ''}</option>
                  ))}
                </select>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} placeholder="Τι δεν αναγνωρίστηκε;" maxLength={1000} style={{ flex: 1, padding: 8, borderRadius: 8, border: '1px solid #ccc' }} />
                  <button onClick={send} disabled={busy}>{busy ? '…' : 'Στείλε'}</button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </>
  )
}
