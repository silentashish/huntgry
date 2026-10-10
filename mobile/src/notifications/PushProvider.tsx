/**
 * Wires push into the app (#39): one `PushRegistrar` and one `TapRouter` for the app's
 * lifetime, fed by the model's phase (start on launch, ask after a fresh pairing, reset on
 * unpair), the app coming back to the foreground, and expo-notifications' taps.
 */

import { router, useNavigationContainerRef, type Href } from 'expo-router'
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AppState } from 'react-native'
import type { RemoteModel } from '../remote/model'
import { DEMO } from '../state/config'
import { useModel } from '../state/RemoteProvider'
import { listen, nativeRegistrarOptions } from './expo'
import { PushRegistrar, type PushPort, type PushRegistrarOptions, type PushState } from './push'
import { TapRouter } from './taps'

const PushContext = createContext<PushRegistrar | null>(null)

/** Demo mode: push looks on, nothing is registered anywhere. */
const demoPort: PushPort = {
  setupChannels: async () => undefined,
  getPermission: async () => ({ status: 'granted', canAskAgain: true }),
  requestPermission: async () => ({ status: 'granted', canAskAgain: true }),
  getExpoPushToken: async () => 'ExponentPushToken[demo]',
  onTokenChange: () => () => undefined
}

function createRegistrar(model: RemoteModel): PushRegistrar {
  const host: Pick<PushRegistrarOptions, 'port' | 'projectId' | 'isDevice' | 'platform'> = DEMO
    ? { port: demoPort, projectId: 'demo', isDevice: true, platform: 'ios' }
    : nativeRegistrarOptions()
  let demoChoice: boolean | null = true
  const prefs = DEMO
    ? { load: async () => demoChoice, save: async (on: boolean) => void (demoChoice = on) }
    : model.pushPrefs()
  return new PushRegistrar({ ...host, prefs, sink: (token) => model.setPushToken(token) })
}

export function PushProvider({ children }: { children: ReactNode }) {
  const model = useModel()
  const navigation = useNavigationContainerRef()
  const [registrar] = useState(() => createRegistrar(model))
  const [taps] = useState(
    () =>
      new TapRouter({
        model,
        navigate: (href) => {
          // A cold start: the model turns `paired` before React mounts the root Stack (the
          // root layout renders nothing while loading). The tap waits for the next state change.
          if (!navigation.isReady()) return false
          const root = navigation.getRootState()
          if (root?.routes[root.index ?? 0]?.state === undefined) return false
          try {
            router.navigate(href as Href)
            return true
          } catch {
            return false
          }
        }
      })
  )
  const phase = useRef(model.getSnapshot().phase)

  // Launch, fresh pairing, unpair.
  useEffect(() => {
    const onChange = () => {
      const next = model.getSnapshot().phase
      const prev = phase.current
      if (next === prev) return
      phase.current = next
      if (next === 'paired') {
        // From the Pair screen: the moment to ask. From launch: only what was chosen before.
        void registrar.start().then(() => (prev === 'unpaired' ? registrar.onPaired() : undefined))
      } else if (next === 'unpaired') {
        taps.cancel()
        registrar.reset()
      }
    }
    if (phase.current === 'paired') void registrar.start()
    const unsubscribe = model.subscribe(onChange)
    return () => {
      unsubscribe()
      taps.cancel()
    }
  }, [model, registrar, taps])

  // Back in the foreground: the permission may have changed in the system Settings, the token may have rotated.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && model.getSnapshot().phase === 'paired') void registrar.refresh()
    })
    return () => sub.remove()
  }, [model, registrar])

  // The root Stack mounted (or the navigation state changed): a tap that could not navigate yet goes now.
  useEffect(() => navigation.addListener('state', () => taps.navigatorReady()), [navigation, taps])

  // Taps open their screen; a push while the app is open becomes a toast.
  useEffect(
    () =>
      listen({
        onTap: (n) => taps.open(n.id, n.data),
        onForeground: (n) => {
          if (model.getSnapshot().phase !== 'paired') return
          model.toast(n.body, 'info')
          model.wake()
        }
      }),
    [model, taps]
  )

  useEffect(() => () => registrar.dispose(), [registrar])

  return <PushContext.Provider value={registrar}>{children}</PushContext.Provider>
}

export function usePushRegistrar(): PushRegistrar {
  const registrar = useContext(PushContext)
  if (!registrar) throw new Error('usePushRegistrar outside PushProvider')
  return registrar
}

export function usePush(): PushState {
  const registrar = usePushRegistrar()
  return useSyncExternalStore(registrar.subscribe, registrar.getSnapshot, registrar.getSnapshot)
}
