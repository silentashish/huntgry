/*
 * Mock behaviour of Greenhouse's job-board form (job-boards.greenhouse.io), as observed live on 2026-10-03:
 * - The form is server-rendered and React hydrates it shortly after `load` (?hydrateMs=, default 300): every
 *   value written before that is reset and each file input is re-created, so a fill or an upload that ran too
 *   early is silently lost. Event handlers exist only after hydration.
 * - Choosing a file presigns (GET /greenhouse/presign) and uploads it (POST /greenhouse/s3) at once, replacing
 *   the hidden <input type=file> with a progress bar, then with the file name and a Remove button.
 * - Submit posts the form with JavaScript, including the uploaded files.
 * Nothing here submits on its own: the person (or the e2e test) presses Submit.
 */
;(() => {
  const params = new URLSearchParams(location.search)
  const hydrateMs = Number(params.get('hydrateMs') ?? 300)
  const uploaded = {}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const areaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set

  function hydrate() {
    for (const el of document.querySelectorAll('#application-form input:not([type="file"])')) setter.call(el, '')
    for (const el of document.querySelectorAll('#application-form textarea')) areaSetter.call(el, '')
    for (const el of document.querySelectorAll('#application-form input[type="file"]')) {
      const fresh = el.cloneNode(false)
      el.replaceWith(fresh)
      fresh.addEventListener('change', () => upload(fresh))
    }
    document.documentElement.dataset.hydrated = 'true'
  }

  async function upload(input) {
    const file = input.files && input.files[0]
    if (!file) return
    const field = input.id
    const wrapper = input.closest('.file-upload__wrapper')
    uploaded[field] = file
    wrapper.innerHTML = '<div class="file-upload__progressbar" role="progressbar" aria-valuenow="10"></div>'
    await fetch(`/greenhouse/presign?fields[]=${encodeURIComponent(field)}`)
    const body = new FormData()
    body.append('file', file, file.name)
    body.append('field', field)
    await fetch('/greenhouse/s3', { method: 'POST', body })
    const name = document.createElement('div')
    name.className = 'file-upload__filename'
    name.textContent = file.name
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'Remove file'
    wrapper.replaceChildren(name, remove)
  }

  document.addEventListener('submit', async (event) => {
    const form = event.target
    if (!(form instanceof HTMLFormElement) || form.id !== 'application-form') return
    event.preventDefault()
    const body = new FormData(form)
    for (const [field, file] of Object.entries(uploaded)) body.set(field, file, file.name)
    const res = await fetch(form.getAttribute('action'), { method: 'POST', body })
    location.assign(res.url)
  })

  addEventListener('load', () => setTimeout(hydrate, hydrateMs))
})()
