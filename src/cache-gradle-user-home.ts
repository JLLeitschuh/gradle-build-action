import path from 'path'
import fs from 'fs'
import os from 'os'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as exec from '@actions/exec'

import {AbstractCache, CacheEntryListener, CacheListener} from './cache-base'
import {getCacheKeyPrefix, hashFileNames, tryDelete} from './cache-utils'

const META_FILE_DIR = '.gradle-build-action'

const INCLUDE_PATHS_PARAMETER = 'gradle-home-cache-includes'
const EXCLUDE_PATHS_PARAMETER = 'gradle-home-cache-excludes'
const ARTIFACT_BUNDLES_PARAMETER = 'gradle-home-cache-artifact-bundles'

export class GradleUserHomeCache extends AbstractCache {
    private gradleUserHome: string

    constructor(rootDir: string) {
        super('gradle', 'Gradle User Home')
        this.gradleUserHome = this.determineGradleUserHome(rootDir)
    }

    async afterRestore(listener: CacheListener): Promise<void> {
        await this.reportGradleUserHomeSize('as restored from cache')
        await this.restoreArtifactBundles(listener)
        await this.reportGradleUserHomeSize('after restoring common artifacts')
    }

    private async restoreArtifactBundles(listener: CacheListener): Promise<void> {
        const processes: Promise<void>[] = []

        const bundleMetaFiles = await this.getBundleMetaFiles()
        const bundlePatterns = this.getArtifactBundles()

        // Iterate over all bundle meta files and try to restore
        for (const bundleMetaFile of bundleMetaFiles) {
            const bundle = path.basename(bundleMetaFile, '.cache')
            const entryListener = listener.entry(bundle)
            const bundlePattern = bundlePatterns.get(bundle)

            // Handle case where the 'artifactBundlePatterns' have been changed
            if (bundlePattern === undefined) {
                core.info(`Found bundle metafile for ${bundle} but no such bundle defined`)
                entryListener.markRequested('BUNDLE_NOT_CONFIGURED')
                tryDelete(bundleMetaFile)
            } else {
                const p = bundlePattern.endsWith('/')
                    ? this.restoreArtifactBundle(bundle, bundlePattern, bundleMetaFile, entryListener)
                    : this.restoreArtifactSingles(bundle, bundlePattern, bundleMetaFile, entryListener)
                // Run sequentially when debugging enabled
                if (this.cacheDebuggingEnabled) {
                    await p
                }
                processes.push(p)
            }
        }

        await Promise.all(processes)
    }

    private async restoreArtifactBundle(
        bundle: string,
        bundlePattern: string,
        bundleMetaFile: string,
        listener: CacheEntryListener
    ): Promise<void> {
        const cacheKey = fs.readFileSync(bundleMetaFile, 'utf-8').trim()
        listener.markRequested(cacheKey)

        const restoredEntry = await this.restoreCache([bundlePattern], cacheKey)
        if (restoredEntry) {
            core.info(`Restored ${bundle} with key ${cacheKey} to ${bundlePattern}`)
            listener.markRestored(restoredEntry.key, restoredEntry.size)
        } else {
            core.info(`Did not restore ${bundle} with key ${cacheKey} to ${bundlePattern}`)
            tryDelete(bundleMetaFile)
        }
    }

    private async restoreArtifactSingles(
        bundle: string,
        bundlePattern: string,
        bundleMetaFile: string,
        listener: CacheEntryListener
    ): Promise<void> {
        const cacheKeys = fs
            .readFileSync(bundleMetaFile, 'utf-8')
            .split(',')
            .map(x => x.trim())

        const restoredKeys = []
        for (const cacheKey of cacheKeys) {
            listener.markRequested(cacheKey)

            const restoredEntry = await this.restoreCache([bundlePattern], cacheKey)
            if (restoredEntry) {
                core.info(`Restored ${bundle} with key ${cacheKey} to ${bundlePattern}`)
                listener.markRestored(restoredEntry.key, restoredEntry.size)
                restoredKeys.push(restoredEntry.key)
            } else {
                core.info(`Did not restore ${bundle} with key ${cacheKey} to ${bundlePattern}`)
            }
        }

        if (restoredKeys.length === 0) {
            tryDelete(bundleMetaFile)
        } else {
            this.writeBundleMetaFile(bundleMetaFile, restoredKeys.join(','))
        }
    }

