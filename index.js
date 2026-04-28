import express from 'express'

const app = express()

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello World' })
})


// Crap i can't understand.
const handler = {
  async fetch(request, env, ctx) {
    return new Promise((resolve, reject) => {
      const url = new URL(request.url)
      const req2 = Object.assign(request, {
        path: url.pathname,
        query: Object.fromEntries(url.searchParams)
      })
      app(req2, {
        setHeader: () => {},
        end: (body) => resolve(new Response(body))
      }, reject)
    })
  }
}

export default handler