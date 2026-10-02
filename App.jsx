import { useCallback, useEffect, useRef, useState } from 'react'
import { API, getToken } from './api'

const authHeader = () => ({ Authorization: `Bearer ${getToken()}` })

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { ...authHeader(), ...(options.headers || {}) },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Σφάλμα ${res.status}`)
  return data
}

export default function App() {
  const [items, setItems] = useState([])
  const [files, setFiles] = useState([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const inputRef = useRef(null)

  const load = useCallback(() => {
    call('/api/images').then(setItems).catch((e) => setMessage(e.message))
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    window.addEventListener('catalog:refresh', load)
    return () => window.removeEventListener('catalog:refresh', load)
  }, [load])

  async function upload() {
    if (!files.length) return
    setBusy(true)
    setMessage('Ανάλυση εικόνων… μπορεί να πάρει λίγο.')
    try {
      const form = new FormData()
      files.forEach((f) => form.append('images', f))
      const results = await call('/api/upload', { method: 'POST', body: form })
      setFiles([])
      if (inputRef.current) inputRef.current.value = ''
      setMessage('')
      load()
      // Ο agent ελέγχει τις φωτογραφίες στο παρασκήνιο. Αν κάτι δεν αναγνωρίστηκε, ρωτάει.
      window.dispatchEvent(new Event('catalog:uploaded'))
      const failed = results.find((r) => r.status === 'error')
      if (failed) {
        window.dispatchEvent(new CustomEvent('support:open', {
          detail: {
            imageId: failed.id,
            text: `Δεν αναγνώρισα αντικείμενα στη φωτογραφία «${failed.originalFilename}». Πες μου τι φοριέται εκεί (π.χ. μπότες, ζώνη) και θα βελτιώσω τον ανιχνευτή για εσένα.`,
          },
        }))
      }
    } catch (e) {
      setMessage(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function remove(id) {
    if (!confirm('Διαγραφή;')) return
    try { await call(`/api/images/${id}`, { method: 'DELETE' }); load() } catch (e) { setMessage(e.message) }
  }

  async function clearHistory() {
    if (!items.length) return
    if (!confirm('Θα διαγραφούν όλες οι φωτογραφίες και τα αντικείμενα του ιστορικού σου. Οι οδηγίες που έμαθε ο AI μένουν. Συνέχεια;')) return
    try {
      const r = await call('/api/images', { method: 'DELETE' })
      setMessage(`Το ιστορικό καθαρίστηκε (${r.removed} εγγραφές).`)
      load()
    } catch (e) {
      setMessage(e.message)
    }
  }

  async function share(id, network) {
    setMessage(`Δημοσίευση στο ${network}…`)
    try {
      await call(`/api/share/${network}/${id}`, { method: 'POST' })
      setMessage(`Δημοσιεύτηκε στο ${network}.`)
    } catch (e) {
      setMessage(e.message)
    }
  }

  return (
    <div className="wrap">
      <div className="drop">
        <input ref={inputRef} type="file" accept="image/*" multiple onChange={(e) => setFiles([...e.target.files])} />
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={upload} disabled={busy || !files.length}>
            {busy ? 'Ανάλυση…' : `Ανέβασμα${files.length ? ` (${files.length})` : ''}`}
          </button>
        </div>
      </div>
      {message && <p className="msg">{message}</p>}

      {items.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 24 }}>
          <strong>Ιστορικό ({items.length})</strong>
          <button className="danger" onClick={clearHistory}>Καθαρισμός ιστορικού</button>
        </div>
      )}

      <div className="grid" style={{ marginTop: 12 }}>
        {items.map((it) => (
          <div className="card" key={it.id}>
            <img src={`${API}${it.url}`} alt={it.title || it.originalFilename} loading="lazy" />
            <div className="body">
              {it.status === 'error' ? (
                <>
                  <div className="err">{it.error || 'Σφάλμα'}</div>
                  <div className="specs">{it.originalFilename}</div>
                </>
              ) : (
                <>
                  <div className="cat">{it.category}</div>
                  <strong>{it.title}</strong>
                  <div>{it.description}</div>
                  <div className="specs">{it.specs}</div>
                </>
              )}
              <div className="actions">
                {it.status === 'success' && (
                  <>
                    <button disabled title="Έρχεται σύντομα">Facebook · σύντομα</button>
                    <button disabled title="Έρχεται σύντομα">Instagram · σύντομα</button>
                  </>
                )}
                <button onClick={() => window.dispatchEvent(new CustomEvent('support:open', {
                  detail: { imageId: it.id, text: 'Τι δεν αναγνωρίστηκε σωστά σε αυτή τη φωτογραφία;' },
                }))}>Λάθος ανίχνευση;</button>
                <button onClick={() => remove(it.id)}>Διαγραφή</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
