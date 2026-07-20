import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import FrequencyAnalyzer from './FrequencyAnalyzer'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <FrequencyAnalyzer />
  </StrictMode>
)