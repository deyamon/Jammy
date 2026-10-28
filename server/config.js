import dotenv from 'dotenv'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function projectRootFromModuleUrl(moduleUrl) {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..')
}

export function loadProjectEnvironment(moduleUrl, processEnv = process.env) {
  const projectRoot = projectRootFromModuleUrl(moduleUrl)
  dotenv.config({ path: resolve(projectRoot, '.env'), processEnv })
  return projectRoot
}

export function isYouTubeApiKeyConfigured(processEnv = process.env) {
  return Boolean(processEnv.YOUTUBE_API_KEY?.trim())
}
