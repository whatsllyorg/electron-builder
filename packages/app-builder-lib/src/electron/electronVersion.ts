import { getProjectRootPath } from "@electron/rebuild/lib/search-module"

import { httpExecutor, InvalidConfigurationError, log } from "builder-util"
import { parseXml } from "builder-util-runtime"
import { readJson } from "fs-extra"
import { Lazy } from "lazy-val"
import * as path from "path"
import * as semver from "semver"
import { Configuration } from "../configuration"
import { getConfig } from "../util/config/config"
import { orNullIfFileNotExist } from "../util/config/load"

export type MetadataValue = Lazy<Record<string, any> | null>

const electronPackages = ["electron", "electron-prebuilt", "electron-prebuilt-compile", "electron-nightly"]

export async function getElectronVersion(projectDir: string, config?: Configuration): Promise<string> {
  if (config == null) {
    config = await getConfig(projectDir, null, null)
  }
  if (config.electronVersion != null) {
    return config.electronVersion
  }
  return computeElectronVersion(projectDir)
}

export async function getElectronVersionFromInstalled(projectDir: string): Promise<string | null> {
  for (const name of electronPackages) {
    try {
      return (await readJson(path.join(projectDir, "node_modules", name, "package.json"))).version
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        log.warn({ name, error: e }, `cannot read electron version package.json`)
      }
    }
  }
  return null
}

export async function getElectronPackage(projectDir: string) {
  for (const name of electronPackages) {
    try {
      return await readJson(path.join(projectDir, "node_modules", name, "package.json"))
    } catch (e: any) {
      if (e.code !== "ENOENT") {
        log.warn({ name, error: e }, `cannot find electron in package.json`)
      }
    }
  }
  return null
}

/** @internal */
export async function computeElectronVersion(projectDir: string): Promise<string> {
  const result = await getElectronVersionFromInstalled(projectDir)
  if (result != null) {
    return result
  }

  const potentialRootDirs = [projectDir, await getProjectRootPath(projectDir)]
  let dependency: NameAndVersion | null = null
  for (const dir of potentialRootDirs) {
    const metadata = await orNullIfFileNotExist(readJson(path.join(dir, "package.json")))
    dependency = metadata ? findFromPackageMetadata(metadata) : null
    if (dependency) {
      break
    }
  }
  if (dependency?.name === "electron-nightly") {
    log.info("You are using a nightly version of electron, be warned that those builds are highly unstable.")
    const feedXml = await httpExecutor.request({
      hostname: "github.com",
      path: `/electron/nightlies/releases.atom`,
      headers: {
        accept: "application/xml, application/atom+xml, text/xml, */*",
      },
    })
    const feed = parseXml(feedXml)
    const latestRelease = feed.element("entry", false, `No published versions on GitHub`)
    const v = /\/tag\/v?([^/]+)$/.exec(latestRelease.element("link").attribute("href"))![1]
    return v.startsWith("v") ? v.substring(1) : v
  } else if (dependency?.version === "latest") {
    log.warn('Electron version is set to "latest", but it is recommended to set it to some more restricted version range.')
    try {
      const releaseInfo = JSON.parse(
        await httpExecutor.request({
          hostname: "github.com",
          path: `/electron/${dependency.name === "electron-nightly" ? "nightlies" : "electron"}/releases/latest`,
          headers: {
            accept: "application/json",
          },
        })
      )
      const version = releaseInfo.tag_name.startsWith("v") ? releaseInfo.tag_name.substring(1) : releaseInfo.tag_name
      log.info({ version }, `resolve ${dependency.name}@${dependency.version}`)
      return version
    } catch (e: any) {
      log.warn(e)
    }

    throw new InvalidConfigurationError(`Cannot find electron dependency to get electron version in the '${path.join(projectDir, "package.json")}'`)
  }
  const version = dependency?.version
  if (version == null || !/^\d/.test(version)) {
    const versionMessage = version == null ? "" : ` and version ("${version}") is not fixed in project`
    throw new InvalidConfigurationError(
      `Cannot compute electron version from installed node modules - none of the possible electron modules are installed${versionMessage}.\nSee https://github.com/electron-userland/electron-builder/issues/3984#issuecomment-504968246`
    )
  }

  return semver.coerce(version)!.format()
}

interface NameAndVersion {
  readonly name: string
  readonly version: string
}

function findFromPackageMetadata(packageData: any): NameAndVersion | null {
  for (const name of electronPackages) {
    const devDependencies = packageData.devDependencies
    let dep = devDependencies == null ? null : devDependencies[name]
    if (dep == null) {
      const dependencies = packageData.dependencies
      dep = dependencies == null ? null : dependencies[name]
    }
    if (dep != null) {
      return { name, version: dep }
    }
  }
  return null
}
