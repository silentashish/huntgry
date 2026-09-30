import { powerMonitor, powerSaveBlocker } from 'electron'

/**
 * Keep-awake and wake handling for the pipeline. `prevent-app-suspension`
 * stops idle sleep (the display may still sleep); it does not stop sleep when
 * the lid is closed on battery, which the UI says.
 */

let blockerId: number | null = null

export function keepAwake(on: boolean): void {
  try {
    if (on) {
      if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) blockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
  } catch (err) {
    console.warn('powerSaveBlocker failed:', err)
  }
}

export function isKeepingAwake(): boolean {
  return blockerId !== null && powerSaveBlocker.isStarted(blockerId)
}

export function isOnBattery(): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

/** Usable after `app.whenReady()`. */
export function watchPower(handlers: { onResume(): void; onPowerChange(): void; onShutdown(): void }): void {
  powerMonitor.on('resume', handlers.onResume)
  powerMonitor.on('on-battery', handlers.onPowerChange)
  powerMonitor.on('on-ac', handlers.onPowerChange)
  powerMonitor.on('shutdown', handlers.onShutdown)
}
