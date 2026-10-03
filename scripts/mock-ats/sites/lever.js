/*
 * Mock behaviour of Lever's apply form (jobs.lever.co/<company>/<id>/apply), as observed live on 2026-10-03:
 * - The form has no action; Lever posts it with JavaScript.
 * - Choosing a résumé posts it to the résumé parser (POST /lever/parseResume) and shows "Analyzing resume...";
 *   the parser then fills the contact fields that are still EMPTY with what it read (here "Parsed Name",
 *   parsed@example.com, 000-000-0000), shows the file name and "Success!".
 * Nothing here submits on its own: the person (or the e2e test) presses Submit.
 */
;(() => {
  const show = (selector, on) => {
    const el = document.querySelector(selector)
    if (el) el.style.display = on ? 'inline-block' : 'none'
  }
  const input = document.getElementById('resume-upload-input')
  input.addEventListener('change', async () => {
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

  const form = document.getElementById('application-form')
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const res = await fetch('/lever/submit', { method: 'POST', body: new FormData(form) })
    location.assign(res.url)
  })
})()
