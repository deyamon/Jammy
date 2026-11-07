import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function projectRootFromModuleUrl(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..')
}

export function loadProjectEnvironment(moduleUrl, processEnv = process.env) {
  const projectRoot = projectRootFromModuleUrl(moduleUrl)
  // Neon CLI writes deployment variables to .env.local. Load it first so it
  // wins over the checked-in template while real process env remains highest.
  dotenv.config({ path: resolve(projectRoot, '.env.local'), processEnv })
  dotenv.config({ path: resolve(projectRoot, '.env'), processEnv })
  return projectRoot
}

export function isYouTubeApiKeyConfigured(processEnv = process.env) {
  return Boolean(processEnv.YOUTUBE_API_KEY?.trim())
}
