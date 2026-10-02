export const API = import.meta.env.VITE_API_URL || 'http://localhost:5000'

export const getToken = () => localStorage.getItem('token')
export const setToken = (t) => (t ? localStorage.setItem('token', t) : localStorage.removeItem('token'))

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new Error(`Δεν βρίσκω τον server (${API}). Τρέχει το "npm start";`)
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Σφάλμα ${res.status}`)
  return data
}

// Ο υπάρχων κώδικας του App.jsx κάνει fetch χωρίς token. Αυτό προσθέτει αυτόματα
// το Authorization header σε κάθε κλήση /api/* και κάνει logout όταν λήξει η σύνδεση.
export function installAuthFetch() {
  const original = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const isApi = url.startsWith('/api') || url.startsWith(`${API}/api`)
    const token = getToken()

    if (isApi && token) {
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined))
      if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`)
      init = { ...init, headers }
    }

    const res = await original(input, init)
    if (isApi && token && res.status === 401) {
      setToken(null)
      window.dispatchEvent(new Event('auth:logout'))
    }
    return res
  }
}
