// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteState } from '@shared/remote-types'

/** Settings → Remote control: no second request can start while one is in flight. */

const state: RemoteState = { connection: 'disabled', notificationDetails: false, transcripts: true, devices: [] }
let release: (() => void) | null = null
const remote = {
  state: vi.fn(async () => state),
  // Hangs until the test releases it: the card stays busy meanwhile.
  setEnabled: vi.fn(() => new Promise<RemoteState>((r) => (release = () => r({ ...state, connection: 'unconfigured' })))),
  configure: vi.fn(),
  setNotificationDetails: vi.fn(async () => state),
  setTranscripts: vi.fn(async () => state),
  revoke: vi.fn(),
  unpairAll: vi.fn()
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, { huntgry: { remote, on: () => () => undefined } })
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false })) as typeof window.matchMedia
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  release?.()
  await act(async () => root.unmount())
  container.remove()
})

const switchNamed = (label: string): HTMLInputElement => {
  const input = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((i) => (i.closest('.mantine-Switch-root')?.textContent ?? '').includes(label))
  if (!input) throw new Error(`no switch "${label}"`)
  return input
}

describe('RemoteCard', () => {
  it('disables the notification-details and transcripts toggles while another request is in flight', async () => {
    const { RemoteCard } = await import('./RemoteCard')
    await act(async () =>
      root.render(
        <MantineProvider>
          <RemoteCard />
        </MantineProvider>
      )
    )
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-expanded]')!.click())
    expect(switchNamed('Show transcripts').disabled).toBe(false)

    await act(async () => switchNamed('Enable remote control').click())
    expect(remote.setEnabled).toHaveBeenCalledTimes(1)
    expect(switchNamed('Show details in notifications').disabled).toBe(true)
    expect(switchNamed('Show transcripts').disabled).toBe(true)
    await act(async () => switchNamed('Show transcripts').click())
    expect(remote.setTranscripts).not.toHaveBeenCalled()

    await act(async () => release!())
    expect(switchNamed('Show transcripts').disabled).toBe(false)
  })
})
