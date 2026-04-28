import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'

const app = new Hono()

app.get('/api/hello', (c) => {
  return c.json({ message: 'Hello World' })
})

// Don't ask me what this is idk either.
app.use('*', serveStatic({ root: './' }))

export default app