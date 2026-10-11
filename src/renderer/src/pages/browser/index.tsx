import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Button, CloseButton, Kbd, Loader, Text, TextInput, UnstyledButton } from '@mantine/core'
import {
  IconArrowLeft,
  IconArrowRight,
  IconExternalLink,
  IconLock,
  IconPlus,
  IconRefresh,
  IconShieldCheck,
  IconWorld,
  IconX
} from '@tabler/icons-react'
import type { BrowserState } from '@shared/browser-types'
import { api, errorText } from '../../api'
import { EmptyState, MonoLabel, StatusPill } from '../../components/ui'
import { useNavigation, type PageParams } from '../../navigation'
import { ApplyPanel } from './ApplyPanel'
import classes from './browser.module.css'
import { activeTab, displayUrl, EMPTY_STATE, findTab, isSecure, modKey, tabLabel } from './state'

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
  const { navigate } = useNavigation()
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
  const mod = modKey(navigator.platform)
  const pageLoaded = tab !== null && tab.url !== 'about:blank'

  return (
    <div className={classes.page}>
      <div className={classes.strip}>
        {state.tabs.length > 0 && (
          <div className={classes.tabs}>
            {state.tabs.map((t) => {
              const selected = t.id === state.activeId
              const label = tabLabel(t)
              return (
                <div key={t.id} className={classes.tab} data-active={selected || undefined}>
                  <span className={classes.tabIcon} aria-hidden>
                    {t.loading ? <Loader size={12} color="var(--hg-text-accent)" /> : <IconWorld size={14} />}
                  </span>
                  <UnstyledButton
                    className={classes.tabLabel}
                    onClick={() => void run(() => api.browser.activate(t.id))}
                    title={t.url}
                    aria-current={selected ? 'true' : undefined}
                  >
                    {label}
                  </UnstyledButton>
                  <CloseButton
                    size="xs"
                    icon={<IconX size={12} />}
                    aria-label={`Close ${label}`}
                    onClick={() => void run(() => api.browser.close(t.id))}
                  />
                </div>
              )
            })}
          </div>
        )}
        <ActionIcon className={classes.newTab} variant="subtle" size="md" aria-label="New tab" onClick={newTab}>
          <IconPlus size={14} />
        </ActionIcon>
        {state.tabs.length === 0 ? (
          <span className={classes.noTabs}>No tabs</span>
        ) : (
          <MonoLabel size="xs" className={classes.stripHint}>
            {mod}T new tab · {mod}L address
          </MonoLabel>
        )}
      </div>

      <div className={classes.toolbar}>
        <ActionIcon
          variant="subtle"
          size="lg"
          aria-label="Back"
          disabled={!tab?.canGoBack}
          onClick={() => tab && void run(() => api.browser.back(tab.id))}
        >
          <IconArrowLeft size={16} />
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          size="lg"
          aria-label="Forward"
          disabled={!tab?.canGoForward}
          onClick={() => tab && void run(() => api.browser.forward(tab.id))}
        >
          <IconArrowRight size={16} />
        </ActionIcon>
        {tab?.loading ? (
          <ActionIcon variant="subtle" size="lg" aria-label="Stop" onClick={() => void run(() => api.browser.stop(tab.id))}>
            <IconX size={16} />
          </ActionIcon>
        ) : (
          <ActionIcon
            variant="subtle"
            size="lg"
            aria-label="Reload"
            disabled={!pageLoaded}
            onClick={() => tab && void run(() => api.browser.reload(tab.id))}
          >
            <IconRefresh size={16} />
          </ActionIcon>
        )}
        <TextInput
          ref={address}
          className={classes.address}
          classNames={{ input: classes.addressInput }}
          leftSection={
            isSecure(tab) && draft === null ? (
              <IconLock size={16} className={classes.addressIcon} data-secure aria-hidden />
            ) : (
              <IconWorld size={16} className={classes.addressIcon} aria-hidden />
            )
          }
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
        {pageLoaded && (
          <StatusPill tone="trail" leftSection={<IconShieldCheck size={12} />}>
            Sandboxed · own cookie jar
          </StatusPill>
        )}
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconExternalLink size={14} />}
          disabled={!pageLoaded}
          onClick={() => tab && void run(() => api.browser.openExternal(tab.id))}
        >
          Open in browser
        </Button>
      </div>

      {notice && (
        <Alert color="red" variant="light" radius={0} py={6} withCloseButton={error !== null} onClose={() => setError(null)}>
          <Text size="xs">{notice}</Text>
        </Alert>
      )}

      <div className={classes.body}>
        <div ref={placeholder} className={classes.view}>
          {state.tabs.length === 0 && (
            <div className={classes.empty}>
              <EmptyState
                icon={<IconWorld size={28} stroke={1.6} />}
                title="No pages open"
                titleOrder={2}
                description={
                  <>
                    Open a posting from Jobs or the Dashboard, or enter a URL above. Pages stay open while you use the rest of
                    the app, in their own sandboxed cookie jar.
                  </>
                }
                actions={
                  <>
                    <Button variant="primary" leftSection={<IconPlus size={16} />} onClick={newTab}>
                      New tab
                    </Button>
                    <Button variant="default" rightSection={<IconArrowRight size={16} />} onClick={() => navigate('jobs')}>
                      Go to Jobs
                    </Button>
                  </>
                }
                hint={
                  <>
                    <Kbd size="xs">{mod}L</Kbd> address bar <Kbd size="xs">{mod}T</Kbd> new tab
                  </>
                }
              />
            </div>
          )}
        </div>
        {/* Auto-apply (#24): beside the page, never over it (the page is a native view). */}
        <ApplyPanel activeTabId={state.activeId} />
      </div>
    </div>
  )
}
