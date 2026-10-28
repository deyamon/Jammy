import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { isYouTubeApiKeyConfigured, loadProjectEnvironment } from './config.js'

test('loads project-root .env regardless of the current working directory', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'jammy-env-test-'))
  const projectRoot = join(tempRoot, 'project')
  const serverDirectory = join(projectRoot, 'server')
  const otherWorkingDirectory = join(tempRoot, 'elsewhere')
  const originalWorkingDirectory = process.cwd()

  try {
    await mkdir(serverDirectory, { recursive: true })
    await mkdir(otherWorkingDirectory)
    await writeFile(join(projectRoot, '.env'), 'YOUTUBE_API_KEY=fake-test-key\n')
    await writeFile(join(serverDirectory, 'server.js'), '')
    process.chdir(otherWorkingDirectory)

    const isolatedEnvironment = {}
    const resolvedRoot = loadProjectEnvironment(
      pathToFileURL(join(serverDirectory, 'server.js')).href,
      isolatedEnvironment,
    )

    assert.equal(resolvedRoot, projectRoot)
    assert.equal(isolatedEnvironment.YOUTUBE_API_KEY, 'fake-test-key')
    assert.equal(isYouTubeApiKeyConfigured(isolatedEnvironment), true)
    assert.equal(isYouTubeApiKeyConfigured({}), false)

    const example = await readFile(join(originalWorkingDirectory, '.env.example'), 'utf8')
    assert.match(example, /^YOUTUBE_API_KEY=YOUR_YOUTUBE_DATA_API_V3_KEY$/m)
  } finally {
    process.chdir(originalWorkingDirectory)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
