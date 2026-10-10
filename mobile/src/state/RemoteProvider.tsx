import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { RemoteModel, type RemoteSnapshot } from '../remote/model'
import { Vault } from '../remote/vault'
import { APP_VERSION, DEMO } from './config'
import { DemoModel } from './demo'
import { defaultDeviceName, socketFactory, storage } from './native'

const ModelContext = createContext<RemoteModel | null>(null)

function createModel(): RemoteModel {
  if (DEMO) return new DemoModel()
  return new RemoteModel({ vault: new Vault(storage), socket: socketFactory, appVersion: APP_VERSION, deviceName: defaultDeviceName() })
}

/** One model for the app's lifetime; disconnects in the background, reconnects in the foreground. */
export function RemoteProvider({ children }: { children: ReactNode }) {
  const [model] = useState(createModel)
  useEffect(() => {
    void model.init()
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') model.wake()
      // The relay pushes only to a phone without a socket (#39).
      else if (state === 'background') model.background()
    })
    return () => sub.remove()
  }, [model])
  return <ModelContext.Provider value={model}>{children}</ModelContext.Provider>
}

export function useModel(): RemoteModel {
  const model = useContext(ModelContext)
  if (!model) throw new Error('useModel outside RemoteProvider')
  return model
}

export function useRemote(): RemoteSnapshot {
  const model = useModel()
  return useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot)
}

/** Re-renders every `ms` (relative times, countdowns). */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}
