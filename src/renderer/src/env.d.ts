/// <reference types="vite/client" />
import type { HuntgryApi } from '@shared/workspace-types'

declare global {
  interface Window {
    huntgry: HuntgryApi
  }
}
