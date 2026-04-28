import { Hono } from 'hono'

const app = new Hono()

app.get('/api/hewo', (c) => {
  return c.json({ message: 'Hello World' })
})

app.get('/favicon.ico', (c) => {
  return c.json({ message: 'No favicon' })
})

export default app