    private getBundleMetaFile(name: string): string {
        return path.resolve(this.gradleUserHome, META_FILE_DIR, `${name}.cache`)
    }

    private async getBundleMetaFiles(): Promise<string[]> {
        const metaFiles = path.resolve(this.gradleUserHome, META_FILE_DIR, '*.cache')
        const globber = await glob.create(metaFiles)
        const bundleFiles = await globber.glob()
        return bundleFiles
    }

    async beforeSave(listener: CacheListener): Promise<void> {
        await this.reportGradleUserHomeSize('before saving common artifacts')
        this.removeExcludedPaths()
        await this.saveArtifactBundles(listener)
        await this.reportGradleUserHomeSize(
            "after saving common artifacts (only 'caches' and 'notifications' will be stored)"
        )
    }

    private removeExcludedPaths(): void {
        const rawPaths: string[] = core.getMultilineInput(EXCLUDE_PATHS_PARAMETER)
        const resolvedPaths = rawPaths.map(x => path.resolve(this.gradleUserHome, x))

        for (const p of resolvedPaths) {
            this.debug(`Deleting excluded path: ${p}`)
            tryDelete(p)
        }
    }

    private async saveArtifactBundles(listener: CacheListener): Promise<void> {
        const processes: Promise<void>[] = []
        for (const [bundle, pattern] of this.getArtifactBundles()) {
            const entryListener = listener.entry(bundle)

            const p = pattern.endsWith('/')
                ? this.saveArtifactBundle(bundle, pattern, entryListener)
                : this.saveArtifactSingles(bundle, pattern, entryListener)
            // Run sequentially when debugging enabled
            if (this.cacheDebuggingEnabled) {
                await p
            }
            processes.push(p)
        }

        await Promise.all(processes)
    }

    private async saveArtifactBundle(
        bundle: string,
        artifactPath: string,
        listener: CacheEntryListener
    ): Promise<void> {
        const bundleMetaFile = this.getBundleMetaFile(bundle)

        const globber = await glob.create(artifactPath, {
            implicitDescendants: false,
            followSymbolicLinks: false
        })
        const bundleFiles = await globber.glob()

        // Handle no matching files
        if (bundleFiles.length === 0) {
            this.debug(`No files found to cache for ${bundle}`)
            if (fs.existsSync(bundleMetaFile)) {
                tryDelete(bundleMetaFile)
            }
            return
        }

        const previouslyRestoredKey = fs.existsSync(bundleMetaFile)
            ? fs.readFileSync(bundleMetaFile, 'utf-8').trim()
            : ''
        const cacheKey = this.createCacheKey(bundle, bundleFiles)

        if (previouslyRestoredKey === cacheKey) {
            this.debug(`No change to previously restored ${bundle}. Not caching.`)
        } else {
            core.info(`Caching ${bundle} with cache key: ${cacheKey}`)
            const savedEntry = await this.saveCache([artifactPath], cacheKey)
            if (savedEntry !== undefined) {
                this.writeBundleMetaFile(bundleMetaFile, cacheKey)
                listener.markSaved(savedEntry.key, savedEntry.size)
            }
        }

        for (const file of bundleFiles) {
            tryDelete(file)
        }
    }

