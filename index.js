import { Hono } from 'hono'

const app = new Hono()

app.get('/favicon.ico', () => new Response(null, {status: 418}))
// Serving stuff
app.get('*', async (c) => {
    console.log(`Request for ${c.req.url}`)
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