export const api = window.huntgry

export function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke prefixes main-process errors; keep only the useful part.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