    private async saveArtifactSingles(
        bundle: string,
        artifactPath: string,
        listener: CacheEntryListener
    ): Promise<void> {
        const bundleMetaFile = this.getBundleMetaFile(bundle)

        const globber = await glob.create(artifactPath, {
            implicitDescendants: false,
            followSymbolicLinks: false
        })
        const bundleFiles = await globber.glob()

        // Handle no matching files
        if (bundleFiles.length === 0) {
            this.debug(`No files found to cache for ${bundle}`)
            if (fs.existsSync(bundleMetaFile)) {
                tryDelete(bundleMetaFile)
            }
            return
        }

        const previouslyRestoredKeys = fs.existsSync(bundleMetaFile)
            ? fs
                  .readFileSync(bundleMetaFile, 'utf-8')
                  .split(',')
                  .map(x => x.trim())
            : []

        const newCacheKeys = []
        for (const bundleFile of bundleFiles) {
            const cacheKey = this.createCacheKey(bundle, [bundleFile])
            newCacheKeys.push(cacheKey)

            if (previouslyRestoredKeys.includes(cacheKey)) {
                this.debug(`No change to previously restored ${bundle}. Not caching.`)
            } else {
                core.info(`Caching ${bundleFile} with cache key: ${cacheKey}`)
                const savedEntry = await this.saveCache([artifactPath], cacheKey)
                if (savedEntry !== undefined) {
                    listener.markSaved(savedEntry.key, savedEntry.size)
                }
            }

            tryDelete(bundleFile)
        }

        this.writeBundleMetaFile(bundleMetaFile, newCacheKeys.join(','))
    }

    protected createCacheKey(bundle: string, files: string[]): string {
        const cacheKeyPrefix = getCacheKeyPrefix()
        const relativeFiles = files.map(x => path.relative(this.gradleUserHome, x))
        const key = hashFileNames(relativeFiles)

        this.debug(`Generating cache key for ${bundle} from files: ${relativeFiles}`)

        return `${cacheKeyPrefix}${bundle}-${key}`
    }

    private writeBundleMetaFile(metaFile: string, cacheKey: string): void {
        this.debug(`Writing bundle metafile: ${metaFile}`)

        const dirName = path.dirname(metaFile)
        if (!fs.existsSync(dirName)) {
            fs.mkdirSync(dirName)
        }

        fs.writeFileSync(metaFile, cacheKey)
    }

    protected determineGradleUserHome(rootDir: string): string {
        const customGradleUserHome = process.env['GRADLE_USER_HOME']
        if (customGradleUserHome) {
            return path.resolve(rootDir, customGradleUserHome)
        }

        return path.resolve(os.homedir(), '.gradle')
    }

    protected cacheOutputExists(): boolean {
        // Need to check for 'caches' directory to avoid incorrect detection on MacOS agents
        const dir = path.resolve(this.gradleUserHome, 'caches')
        return fs.existsSync(dir)
    }

    protected getCachePath(): string[] {
        const rawPaths: string[] = core.getMultilineInput(INCLUDE_PATHS_PARAMETER)
        rawPaths.push(META_FILE_DIR)
        const resolvedPaths = rawPaths.map(x => this.resolveCachePath(x))
        this.debug(`Using cache paths: ${resolvedPaths}`)
        return resolvedPaths
    }

    private resolveCachePath(rawPath: string): string {
        if (rawPath.startsWith('!')) {
            const resolved = this.resolveCachePath(rawPath.substring(1))
            return `!${resolved}`
        }
        return path.resolve(this.gradleUserHome, rawPath)
    }

    private getArtifactBundles(): Map<string, string> {
        const artifactBundleDefinition = core.getInput(ARTIFACT_BUNDLES_PARAMETER)
        this.debug(`Using artifact bundle definition: ${artifactBundleDefinition}`)
        const artifactBundles = JSON.parse(artifactBundleDefinition)
        return new Map(Array.from(artifactBundles, ([key, value]) => [key, path.resolve(this.gradleUserHome, value)]))
    }

    private async reportGradleUserHomeSize(label: string): Promise<void> {
        if (!this.cacheDebuggingEnabled) {
            return
        }
        if (!fs.existsSync(this.gradleUserHome)) {
            return
        }
        const result = await exec.getExecOutput('du', ['-h', '-c', '-t', '5M'], {
            cwd: this.gradleUserHome,
            silent: true,
            ignoreReturnCode: true
        })

        core.info(`Gradle User Home (directories >5M): ${label}`)

        core.info(
            result.stdout
                .trimEnd()
                .replace(/\t/g, '    ')
                .split('\n')
                .map(it => {
                    return `  ${it}`
                })
                .join('\n')
        )

        core.info('-----------------------')
    }
}
