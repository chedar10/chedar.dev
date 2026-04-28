import { Hono } from 'hono'

const app = new Hono()

app.get('/api/hewo', (c) => c.json({ message: 'Hello World' }))

app.notFound(async (c) => {
  const url = new URL(c.req.url)
  url.pathname = '/404.html'
  const response = await c.env.ASSETS.fetch(url.toString())
  return new Response(response.body, {
    ...response,
    status: 404
  })
})

export default app