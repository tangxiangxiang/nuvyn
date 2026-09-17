import { Hono } from 'hono'
import aiRoutes from './ai/routes.js'
import authRoutes from './auth/routes.js'
import assetRoutes from './assets/routes.js'
import boardRoutes from './board/routes.js'
import boardFolderRoutes from './board/folderRoutes.js'
import boardMaterialRoutes from './board/materialRoutes.js'
import diaryRoutes from './routes/diary.js'
import diaryAccessRoutes from './routes/diaryAccess.js'
import diaryMigrationRoutes from './routes/diaryMigration.js'
import diaryMoodIconRoutes from './routes/diaryMoodIcons.js'
import historyRoutes from './history/routes.js'
import { authBoundary } from './auth/middleware.js'
import folderRoutes from './routes/folders.js'
import healthRoutes from './routes/health.js'
import linkRoutes from './routes/links.js'
import markdownResourceRoutes from './routes/markdownResources.js'
import metadataRoutes from './routes/metadata.js'
import postRoutes from './routes/posts.js'
import tagRoutes from './routes/tags.js'
import vaultIdentityRoutes from './routes/vaultIdentity.js'
import { __setMetadataDbForTesting } from './routes/shared.js'
import vaultRoutes from './routes/vault.js'
import ledgerRoutes from './ledger/routes/index.js'

const app = new Hono()

export { __setMetadataDbForTesting }

// Register the exact default-protected boundary before every application
// route mount. Auth and liveness endpoints are allowed through by method and
// path inside the boundary; unknown /api/* paths fail closed.
app.use('/api/*', authBoundary)

app.route('/', healthRoutes)
app.route('/api/auth', authRoutes)
app.route('/', vaultIdentityRoutes)
app.route('/', metadataRoutes)
app.route('/', folderRoutes)
app.route('/', diaryRoutes)
app.route('/', diaryAccessRoutes)
app.route('/', diaryMigrationRoutes)
app.route('/api/diary/mood-icons', diaryMoodIconRoutes)
app.route('/', postRoutes)
app.route('/', tagRoutes)
app.route('/', vaultRoutes)
app.route('/', linkRoutes)
app.route('/', markdownResourceRoutes)
app.route('/api/ai', aiRoutes)
app.route('/api/assets', assetRoutes)
app.route('/api/board', boardRoutes)
app.route('/api/board-folders', boardFolderRoutes)
app.route('/api/board-materials', boardMaterialRoutes)
app.route('/api/history', historyRoutes)
app.route('/api/ledger', ledgerRoutes)

export default app
