import { Router } from 'express'

export function createSpotifyRouter({ spotifyService }) {
  const router = Router()
  router.get('/search', async (request, response, next) => {
    try {
      const results = await spotifyService.search(request.query.q)
      response.set('Cache-Control', 'no-store').json({ results })
    } catch (error) {
      if (error.retryAfter) response.set('Retry-After', String(error.retryAfter))
      next(error)
    }
  })
  return router
}
