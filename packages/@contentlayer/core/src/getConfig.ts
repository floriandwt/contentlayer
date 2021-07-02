import { traceAsyncFn } from '@contentlayer/utils'
import type { BuildResult } from 'esbuild'
import { build as esbuild } from 'esbuild'
import { promises as fs } from 'fs'
import * as path from 'path'
import pkgUp from 'pkg-up'
import { firstValueFrom, Observable, of } from 'rxjs'
import { mergeMap } from 'rxjs/operators'

import type { SourcePlugin } from './plugin'

// TODO rename to getSourceWatch
export const getConfigWatch = ({ configPath, cwd }: { configPath: string; cwd: string }): Observable<SourcePlugin> => {
  return getConfig_({ configPath, cwd, watch: true })
}

// TODO rename to getSource
export const getConfig = (async ({ configPath, cwd }: { configPath: string; cwd: string }): Promise<SourcePlugin> => {
  return firstValueFrom(getConfig_({ configPath, cwd, watch: false }))
})['|>'](traceAsyncFn('@contentlayer/core/getConfig:getConfig'))

const getConfig_ = ({
  configPath,
  cwd,
  watch,
}: {
  configPath: string
  cwd: string
  watch: boolean
}): Observable<SourcePlugin> => {
  return of(0).pipe(
    mergeMap(ensureEsbuildBin),
    mergeMap(() => makeTmpDirAndResolveEntryPoint({ configPath, cwd })),
    mergeMap(({ entryPointPath, outfilePath }) =>
      callEsbuild({ entryPointPath, outfilePath, watch }).pipe(
        mergeMap((result) => getConfigFromResult({ result, configPath, outfilePath })),
      ),
    ),
  )
}

const callEsbuild = ({
  outfilePath,
  entryPointPath,
  watch,
}: {
  outfilePath: string
  entryPointPath: string
  watch: boolean
}): Observable<BuildResult> => {
  return new Observable((subscriber) => {
    let result: BuildResult | undefined

    esbuild({
      entryPoints: [entryPointPath],
      outfile: outfilePath,
      sourcemap: true,
      platform: 'node',
      // plugins: [dirnameOverrideEsbuildPlugin()],
      external: [
        'esbuild',
        // TODO make dynamic
        // needed for source-sanity
        '@sanity/core/lib/actions/graphql/getSanitySchema',

        // needed to make chokidar work on OSX (in source-local)
        'fsevents',

        // needed for shiki
        'onigasm',
        'shiki',
      ],
      target: 'es6',
      format: 'cjs',
      bundle: true,
      watch: watch
        ? {
            onRebuild: (error, result) => {
              if (error) {
                subscriber.error(error)
              } else {
                subscriber.next(result!)
              }
            },
          }
        : false,
    })
      .then((result_) => {
        result = result_
        subscriber.next(result)
        if (!watch) {
          subscriber.complete()
        }
      })
      .catch((error) => subscriber.error(error))

    return () => {
      result?.stop?.()
    }
  })
}

/** Fix esbuild binary path if not found (e.g. in local development setup) */
const ensureEsbuildBin = async (): Promise<void> => {
  const esbuildBinPath = path.join(__dirname, '..', 'bin', 'esbuild')
  const esbuildBinExists = await fs
    .stat(esbuildBinPath)
    .then(() => true)
    .catch(() => false)
  if (!esbuildBinExists) {
    const esbuildPackageJsonPath = await pkgUp({ cwd: path.dirname(require.resolve('esbuild')) })
    const esbuildPackagePath = path.dirname(esbuildPackageJsonPath!)
    // wrapping in try/catch is needed to surpress esbuild warning
    try {
      const esbuildPackageJson = require(esbuildPackageJsonPath!)
      const binPath = path.join(esbuildPackagePath, esbuildPackageJson['bin']['esbuild'])
      process.env['ESBUILD_BINARY_PATH'] = binPath
    } catch (_) {}
  }
}

const makeTmpDirAndResolveEntryPoint = async ({ cwd, configPath }: { cwd: string; configPath: string }) => {
  const packageJsonPath = await pkgUp({ cwd })
  const packageDir = path.join(packageJsonPath!, '..')
  // `tmpDir` needs to be in package directory for `require` statements to work
  const tmpDir = path.join(packageDir, 'node_modules', '.tmp', 'contentlayer', 'config')
  await fs.mkdir(tmpDir, { recursive: true })
  const outfilePath = path.join(tmpDir, 'config.js')
  const entryPointPath = path.join(cwd, configPath)

  return { outfilePath, entryPointPath, tmpDir }
}

const getConfigFromResult = (async ({
  result,
  configPath,
  outfilePath,
}: {
  result: BuildResult
  configPath: string
  outfilePath: string
}): Promise<SourcePlugin> => {
  if (result.warnings.length > 0) {
    console.error(result.warnings)
  }

  // wrapping in try/catch is needed to surpress esbuild warning
  try {
    // Needed in case of re-loading when watching the config file for changes
    delete require.cache[require.resolve(outfilePath)]

    // Needed in order for source maps of dynamic file to work
    require('source-map-support').install()

    const exports = require(outfilePath)
    if (!('default' in exports)) {
      throw new Error(`Provided config path (${configPath}) doesn't have a default export.`)
    }

    return exports.default
  } catch (error) {
    console.error(error)
    throw error
  }
})['|>'](traceAsyncFn('@contentlayer/core/getConfig:getConfigFromResult'))
