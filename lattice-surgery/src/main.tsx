import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import LatticeSurgeryVisualizer from './LatticeSurgeryVisualizer'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LatticeSurgeryVisualizer />
  </StrictMode>,
)