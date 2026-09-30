import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Box, Button, Center, CloseButton, Group, Loader, Stack, Text, TextInput, UnstyledButton } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconPlus,
  IconRefresh,
  IconWorld,
  IconX
} from '@tabler/icons-react'
import type { BrowserState } from '@shared/browser-types'
import { api, errorText } from '../../api'
import type { PageParams } from '../../navigation'
import { activeTab, displayUrl, EMPTY_STATE, findTab, tabLabel } from './state'

/**
 * The in-app browser. Pages are native views owned by main and drawn over the
 * placeholder below the toolbar; they paint above the DOM, so nothing on this
 * page (menus, tooltips, modals) may extend over that area. Tabs live in main
 * and survive leaving this page.
 */
export function BrowserPage({ params }: { params: PageParams['browser'] }) {
  const [state, setState] = useState<BrowserState>(EMPTY_STATE)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const placeholder = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  const handled = useRef<PageParams['browser'] | null>(null)
  const tab = activeTab(state)

  /** Runs a browser call; errors go to the notice row. Resolves to whether it succeeded. */
  const run = useCallback(async (fn: () => Promise<BrowserState | void>): Promise<boolean> => {
    setError(null)
    try {
      const next = await fn()
      if (next) setState(next)
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }, [])

  // State from main, then every change; open the posting we were sent here with (once per navigation).
  useEffect(() => {
    const off = api.on('browser:state', setState)
    void api.browser.state().then((current) => {
      setState(current)
      const url = params?.url
      if (!url || handled.current === params) return
      handled.current = params
      const existing = findTab(current, url)
      void run(() => (existing ? api.browser.activate(existing.id) : api.browser.open(url)))
    })
    return off
  }, [params, run])

  // Keep the native view over the placeholder; hide it when this page goes away.
  useLayoutEffect(() => {
    const el = placeholder.current
    if (!el) return
    const send = () => {
      const r = el.getBoundingClientRect()
      void api.browser.setBounds({ x: r.x, y: r.y, width: Math.max(0, r.width), height: Math.max(0, r.height) })
    }
    send()
    void api.browser.setVisible(true)
    const observer = new ResizeObserver(send)
    observer.observe(el)
    window.addEventListener('resize', send)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', send)
      void api.browser.setVisible(false)
    }
  }, [])

  const newTab = useCallback(() => {
    void run(() => api.browser.open('')).then((ok) => ok && address.current?.focus())
  }, [run])

  // Cmd/Ctrl+L: address bar, Cmd/Ctrl+T: new tab (while focus is in the app, not in the page).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      if (e.key === 'l') {
        e.preventDefault()
        address.current?.focus()
        address.current?.select()
      } else if (e.key === 't') {
        e.preventDefault()
        newTab()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newTab])

  function submit() {
    const text = draft ?? displayUrl(tab)
    if (!text.trim()) return
    // On failure keep the text in the address bar so it can be corrected.
    void run(() => (tab ? api.browser.navigate(tab.id, text) : api.browser.open(text))).then((ok) => {
      if (!ok) return
      setDraft(null)
      address.current?.blur()
    })
  }

  const notice = error ?? tab?.error ?? null

  return (
    <Stack gap={0} h="100dvh">
      <Group gap={4} px="xs" pt={6} wrap="nowrap" style={{ overflowX: 'auto', flexShrink: 0 }}>
        {state.tabs.map((t) => {
          const selected = t.id === state.activeId
          return (
            <Group
              key={t.id}
              gap={4}
              wrap="nowrap"
              px={8}
              py={4}
              style={{
                minWidth: 120,
                maxWidth: 220,
                flexShrink: 0,
                borderRadius: 'var(--mantine-radius-md) var(--mantine-radius-md) 0 0',
                background: selected ? 'var(--mantine-color-default)' : 'transparent',
                border: '1px solid var(--mantine-color-default-border)',
                borderBottom: selected ? '1px solid var(--mantine-color-default)' : undefined
              }}
            >
              {t.loading ? <Loader size={12} /> : <IconWorld size={14} style={{ flexShrink: 0 }} />}
              <UnstyledButton
                onClick={() => void run(() => api.browser.activate(t.id))}
                title={t.url}
                style={{ flex: 1, minWidth: 0 }}
              >
                <Text size="xs" fw={selected ? 600 : 400} truncate>
                  {tabLabel(t)}
                </Text>
              </UnstyledButton>
              <CloseButton size="xs" aria-label={`Close ${tabLabel(t)}`} onClick={() => void run(() => api.browser.close(t.id))} />
            </Group>
          )
        })}
        <ActionIcon variant="subtle" color="gray" aria-label="New tab" onClick={newTab}>
          <IconPlus size={16} />
        </ActionIcon>
      </Group>

      <Group
        gap={4}
        px="xs"
        py={6}
        wrap="nowrap"
        style={{ flexShrink: 0, borderTop: '1px solid var(--mantine-color-default-border)', borderBottom: '1px solid var(--mantine-color-default-border)' }}
      >
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Back"
          disabled={!tab?.canGoBack}
          onClick={() => tab && void run(() => api.browser.back(tab.id))}
        >
          <IconArrowLeft size={18} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label="Forward"
          disabled={!tab?.canGoForward}
          onClick={() => tab && void run(() => api.browser.forward(tab.id))}
        >
          <IconArrowRight size={18} />
        </ActionIcon>
        {tab?.loading ? (
          <ActionIcon variant="subtle" color="gray" aria-label="Stop" onClick={() => void run(() => api.browser.stop(tab.id))}>
            <IconX size={18} />
          </ActionIcon>
        ) : (
          <ActionIcon
            variant="subtle"
            color="gray"
            aria-label="Reload"
            disabled={!tab || tab.url === 'about:blank'}
            onClick={() => tab && void run(() => api.browser.reload(tab.id))}
          >
            <IconRefresh size={18} />
          </ActionIcon>
        )}
        <TextInput
          ref={address}
          size="xs"
          style={{ flex: 1 }}
          placeholder="Enter a URL, e.g. jobs.ashbyhq.com/company"
          aria-label="Address"
          spellCheck={false}
          value={draft ?? displayUrl(tab)}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') {
              setDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
        <Button
          size="xs"
          variant="default"
          leftSection={<IconExternalLink size={14} />}
          disabled={!tab || tab.url === 'about:blank'}
          onClick={() => tab && void run(() => api.browser.openExternal(tab.id))}
        >
          Open in browser
        </Button>
      </Group>

      {notice && (
        <Alert color="red" variant="light" radius={0} py={6} withCloseButton={error !== null} onClose={() => setError(null)}>
          <Text size="xs">{notice}</Text>
        </Alert>
      )}

      <Box ref={placeholder} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state.tabs.length === 0 && (
          <Center h="100%">
            <Stack align="center" gap="xs" maw={420}>
              <IconWorld size={40} stroke={1.3} color="var(--mantine-color-dimmed)" />
              <Text fw={600}>No pages open</Text>
              <Text size="sm" c="dimmed" ta="center">
                Open a posting from Jobs or the Dashboard, or enter a URL above. Pages stay open while you use the rest of
                the app.
              </Text>
              <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={newTab}>
                New tab
              </Button>
            </Stack>
          </Center>
        )}
      </Box>
    </Stack>
  )
}
