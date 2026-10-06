/*
 * Mock behaviour of a react-select v5 dropdown, as Greenhouse's job board renders its questions (Gender, yes/no):
 * a `role=combobox` input inside `.select__container`; mousedown on the control focuses it and opens the menu
 * (`.select__menu` > `role=listbox` > `role=option` elements, the input's `aria-controls` pointing at the listbox);
 * clicking an option shows it in `.select__single-value`, puts it in the hidden input and closes the menu; blur
 * closes it too. Keys do nothing here. Options come from the container's `data-mock-options` ("Male|Female|…").
 * Used by the mock Greenhouse site (scripts/mock-ats/server.mjs) and by the jsdom tests of src/shared/autofill.
 */
;(() => {
  function wire(container) {
    if (container.dataset.mockWired) return
    container.dataset.mockWired = 'true'
    const input = container.querySelector('input[role="combobox"]')
    const placeholder = container.querySelector('[id$="-placeholder"]')
    const hidden = container.querySelector('input[aria-hidden="true"]')
    const options = (container.dataset.mockOptions || '').split('|').filter(Boolean)
    const listboxId = `react-select-${input.id}-listbox`
    let menu = null
    const close = () => {
      if (menu) menu.remove()
      menu = null
      input.setAttribute('aria-expanded', 'false')
      input.removeAttribute('aria-controls')
    }
    const open = () => {
      if (menu) return
      menu = document.createElement('div')
      menu.className = 'select__menu'
      const list = document.createElement('div')
      list.className = 'select__menu-list'
      list.setAttribute('role', 'listbox')
      list.id = listboxId
      options.forEach((text, i) => {
        const option = document.createElement('div')
        option.className = 'select__option'
        option.setAttribute('role', 'option')
        option.id = `react-select-${input.id}-option-${i}`
        option.textContent = text
        option.addEventListener('click', () => {
          placeholder.textContent = text
          placeholder.className = 'select__single-value'
          if (hidden) hidden.value = text
          close()
        })
        list.append(option)
      })
      menu.append(list)
      container.append(menu)
      input.setAttribute('aria-expanded', 'true')
      input.setAttribute('aria-controls', listboxId)
    }
    input.closest('.select-shell, .select__control, div').addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      input.focus()
      open()
    })
    input.addEventListener('blur', () => setTimeout(close, 0))
  }
  const wireAll = () => document.querySelectorAll('[data-mock-options]').forEach(wire)
  // The script comes after the server-rendered markup: wire now, and again once the document is parsed.
  wireAll()
  document.addEventListener('DOMContentLoaded', wireAll)
  window.huntgryMockReactSelect = wireAll
})()
