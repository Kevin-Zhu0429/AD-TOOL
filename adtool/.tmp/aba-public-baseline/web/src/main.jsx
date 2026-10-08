import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// 发版后旧的按需加载文件会被删掉,还开着旧页面的人切页时会加载失败。
// 这时刷新一次拿新版本;10 秒内只刷一次,防止真出错时无限刷新。
window.addEventListener('vite:preloadError', (event) => {
  let last = 0
  try { last = Number(sessionStorage.getItem('chunkReloadAt')) || 0 } catch { /* 存不了就照样刷新 */ }
  if (Date.now() - last < 10_000) return
  event.preventDefault()
  try { sessionStorage.setItem('chunkReloadAt', String(Date.now())) } catch { /* 同上 */ }
  window.location.reload()
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
