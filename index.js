import { Hono } from 'hono'

const app = new Hono()

app.use('/', express.static(path.join(__dirname, 'public')));

app.get('/api/hewo', (c) => {
  return c.json({ message: 'Hello World' })
})

app.get('/favicon.ico', (c) => {
  return c.json({ message: 'No favicon' })
})

export default app