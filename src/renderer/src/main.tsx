import '@mantine/core/styles.css'
// Fonts ship with the app (no network fonts): Geist for UI, Geist Mono for readouts, Bricolage Grotesque for display.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import '@fontsource-variable/bricolage-grotesque'
import './theme/tokens.css'
import './theme/mantine.css'
import './app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import { App } from './App'
import { colorSchemeManager, cssVariablesResolver, theme } from './theme/theme'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      colorSchemeManager={colorSchemeManager}
      defaultColorScheme="auto"
    >
      <App />
    </MantineProvider>
  </StrictMode>
)
