import { Hono } from 'hono'
import {
  DiaryMoodIconConfigError,
  getDiaryMoodIconConfig,
  updateDiaryMoodIconConfig,
} from '../diaryMoodIcons.js'
import { bad, metadataDb } from './shared.js'

const diaryMoodIconRoutes = new Hono()

diaryMoodIconRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store')
  await next()
})

diaryMoodIconRoutes.get('/', (c) => c.json(getDiaryMoodIconConfig(metadataDb())))

diaryMoodIconRoutes.patch('/', async (c) => {
  const body = await c.req.json().catch(() => null)
  try {
    return c.json(updateDiaryMoodIconConfig(metadataDb(), body))
  } catch (error) {
    if (error instanceof DiaryMoodIconConfigError) {
      return bad(c, error.message, error.code === 'DIARY_MOOD_ICONS_CONFLICT' ? 409 : 400, error.code)
    }
    throw error
  }
})

export default diaryMoodIconRoutes
