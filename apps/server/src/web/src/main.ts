import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then((reg) => console.log('Service Worker registered:', reg.scope))
      .catch((err) => console.error('Service Worker registration failed:', err))
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app

