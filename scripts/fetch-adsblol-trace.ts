#!/usr/bin/env node
/**
 * Downloads one aircraft's day from adsb.lol's open history: the readsb
 * trace_full file in the day's release of github.com/adsblol/globe_history_<year>,
 * published under the Open Database License (ODbL 1.0).
 *
 *   node scripts/fetch-adsblol-trace.ts 2026-11-01 a9ab17 [release-tag]
 *
 * Each release is one UTC day as a tar split into parts of up to 2 GB. The
 * parts stream through tar, which stops at the one file wanted, so nothing
 * but that file is kept. The prod release is preferred; staging is used when
 * prod is missing, as adsb.lol advises. Writes the trace, unzipped, to
 * build/sources/adsblol/<date>/trace_full_<icao>.json and the release it came
 * from beside it in release.json. build/ is not committed.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ReleaseAsset { name: string; size: number; browser_download_url: string }
interface Release { tag_name: string; published_at: string; html_url: string; assets: ReleaseAsset[] }

async function findRelease(date: string, wanted?: string): Promise<Release> {
  const year = date.slice(0, 4);
  const day = date.replaceAll("-", ".");
  const tags = wanted ? [wanted] : [`v${day}-planes-readsb-prod-0`, `v${day}-planes-readsb-staging-0`];
  for (const tag of tags) {
    const response = await fetch(`https://api.github.com/repos/adsblol/globe_history_${year}/releases/tags/${tag}`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (response.ok) return await response.json() as Release;
    if (response.status !== 404) throw new Error(`GitHub answered ${response.status} for release ${tag}.`);
  }
  throw new Error(`adsb.lol has not published ${tags.join(" or ")} yet.`);
}

/** tar arguments that write one member to stdout and stop reading once it is found. */
function tarArguments(member: string): string[] {
  const version = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout ?? "";
  return version.includes("bsdtar") ? ["-xOqf", "-", member] : ["-xOf", "-", "--occurrence=1", member];
}

async function extractMember(urls: string[], member: string): Promise<Buffer> {
  const tar = spawn("tar", tarArguments(member), { stdio: ["pipe", "pipe", "inherit"] });
  const chunks: Buffer[] = [];
  tar.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<number | null>(resolve => tar.on("close", resolve));
  // tar closes its input once it has the file; the rest of the download is dropped.
  let stopped = false;
  tar.stdin.on("error", () => { stopped = true; });
  tar.on("close", () => { stopped = true; });
  for (const url of urls) {
    if (stopped) break;
    const response = await fetch(url);
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${url}`);
    let received = 0;
    for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
      if (stopped) break;
      received += chunk.length;
      if (received % (256 << 20) < chunk.length) process.stderr.write(`  ${path.basename(url)}: ${(received / 2 ** 30).toFixed(2)} GiB\n`);
      if (!tar.stdin.write(chunk)) await new Promise(resolve => { tar.stdin.once("drain", resolve); tar.once("close", resolve); });
    }
  }
  if (!stopped) tar.stdin.end();
  const code = await exited;
  const data = Buffer.concat(chunks);
  if (data.length === 0) throw new Error(`${member} is not in the release (tar exited ${code}).`);
  return data;
}

async function main(date: string | undefined, icaoArgument: string | undefined, tag: string | undefined): Promise<void> {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !icaoArgument || !/^[0-9a-f]{6}$/i.test(icaoArgument)) {
    throw new Error("Usage: node scripts/fetch-adsblol-trace.ts <YYYY-MM-DD> <icao24 hex> [release-tag]");
  }
  const icao = icaoArgument.toLowerCase();
  const release = await findRelease(date, tag);
  const parts = release.assets.filter(asset => /\.tar(\.[a-z]{2})?$/.test(asset.name)).sort((a, b) => a.name.localeCompare(b.name));
  if (parts.length === 0) throw new Error(`${release.tag_name} has no tar parts.`);
  console.log(`${release.tag_name}: ${parts.map(part => `${part.name} (${(part.size / 2 ** 30).toFixed(2)} GiB)`).join(", ")}`);
  const member = `./traces/${icao.slice(-2)}/trace_full_${icao}.json`;
  const packed = await extractMember(parts.map(part => part.browser_download_url), member);
  // readsb keeps traces gzipped under a .json name.
  const json = packed[0] === 0x1f && packed[1] === 0x8b ? gunzipSync(packed) : packed;
  JSON.parse(json.toString("utf8"));
  const dir = path.join(root, "build", "sources", "adsblol", date);
  mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `trace_full_${icao}.json`);
  writeFileSync(out, json);
  writeFileSync(path.join(dir, "release.json"), JSON.stringify({
    release: release.tag_name, url: release.html_url, published: release.published_at,
    parts: parts.map(part => part.name), member, retrieved: new Date().toISOString(),
  }, null, 2) + "\n");
  console.log(`${path.relative(root, out)}: ${json.length} bytes`);
}

await main(process.argv[2], process.argv[3], process.argv[4]);
