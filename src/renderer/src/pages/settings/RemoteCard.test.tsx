// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemotePairingInfo, RemoteState } from '@shared/remote-types'

/** Settings → Remote control (#36, #37): busy states, the https check, TTLs, the QR modal and the approve dialog. */

const base: RemoteState = { connection: 'disabled', notificationDetails: false, transcripts: true, commandTtl: { costlySeconds: 7200, defaultSeconds: 86400 }, devices: [], pairings: [] }
let state: RemoteState = base
let release: (() => void) | null = null
const listeners = new Set<(s: RemoteState) => void>()
const remote = {
  state: vi.fn(async () => state),
  // Hangs until the test releases it: the card stays busy meanwhile.
  setEnabled: vi.fn(() => new Promise<RemoteState>((r) => (release = () => r({ ...state, connection: 'unconfigured' })))),
  configure: vi.fn(async () => state),
  rotate: vi.fn(async () => state),
  setNotificationDetails: vi.fn(async () => state),
  setTranscripts: vi.fn(async () => state),
  setCommandTtl: vi.fn(async () => state),
  revoke: vi.fn(),
  unpairAll: vi.fn(),
  startPairing: vi.fn(async () => ({ pairingId: 'p-1', expiresAt: new Date(Date.now() + 120_000).toISOString(), qrDataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' })),
  cancelPairing: vi.fn(async () => state),
  approvePairing: vi.fn(async () => state),
  denyPairing: vi.fn(async () => state),
  audit: vi.fn(async () => [])
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.assign(window, {
    huntgry: {
      remote,
      on: (_channel: string, listener: (s: RemoteState) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    }
  })
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
  state = base
  vi.clearAllMocks()
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

const button = (label: string): HTMLButtonElement => {
  const b = [...document.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent?.trim() === label)
  if (!b) throw new Error(`no button "${label}"`)
  return b
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function renderCard(): Promise<void> {
  const { RemoteCard } = await import('./RemoteCard')
  await act(async () =>
    root.render(
      <MantineProvider>
        <RemoteCard />
      </MantineProvider>
    )
  )
}

const scanned: RemotePairingInfo = { id: 'p-1', status: 'scanned', expiresAt: new Date(Date.now() + 60_000).toISOString(), decideBy: new Date(Date.now() + 360_000).toISOString(), deviceName: 'Ashish’s iPhone 17', appVersion: '1.0.0' }

describe('RemoteCard', () => {
  it('disables the notification-details and transcripts toggles while another request is in flight', async () => {
    await renderCard()
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

  it('shows why an http:// relay URL is refused and does not send it', async () => {
    state = { ...base, connection: 'unconfigured' }
    await renderCard()
    const url = container.querySelector<HTMLInputElement>('input[placeholder^="https://"]')!
    const token = container.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => type(url, 'http://relay.example.com'))
    await act(async () => type(token, 'admin-token'))
    expect(container.textContent).toContain('must start with https://')
    expect(button('Save').disabled).toBe(true)

    await act(async () => type(url, 'https://relay.example.com'))
    expect(button('Save').disabled).toBe(false)
    await act(async () => button('Save').click())
    expect(remote.configure).toHaveBeenCalledWith({ relayUrl: 'https://relay.example.com', adminToken: 'admin-token' })
    // The token is cleared from the form once saved.
    expect(token.value).toBe('')
  })

  it('saves the TTL fields as seconds', async () => {
    await renderCard()
    const costly = [...container.querySelectorAll<HTMLInputElement>('input')].find((i) => i.closest('.mantine-NumberInput-root')?.textContent?.includes('Costly'))!
    expect(costly.value).toBe('2 h')
    await act(async () => type(costly, '0.5'))
    await act(async () => button('Save TTLs').click())
    expect(remote.setCommandTtl).toHaveBeenCalledWith({ costlySeconds: 1800, defaultSeconds: 86400 })
  })

  it('Pair a phone shows the QR image from main and the approve step once a phone scans it', async () => {
    state = { ...base, connection: 'online', relayUrl: 'https://relay.example.com', roomId: 'room-1' }
    await renderCard()
    await act(async () => button('Pair a phone').click())
    expect(remote.startPairing).toHaveBeenCalledTimes(1)
    const img = document.querySelector<HTMLImageElement>('img[alt="Pairing code"]')!
    expect(img.src).toMatch(/^data:image\/svg\+xml/)
    expect(document.body.textContent).toMatch(/Expires in [12]:\d\d/)

    state = { ...state, pairings: [scanned] }
    await act(async () => listeners.forEach((l) => l(state)))
    expect(document.body.textContent).toContain('Pair “Ashish’s iPhone 17”?')
    await act(async () => [...document.querySelectorAll<HTMLElement>('[data-testid="pair-approve"] button')].find((b) => b.textContent === 'Approve')!.click())
    expect(remote.approvePairing).toHaveBeenCalledWith('p-1')
  })
})

describe('PairingPrompt', () => {
  it('asks "Pair …?" when a hello arrives while the modal is closed; Deny sends only the id', async () => {
    const { PairingPrompt } = await import('./PairingPrompt')
    await act(async () =>
      root.render(
        <MantineProvider>
          <PairingPrompt />
        </MantineProvider>
      )
    )
    expect(document.body.textContent).not.toContain('Pair “')
    state = { ...base, connection: 'online', pairings: [scanned] }
    await act(async () => listeners.forEach((l) => l(state)))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
    expect(document.body.textContent).toContain('Pair “Ashish’s iPhone 17”?')
    await act(async () => button('Deny').click())
    expect(remote.denyPairing).toHaveBeenCalledWith('p-1')
  })
})
