import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { installInstrumentation } from './utils/instrumentation'

// Install global error / rejection / click instrumentation before the app
// mounts, so we capture failures that happen during the very first render.
installInstrumentation()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
