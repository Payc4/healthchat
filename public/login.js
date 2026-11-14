const $ = id => document.getElementById(id)

$('loginForm').addEventListener('submit', async e => {
  e.preventDefault()
  $('err').hidden = true
  $('go').disabled = true
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.')
    location.href = '/app'
  } catch (err) {
    $('err').textContent = err.message
    $('err').hidden = false
    $('go').disabled = false
  }
})
