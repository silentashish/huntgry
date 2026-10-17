/*
 * Mock behaviour of a react-select v5 dropdown, as Greenhouse's job board renders its questions (Gender, yes/no):
 * a `role=combobox` input inside `.select__container`; mousedown on the control focuses it and opens the menu
 * (`.select__menu` > `role=listbox` > `role=option` elements, the input's `aria-controls` pointing at the listbox);
 * pressing in the menu does not blur the input (mousedown is cancelled, as react-select does); clicking an option
 * shows it in `.select__single-value`, puts it in the hidden input and closes the menu; blur
 * closes it too (and drops text typed without a choice, as react-select does). Keys do nothing here. Options come
 * from the container's `data-mock-options` ("Male|Female|…"). An async select (Greenhouse's "Location (City)",
 * #136) has `data-mock-async-options` instead: its menu lists the options containing the typed text, loaded
 * ~300 ms after typing (`data-mock-delay`), or "No options".
 * Used by the mock Greenhouse site (scripts/mock-ats/server.mjs) and by the jsdom tests of src/shared/autofill.
 */
;(() => {
  function wire(container) {
    if (container.dataset.mockWired) return
    container.dataset.mockWired = 'true'
    const input = container.querySelector('input[role="combobox"]')
    const placeholder = container.querySelector('[id$="-placeholder"]')
    const hidden = container.querySelector('input[aria-hidden="true"]')
    const async = container.dataset.mockAsyncOptions !== undefined
    const all = ((async ? container.dataset.mockAsyncOptions : container.dataset.mockOptions) || '').split('|').filter(Boolean)
    const delay = Number(container.dataset.mockDelay || 300)
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    const listboxId = `react-select-${input.id}-listbox`
    let menu = null
    let timer = 0
    let loaded = []
    const close = () => {
      if (menu) menu.remove()
      menu = null
      clearTimeout(timer)
      input.setAttribute('aria-expanded', 'false')
      input.removeAttribute('aria-controls')
    }
    const open = () => {
      if (menu) return
      const options = async ? loaded : all
      menu = document.createElement('div')
      menu.className = 'select__menu'
      const list = document.createElement('div')
      list.className = 'select__menu-list'
      list.setAttribute('role', 'listbox')
      list.id = listboxId
      if (options.length === 0) {
        const notice = document.createElement('div')
        notice.className = 'select__menu-notice select__menu-notice--no-options'
        notice.textContent = 'No options'
        list.append(notice)
      }
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
          setter.call(input, '')
          close()
        })
        list.append(option)
      })
      menu.append(list)
      // Like react-select's onMenuMouseDown: a press in the menu keeps focus on the input, so its blur cannot close
      // the menu between a real mousedown and the click that selects the option.
      menu.addEventListener('mousedown', (event) => event.preventDefault())
      container.append(menu)
      input.setAttribute('aria-expanded', 'true')
      input.setAttribute('aria-controls', listboxId)
    }
    input.closest('.select-shell, .select__control, div').addEventListener('mousedown', (event) => {
      if (event.button !== 0) return
      input.focus()
      open()
    })
    if (async) {
      // Typing loads the matching options a moment later, like an async react-select fetching suggestions.
      input.addEventListener('input', () => {
        clearTimeout(timer)
        const query = input.value.trim().toLowerCase()
        timer = setTimeout(() => {
          loaded = query ? all.filter((text) => text.toLowerCase().includes(query)) : []
          if (menu) menu.remove()
          menu = null
          open()
        }, delay)
      })
    }
    input.addEventListener('blur', () =>
      setTimeout(() => {
        close()
        // Text typed without choosing an option is dropped.
        if (input.value) setter.call(input, '')
      }, 0)
    )
  }
  const wireAll = () => document.querySelectorAll('[data-mock-options], [data-mock-async-options]').forEach(wire)
  // The script comes after the server-rendered markup: wire now, and again once the document is parsed.
  wireAll()
  document.addEventListener('DOMContentLoaded', wireAll)
  window.huntgryMockReactSelect = wireAll
})()
