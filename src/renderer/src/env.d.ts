/// <reference types="vite/client" />
import type { HuntgryApi } from '@shared/api'

declare global {
  interface Window {
    huntgry: HuntgryApi
  }
}
