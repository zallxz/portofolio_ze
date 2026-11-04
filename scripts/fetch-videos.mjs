// Reads the X post links from index.html (the VIDEOS and PARTNERS lists) and saves
// each post's video files, thumbnail and duration to videos.json, plus each partner's
// current profile photo. The page loads videos.json first, so visitors never depend
// on a third-party API being up. Run by .github/workflows/videos.yml.
//
//   node scripts/fetch-videos.mjs            fetch live data and update videos.json
//   node scripts/fetch-videos.mjs --offline  parse only, print what would be fetched
import { readFile, writeFile } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("videos.json", ROOT);
const UA = "izesaki.xyz video data refresher (+https://izesaki.xyz)";
const offline = process.argv.includes("--offline");

function block(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) return "";
  const end = src.indexOf("\n];", start);
  return src.slice(start, end < 0 ? undefined : end);
}

export function parse(html) {
  const posts = [];
  const seen = new Set();
  /* only the x:"..." field of each entry; proof:"..." links point at posts without the video */
  for (const m of block(html, "VIDEOS").matchAll(/\bx\s*:\s*["'][^"']*?(?:x|twitter)\.com\/([^\/?#"'\s]+)\/status\/(\d+)/gi)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    posts.push({ user: m[1], id: m[2] });
  }
  const handles = [...new Set([...block(html, "PARTNERS").matchAll(/handle\s*:\s*["']([^"']+)["']/g)].map(m => m[1]))];
  return { posts, handles };
}

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await new Promise(res => setTimeout(res, 1500 * (i + 1)));
  }
  return null;
}

/* only MP4 files: browsers other than Safari can't play X's HLS (.m3u8) streams */
function rawFx(j) {
  const t = j && (j.tweet || j.status);
  const vid = t && t.media && t.media.videos && t.media.videos[0];
  if (!vid) return null;
  const seen = new Set();
  let mp4 = [...(vid.formats || []), ...(vid.variants || [])]
    .filter(x => x && x.url && (/mp4/i.test(x.content_type || x.container || "") || /\.mp4(\?|$)/i.test(x.url)))
    .filter(x => !seen.has(x.url) && seen.add(x.url))
    .map(x => ({ url: x.url, bitrate: x.bitrate || 0 }))
    .sort((a, b) => a.bitrate - b.bitrate);
  if (!mp4.length && /\.mp4(\?|$)/i.test(vid.url || "")) mp4 = [{ url: vid.url, bitrate: 0 }];
  if (!mp4.length) return null;
  return { mp4, thumb: vid.thumbnail_url || "", w: vid.width || 0, h: vid.height || 0, dur: vid.duration || 0 };
}
function rawVx(j) {
  const m = j && (j.media_extended || []).find(x => x.type === "video" || x.type === "gif");
  if (!m || !m.url) return null;
  return { mp4: [{ url: m.url, bitrate: 0 }], thumb: m.thumbnail_url || "",
    w: (m.size && m.size.width) || 0, h: (m.size && m.size.height) || 0,
    dur: m.duration_millis ? m.duration_millis / 1000 : 0 };
}

async function main() {
  const html = await readFile(new URL("index.html", ROOT), "utf8");
  const { posts, handles } = parse(html);
  console.log(`Found ${posts.length} video posts and ${handles.length} partners in index.html`);
  if (offline) { console.log(JSON.stringify({ posts, handles }, null, 2)); return; }

  let prev = { videos: {}, avatars: {} };
  try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

  const videos = {};
  let fresh = 0, kept = 0, missing = 0;
  for (const p of posts) {
    const u = encodeURIComponent(p.user);
    const raw = rawFx(await getJSON(`https://api.fxtwitter.com/${u}/status/${p.id}`))
             || rawVx(await getJSON(`https://api.vxtwitter.com/${u}/status/${p.id}`));
    if (raw) { videos[p.id] = raw; fresh++; }
    else if (prev.videos && prev.videos[p.id]) { videos[p.id] = prev.videos[p.id]; kept++; console.warn(`! ${p.id}: lookup failed, kept the saved data`); }
    else { missing++; console.warn(`! ${p.id}: lookup failed and nothing saved yet; the page will look it up live`); }
    await new Promise(res => setTimeout(res, 400)); /* stay polite to the free API */
  }

  const avatars = {};
  for (const h of handles) {
    const j = await getJSON(`https://api.fxtwitter.com/${encodeURIComponent(h)}`);
    const a = j && j.user && j.user.avatar_url;
    const key = h.toLowerCase();
    if (a) avatars[key] = a.replace("_normal", "_200x200");
    else if (prev.avatars && prev.avatars[key]) avatars[key] = prev.avatars[key];
  }

  const same = JSON.stringify({ videos, avatars }) === JSON.stringify({ videos: prev.videos || {}, avatars: prev.avatars || {} });
  console.log(`Videos: ${fresh} fresh, ${kept} kept from last run, ${missing} missing. Partners with photo: ${Object.keys(avatars).length}/${handles.length}`);
  if (same) { console.log("No changes"); return; }
  if (!fresh && posts.length) {
    console.error("Every lookup failed, so videos.json was left as it is.");
    process.exitCode = 1;
    return;
  }
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), videos, avatars }, null, 1) + "\n");
  console.log("videos.json updated");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
