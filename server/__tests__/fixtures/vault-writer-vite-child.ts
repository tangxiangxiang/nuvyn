// Subprocess handshake for the single-writer startup contract. Exercising the
// real Vite configureServer hook avoids binding a TCP port while still proving
// that recovery/migration and API middleware mounting cannot complete in a
// second process for the same VAULT_DIR.
const { serverPlugin } = await import('../../vite-plugin.js')

const plugin = serverPlugin()
if (typeof plugin.configureServer !== 'function') {
  throw new Error('configureServer hook is unavailable')
}

await plugin.configureServer({
  middlewares: {
    use() { /* mounted: this process is ready to serve API mutations */ },
  },
} as never)

process.stdout.write('READY:VITE_MUTATION_SERVER\n')
setInterval(() => {}, 60_000)
await new Promise<void>(() => {})
