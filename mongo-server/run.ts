import { startServer } from './index'

startServer({ host: '127.0.0.1' }).catch((err) => {
  console.error('[leaf-desk-api] failed to start', err)
  process.exit(1)
})
