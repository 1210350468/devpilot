import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { DEVSPACE_VERSION } from "./version.js";

export const RELEASES_API = "https://api.github.com/repos/1210350468/devpilot/releases";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export interface ReleaseAsset {
  name: string;
  url: string;
}

export interface UpdateRelease {
  tag: string;
  version: string;
  releaseUrl: string;
  publishedAt?: string;
  prerelease: boolean;
  zip: ReleaseAsset;
  checksum: ReleaseAsset;
}

interface GitHubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>;
}

export function localVersion() {
  const marker = join(projectRoot, ".devpilot-portable.json");
  if (existsSync(marker)) {
    try {
      const data = JSON.parse(readFileSync(marker, "utf8")) as { version?: unknown };
      if (typeof data.version === "string" && semver.valid(data.version)) {
        return { version: data.version, portable: true };
      }
    } catch { /* malformed marker must not cause an HTTP 500 */ }
  }
  return { version: DEVSPACE_VERSION, portable: false };
}

export function parseRelease(input: GitHubRelease): UpdateRelease | undefined {
  if (input.draft) return undefined;
  if (typeof input.tag_name !== "string" || !/^v\d+\.\d+\.\d+(?:-(?:beta|rc)\.\d+)?$/.test(input.tag_name)) return undefined;
  const version = input.tag_name.slice(1);
  if (!semver.valid(version)) return undefined;
  if (typeof input.html_url !== "string" || !input.html_url.startsWith("https://github.com/1210350468/devpilot/releases/tag/")) return undefined;
  const filename = `DevPilot-windows-x64-${input.tag_name}.zip`;
  const checksumFilename = `${filename}.sha256`;
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const asset = (name: string): ReleaseAsset | undefined => {
    const match = assets.find(a => a.name === name);
    if (typeof match?.browser_download_url !== "string" ||
        !match.browser_download_url.startsWith("https://github.com/1210350468/devpilot/releases/download/")) return undefined;
    return { name, url: match.browser_download_url };
  };
  const zip = asset(filename);
  const checksum = asset(checksumFilename);
  if (!zip || !checksum) return undefined;
  return {
    tag: input.tag_name,
    version,
    releaseUrl: input.html_url,
    publishedAt: typeof input.published_at === "string" ? input.published_at : undefined,
    prerelease: semver.prerelease(version) !== null || Boolean(input.prerelease),
    zip,
    checksum,
  };
}

export function selectUpdate(releases: readonly GitHubRelease[], current: string, channel: "stable" | "preview") {
  const candidates = releases.map(parseRelease)
    .filter((release): release is UpdateRelease => release !== undefined)
    .filter(release => channel === "preview" || !release.prerelease)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const latest = candidates[0];
  return { latest, available: Boolean(latest && semver.valid(current) && semver.gt(latest.version, current)) };
}

export async function checkForUpdates(channel: "stable" | "preview" = "stable") {
  const current = localVersion();
  const response = await fetch(`${RELEASES_API}?per_page=20`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "DevPilot-update-check" },
    signal: AbortSignal.timeout(7_000),
  });
  if (!response.ok) throw new Error(`GitHub release check failed: HTTP ${response.status}`);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new Error("GitHub returned an unexpected release listing.");
  const chosen = selectUpdate(data as GitHubRelease[], current.version, channel);
  return { current, channel, ...chosen };
}
