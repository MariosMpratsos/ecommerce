import { useCallback, useEffect, useState } from 'react'
import { api } from './api'

const LABELS = { enable: 'Ενεργοποίηση', reject: 'Απόρριψη', disable: 'Απενεργοποίηση', promote: 'Κοινή για όλους' }

function actionsFor(r) {
  if (r.status === 'pending') return ['enable', 'reject']
  if (r.status === 'disabled') return ['enable']
  if (r.status === 'active') return r.scope === 'user' ? ['disable', 'promote'] : ['disable']
  return []
}

export default function RulesAdmin({ onClose }) {
  const [rules, setRules] = useState([])
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api('/api/support/proposals').then(setRules).catch((e) => setError(e.message))
  }, [])
  useEffect(load, [load])

  async function act(id, action) {
    setError('')
    try {
      await api(`/api/support/rules/${id}/${action}`, { method: 'POST' })
      load()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#0006', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', fontSize: 14 }}>
      <div style={{ background: '#fff', borderRadius: 12, padding: 16, width: 'min(760px, 94vw)', maxHeight: '85vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <strong>Οδηγίες που έμαθε ο AI</strong>
          <button onClick={onClose}>Κλείσιμο</button>
        </div>
        <p style={{ fontSize: 12, color: '#666', marginTop: 0 }}>
          Οι προσωπικές οδηγίες επηρεάζουν μόνο τον χρήστη που τις έχει. Με “Κοινή για όλους” μια οδηγία που δούλεψε εφαρμόζεται σε όλους.
        </p>
        {error && <p style={{ color: '#b00020' }}>{error}</p>}
        {rules.length === 0 && <p>Δεν υπάρχουν οδηγίες ακόμα.</p>}
        {rules.map((r) => (
          <div key={r.id} style={{ borderTop: '1px solid #eee', padding: '8px 0' }}>
            <div>{r.rule_text}</div>
            <div style={{ fontSize: 12, color: '#666' }}>
              #{r.id} · {r.status} · {r.scope === 'global' ? 'κοινή' : `προσωπική${r.owner_name ? ` (${r.owner_name})` : ''}`}
              {r.source === 'auto' && ' · αυτόματη'}
              {r.test_result && !r.test_result.error && ` · τεστ: ${r.test_result.before} → ${r.test_result.after} αντικείμενα`}
              {r.test_result?.error && ' · το τεστ απέτυχε'}
            </div>
            <div style={{ marginTop: 4, display: 'flex', gap: 6 }}>
              {actionsFor(r).map((a) => (
                <button key={a} onClick={() => act(r.id, a)}>{LABELS[a]}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
