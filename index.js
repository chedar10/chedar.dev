import { Hono } from 'hono'

const app = new Hono()

// 1. API Routes
app.get('/api/hewo', (c) => {
  return c.json({ message: 'Hello World' })
})

app.get('/favicon.ico', (c) => {
  return c.json({ message: 'No favicon' })
})

app.notFound((c) => {
  return c.env.ASSETS.fetch(c.req.raw)
})

export default app