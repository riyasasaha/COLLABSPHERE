import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { defineConfig } from 'prisma/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

loadEnv({ path: path.resolve(__dirname, 'server/.env') })

export default defineConfig({
  schema: 'server/prisma/schema.prisma',
})
