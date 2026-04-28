import { Hono } from 'hono'
const app = new Hono()

app.get('/', (c) => c.text('Hono is alive!'))

export default app // Ensure this line exists