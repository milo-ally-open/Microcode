import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'

const h = React.createElement

const rootElement = document.getElementById('root')
if (!rootElement) throw new Error('Microcode Desktop root element is missing.')

createRoot(rootElement).render(<App />)
