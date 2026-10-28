import { Router } from 'express'

export function createYouTubeRouter({ youtubeService }) {
  const router = Router()
  router.get('/search', async (request, response, next) => {
    try {
      const results = await youtubeService.search(request.query.q)
      response.set('Cache-Control', 'no-store').json({ results })
    } catch (error) { next(error) }
  })
  return router
}
