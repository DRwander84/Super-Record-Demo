import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { SettingsProvider } from './settings/SettingsProvider'
import { initLanguage } from './i18n/language'

// Applies the last used language before the first render, so there is no flash.
initLanguage()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </StrictMode>,
)
