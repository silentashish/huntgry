/*
 * Mock behaviour of Lever's apply form (jobs.lever.co/<company>/<id>/apply), as observed live on 2026-10-03:
 * - The form has no action; Lever posts it with JavaScript.
 * - Choosing a résumé posts it to the résumé parser (POST /lever/parseResume) and shows "Analyzing resume...";
 *   the parser then fills the contact fields that are still EMPTY with what it read (here "Parsed Name",
 *   parsed@example.com, 000-000-0000), shows the file name and "Success!".
 * - "Current location" is an autocomplete (#136): typing shows matching suggestions ~200 ms later in the field's
 *   `.dropdown-results` (role=listbox, named by the input's `aria-controls`); choosing one puts it in the input and
 *   in the hidden `selectedLocation`; free text that was not chosen is cleared on blur, as on the real site.
 * Nothing here submits on its own: the person (or the e2e test) presses Submit.
 */
;(() => {
  const show = (selector, on) => {
    const el = document.querySelector(selector)
    if (el) el.style.display = on ? 'inline-block' : 'none'
  }
  const input = document.getElementById('resume-upload-input')
  input?.addEventListener('change', async () => {
    const file = input.files && input.files[0]
    if (!file) return
    show('.resume-upload-success', false)
    show('.resume-upload-failure', false)
    show('.resume-upload-working', true)
    const body = new FormData()
    body.append('resume', file, file.name)
    const res = await fetch('/lever/parseResume', { method: 'POST', body })
    const parsed = await res.json()
    await new Promise((resolve) => setTimeout(resolve, 600))
    for (const [name, value] of Object.entries(parsed)) {
      const field = document.querySelector(`input[name="${name}"]`)
      if (field && !field.value) field.value = value
    }
    document.querySelector('.filename').textContent = file.name
    show('.resume-upload-working', false)
    show('.resume-upload-success', true)
  })

  const location = document.getElementById('location-input')
  const results = location && location.closest('.application-field').querySelector('.dropdown-results')
  if (location && results) {
    const PLACES = [
      'Portland, OR, United States',
      'Portland, ME, United States',
      'Portsmouth, NH, United States',
      'London, England, United Kingdom',
      'Toronto, ON, Canada'
    ]
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const selected = document.getElementById('selected-location')
    let chosen = ''
    let timer = 0
    results.id = results.id || 'location-results'
    results.setAttribute('role', 'listbox')
    location.setAttribute('aria-controls', results.id)
    const clear = () => results.replaceChildren()
    location.addEventListener('input', () => {
      clearTimeout(timer)
      const query = location.value.trim().toLowerCase()
      timer = setTimeout(() => {
        clear()
        for (const place of PLACES.filter((p) => query && p.toLowerCase().includes(query))) {
          const option = document.createElement('div')
          option.className = 'dropdown-location'
          option.setAttribute('role', 'option')
          option.textContent = place
          option.addEventListener('click', () => {
            chosen = place
            setter.call(location, place)
            if (selected) selected.value = JSON.stringify({ name: place })
            clear()
          })
          results.append(option)
        }
      }, 200)
    })
    location.addEventListener('blur', () =>
      setTimeout(() => {
        if (location.value !== chosen) setter.call(location, '')
        clear()
      }, 150)
    )
  }

  const form = document.getElementById('application-form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const res = await fetch('/lever/submit', { method: 'POST', body: new FormData(form) })
    location.assign(res.url)
  })
})()
