import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { TraceMap, allGeneratedPositionsFor } from "@jridgewell/trace-mapping"

export type SourceMappedLocation = {
  runtimeAbsolutePath: string
  runtimeFilePath: string
  runtimeUrl: string
  runtimeLine: number
  runtimeColumn: number
}

type CachedSourceMap = {
  generatedAbsolutePath: string
  generatedFilePath: string
  generatedUrl: string
  map: TraceMap
  sources: string[]
}

function walkFiles(
  rootDir: string,
  matcher: (filePath: string) => boolean
): string[] {
  if (!existsSync(rootDir)) {
    return []
  }

  const results: string[] = []
  const queue = [rootDir]

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) {
      continue
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = resolve(current, entry.name)
      if (entry.isDirectory()) {
        queue.push(nextPath)
        continue
      }
      if (matcher(nextPath)) {
        results.push(nextPath)
      }
    }
  }

  return results
}

function replaceSourceDirWithDist(absoluteSourcePath: string): string | null {
  const normalized = absoluteSourcePath.replace(/\\/g, "/")
  const marker = "/src/"
  const markerIndex = normalized.lastIndexOf(marker)
  if (markerIndex === -1) {
    return null
  }

  const prefix = normalized.slice(0, markerIndex)
  const suffix = normalized.slice(markerIndex + marker.length)
  const withoutExtension = suffix.slice(
    0,
    suffix.length - extname(suffix).length
  )
  return resolve(`${prefix}/dist/${withoutExtension}.js.map`)
}

function resolveSourcePathFromMap(
  mapPath: string,
  sourceRoot: string | undefined,
  sourceEntry: string
): string {
  if (isAbsolute(sourceEntry)) {
    return resolve(sourceEntry)
  }

  const baseDir = dirname(mapPath)
  if (sourceRoot) {
    return resolve(baseDir, sourceRoot, sourceEntry)
  }
  return resolve(baseDir, sourceEntry)
}

function buildCachedSourceMap(mapPath: string, cwd: string): CachedSourceMap {
  const raw = JSON.parse(readFileSync(mapPath, "utf8")) as {
    sourceRoot?: string
    sources?: string[]
  }
  const generatedAbsolutePath = mapPath.replace(/\.map$/, "")
  return {
    generatedAbsolutePath,
    generatedFilePath: relative(cwd, generatedAbsolutePath),
    generatedUrl: pathToFileURL(generatedAbsolutePath).href,
    map: new TraceMap(raw as never),
    sources: (raw.sources ?? []).map((sourceEntry) =>
      resolveSourcePathFromMap(mapPath, raw.sourceRoot, sourceEntry)
    ),
  }
}

export class SourceMapResolver {
  private readonly cwd: string
  private readonly sourceMapCache = new Map<string, CachedSourceMap[]>()

  constructor(cwd: string) {
    this.cwd = cwd
  }

  resolveSourceLine(
    absoluteSourcePath: string,
    sourceLine: number
  ): SourceMappedLocation[] {
    const normalizedSourcePath = resolve(absoluteSourcePath)
    const maps = this.getSourceMapsForFile(normalizedSourcePath)

    const locations = maps.flatMap((cached) => {
      const sourceEntry = cached.map.sources.find((_sourceEntry, index) => {
        const resolvedSource = cached.sources[index]
        return resolvedSource === normalizedSourcePath
      })

      if (!sourceEntry) {
        return []
      }

      const generatedPositions = allGeneratedPositionsFor(cached.map, {
        source: sourceEntry,
        line: sourceLine,
        column: 0,
      })

      return generatedPositions.map((position) => ({
        runtimeAbsolutePath: cached.generatedAbsolutePath,
        runtimeFilePath: cached.generatedFilePath,
        runtimeUrl: cached.generatedUrl,
        runtimeLine: position.line,
        runtimeColumn: position.column,
      }))
    })

    const deduped = new Map<string, SourceMappedLocation>()
    for (const location of locations) {
      deduped.set(
        `${location.runtimeAbsolutePath}:${location.runtimeLine}:${location.runtimeColumn}`,
        location
      )
    }

    return [...deduped.values()].sort((left, right) => {
      const byPath = left.runtimeFilePath.localeCompare(right.runtimeFilePath)
      if (byPath !== 0) {
        return byPath
      }
      if (left.runtimeLine !== right.runtimeLine) {
        return left.runtimeLine - right.runtimeLine
      }
      return left.runtimeColumn - right.runtimeColumn
    })
  }

  private getSourceMapsForFile(absoluteSourcePath: string): CachedSourceMap[] {
    const cached = this.sourceMapCache.get(absoluteSourcePath)
    if (cached) {
      return cached
    }

    const candidates = new Set<string>()
    const directCandidate = replaceSourceDirWithDist(absoluteSourcePath)
    if (directCandidate && existsSync(directCandidate)) {
      candidates.add(directCandidate)
    }

    const normalizedSource = absoluteSourcePath.replace(/\\/g, "/")
    const srcIndex = normalizedSource.lastIndexOf("/src/")
    if (srcIndex !== -1) {
      const packageRoot = normalizedSource.slice(0, srcIndex)
      const distRoot = resolve(`${packageRoot}/dist`)
      for (const filePath of walkFiles(distRoot, (candidate) =>
        candidate.endsWith(".js.map")
      )) {
        candidates.add(filePath)
      }
    }

    const maps = [...candidates].map((mapPath) =>
      buildCachedSourceMap(mapPath, this.cwd)
    )
    const matchingMaps = maps.filter((cachedMap) =>
      cachedMap.sources.includes(absoluteSourcePath)
    )

    this.sourceMapCache.set(absoluteSourcePath, matchingMaps)
    return matchingMaps
  }
}
