import express from 'express'

const app = express()

app.get('/api/hello', (req, res) => {
  res.json({ message: 'Hello World' })
})

export default {
  async fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  }
}