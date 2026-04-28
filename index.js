import { Hono } from 'hono'

const app = new Hono()

// Epic asset serving
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