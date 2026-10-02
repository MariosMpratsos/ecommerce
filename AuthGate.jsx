import { Component, useState } from 'react'
import { useAuth } from './AuthContext'
import SupportChat from './SupportChat'
import RulesAdmin from './RulesAdmin'

const box = { maxWidth: 360, margin: '80px auto', padding: 24, border: '1px solid #ddd', borderRadius: 12, fontFamily: 'system-ui, sans-serif', background: '#fff' }
const input = { width: '100%', padding: 10, marginBottom: 10, boxSizing: 'border-box', borderRadius: 8, border: '1px solid #ccc' }
const btn = { width: '100%', padding: 10, borderRadius: 8, border: 0, background: '#111', color: '#fff', cursor: 'pointer' }

function AuthForm() {
  const { authenticate } = useAuth()
  const [mode, setMode] = useState('login')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    // Διαβάζουμε τα πεδία απευθείας από τη φόρμα, ώστε να δουλεύει και το autofill του browser.
    const values = Object.fromEntries(new FormData(e.currentTarget))
    setError('')
    setBusy(true)
    try {
      await authenticate(mode, mode === 'login' ? { email: values.email, password: values.password } : values)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form key={mode} onSubmit={submit} style={box}>
      <h2 style={{ marginTop: 0 }}>{mode === 'login' ? 'Σύνδεση' : 'Δημιουργία λογαριασμού'}</h2>
      {mode === 'register' && (
        <>
          <input style={input} name="firstName" autoComplete="given-name" placeholder="Όνομα" required />
          <input style={input} name="lastName" autoComplete="family-name" placeholder="Επίθετο" required />
        </>
      )}
      <input style={input} name="email" type="email" autoComplete="email" placeholder="Email" required />
      <input
        style={input}
        name="password"
        type="password"
        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
        placeholder={mode === 'login' ? 'Κωδικός' : 'Κωδικός (τουλ. 8 χαρακτήρες)'}
        required
        minLength={mode === 'register' ? 8 : undefined}
      />
      {error && <p style={{ color: '#b00020', margin: '0 0 10px' }}>{error}</p>}
      <button style={btn} disabled={busy}>{busy ? '...' : mode === 'login' ? 'Σύνδεση' : 'Εγγραφή'}</button>
      <p style={{ textAlign: 'center', fontSize: 14 }}>
        <a href="#" onClick={(e) => { e.preventDefault(); setError(''); setMode(mode === 'login' ? 'register' : 'login') }}>
          {mode === 'login' ? 'Δεν έχεις λογαριασμό; Εγγραφή' : 'Έχεις λογαριασμό; Σύνδεση'}
        </a>
      </p>
    </form>
  )
}

function BetaBanner() {
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1200, background: '#111', color: '#fff', textAlign: 'center', padding: '8px 12px', fontSize: 13, fontWeight: 600, letterSpacing: '.03em', fontFamily: 'system-ui, sans-serif' }}>
      BETA VERSION — FEATURES SUCH AS SHARING TO INSTAGRAM AND FACEBOOK WILL BE ADDED SOON
    </div>
  )
}

// Αν το App.jsx σκάσει, δείχνουμε το μήνυμα αντί για λευκή οθόνη.
class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(error) { return { error } }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ ...box, maxWidth: 520 }}>
        <h3 style={{ marginTop: 0 }}>Κάτι πήγε στραβά στη σελίδα</h3>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#b00020', fontSize: 13 }}>{String(this.state.error?.message || this.state.error)}</pre>
        <button style={btn} onClick={() => location.reload()}>Ανανέωση</button>
      </div>
    )
  }
}

export default function AuthGate({ children }) {
  const { user, loading, logout } = useAuth()
  const [showAdmin, setShowAdmin] = useState(false)

  if (loading) return <><BetaBanner /><p style={{ textAlign: 'center', marginTop: 80 }}>Φόρτωση…</p></>
  if (!user) return <><BetaBanner /><AuthForm /></>

  return (
    <>
      <BetaBanner />
      <ErrorBoundary>{children}</ErrorBoundary>
      <div style={{ position: 'fixed', top: 44, right: 8, zIndex: 1000, display: 'flex', gap: 8, alignItems: 'center', fontFamily: 'system-ui, sans-serif', fontSize: 13, background: '#fffe', padding: '4px 10px', borderRadius: 20, boxShadow: '0 1px 4px #0003' }}>
        <span>{user.firstName} {user.lastName}</span>
        {user.role === 'admin' && <button onClick={() => setShowAdmin((v) => !v)}>Κανόνες AI</button>}
        <button onClick={logout}>Έξοδος</button>
      </div>
      {showAdmin && <RulesAdmin onClose={() => setShowAdmin(false)} />}
      <SupportChat />
    </>
  )
}
