import { Hono } from 'hono'
import path from 'path'

const app = new Hono()

// 1. API Routes
app.get('/api/hewo', (c) => {
  return c.json({ message: 'Hello World' })
})

app.get('/favicon.ico', (c) => {
  return c.json({ message: 'No favicon' })
})

app.notFound((c) => {
  return c.sendFile(path.join('./public', '404.html'),'text/html')
})

export default app