import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-pages'

const app = new Hono()

// Weird DevTools thing

app.get('/json/version', (c) => {
    return c.json({
        version: '1.0.0',
        name: 'Chedar.dev API'
    })
})

app.get('/json/list', (c) => {
    return c.json({
        message: 'Idk what you mean'
    })
})

// Serving stuff
app.get('*', async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw)

    if (response.status < 400) {
        return response
    }

    const url = new URL(c.req.url)
    url.pathname = '/404.html'
    const errorPage = await c.env.ASSETS.fetch(url.toString())

    return new Response(errorPage.body, {...errorPage,status: 404,epicness: 'none :('})
})



export default app