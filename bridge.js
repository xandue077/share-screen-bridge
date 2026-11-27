import http from "node:http";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const execFileAsync = promisify(execFile);

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DVSP_DIR = process.env.DVSP_DIR ?? ROOT;
const requireDvsp = createRequire(path.join(ROOT, "package.json"));
const { Client } = requireDvsp("discord.js-selfbot-v13");
const { Streamer, Utils, prepareStream, playStream, Encoders } = await import(
  pathToFileURL(path.join(DVSP_DIR, "dist/index.js")).href
);
const movies = await import(pathToFileURL(path.join(DVSP_DIR, "movies.js")).href);

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";
const SECRET = process.env.BOT_BRIDGE_SECRET ?? readSecret();

const FFMPEG_DIR = process.env.FFMPEG_DIR ?? path.join(ROOT, "bin");
// prepareStream spawns bare `ffmpeg`, so the bundled build has to be on PATH.
process.env.PATH = `${FFMPEG_DIR}:${process.env.PATH ?? ""}`;
const FFMPEG_BIN = process.env.FFMPEG_BIN ?? path.join(FFMPEG_DIR, "ffmpeg");
const YTDLP_BIN = process.env.YTDLP_BIN ?? path.join(FFMPEG_DIR, "yt-dlp");
const FFPROBE_BIN = process.env.FFPROBE_BIN ?? path.join(FFMPEG_DIR, "ffprobe");

let KISSKH_INPUT_OPTIONS = [];
try {
  const help = await execFileAsync(FFMPEG_BIN, ["-hide_banner", "-h", "full"], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
  if (help.stdout.includes("-extension_picky")) KISSKH_INPUT_OPTIONS = ["-extension_picky", "false"];
} catch {
  KISSKH_INPUT_OPTIONS = [];
}

const IDLE_LEAVE_MS = 120_000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const STREAM_OPTS = {
  width: Number(process.env.STREAM_WIDTH ?? 1280),
  height: Number(process.env.STREAM_HEIGHT ?? 720),
  fps: Number(process.env.STREAM_FPS ?? 60),
  bitrateKbps: Number(process.env.STREAM_BITRATE ?? 4500),
  maxBitrateKbps: Number(process.env.STREAM_MAX_BITRATE ?? 8000),
};

function readSecret() {
  try {
    return readFileSync(new URL("./.secret", import.meta.url), "utf8").trim();
  } catch {
    return "";
  }
}

// One Discord client per account token. The panel forwards the token the user
// signed in with, so playback runs as that account instead of a hardcoded one.
const sessions = new Map();
let current = null;
let idleTimer = null;

function isTrackError(error) {
  return /Track is not open|libdatachannel|sendMessageBinary|daveSession/i.test(
    String(error?.message ?? error ?? ""),
  );
}

// libdatachannel throws "Track is not open" for frames that arrive between the
// peer connection reporting connected and the media track actually opening.
function hardenMediaConn(conn) {
  if (!conn || conn.__framesHardened) return conn;
  conn.__framesHardened = true;
  for (const method of ["sendAudioFrame", "sendVideoFrame"]) {
    const original = conn[method];
    if (typeof original !== "function") continue;
    conn[method] = function (...args) {
      try {
        return original.apply(this, args);
      } catch (error) {
        if (isTrackError(error)) return undefined;
        throw error;
      }
    };
  }
  return conn;
}

process.on("uncaughtException", (error) => console.error("uncaught:", error?.message ?? error));
process.on("unhandledRejection", (error) => console.error("unhandled:", error?.message ?? error));

function fail(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function captchaData(captcha) {
  return {
    service: String(captcha?.captcha_service ?? "hcaptcha"),
    sitekey: String(captcha?.captcha_sitekey ?? ""),
    rqdata: captcha?.captcha_rqdata ?? "",
    rqtoken: String(captcha?.captcha_rqtoken ?? ""),
  };
}

function challengeSolver(session) {
  return async (captcha) => {
    session.captcha = captcha;
    const error = new Error("Discord requires a captcha.");
    error.status = 409;
    error.code = "CAPTCHA_REQUIRED";
    error.captcha = captchaData(captcha);
    throw error;
  };
}

async function sessionFor(token) {
  const clean = String(token ?? "").replace(/^Bot\s+/i, "").trim();
  if (!clean) throw fail("Missing account token.", 401);

  const key = createHash("sha256").update(clean).digest("hex").slice(0, 16);
  const existing = sessions.get(key);
  if (existing) {
    existing.usedAt = Date.now();
    return existing;
  }

  const session = { key, token: clean, client: null, streamer: null, usedAt: Date.now(), tag: null, lastError: null };
  const client = new Client({ checkUpdate: false, captchaSolver: challengeSolver(session) });
  const streamer = new Streamer(client);
  session.client = client;
  session.streamer = streamer;
  sessions.set(key, session);

  client.on("error", (error) => {
    session.lastError = String(error?.message ?? error);
    console.error(`client error (${key}):`, session.lastError);
  });

  try {
    await client.login(clean);
  } catch (error) {
    sessions.delete(key);
    throw fail(`Discord rejected that token: ${String(error?.message ?? error)}`, 401);
  }

  session.tag = client.user?.tag ?? client.user?.username ?? key;
  console.log(`session ready: ${session.tag} (${client.guilds.cache.size} guilds)`);
  return session;
}

function normalizeInvite(value) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 300) throw fail("Missing invite link.", 400);

  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^(discord\.(gg|com)|discordapp\.com)(\/|$)/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else if (/^[a-zA-Z0-9_-]{1,120}$/.test(candidate)) {
      return candidate;
    } else {
      throw fail("Invalid invite code.", 400);
    }
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw fail("Invalid invite link.", 400);
  }

  const host = parsed.hostname.toLowerCase();
  const allowedHost =
    host === "discord.gg" ||
    host === "discord.com" ||
    host.endsWith(".discord.com") ||
    host === "discordapp.com" ||
    host.endsWith(".discordapp.com");
  if (!allowedHost) {
    throw fail("Invite must be a discord.gg or discord.com link.", 400);
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  const code = segments.at(-1) ?? "";
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(code)) {
    throw fail("Missing invite code.", 400);
  }
  return candidate;
}

async function joinInvite(token, invite, captchaKey) {
  const cleanInvite = normalizeInvite(invite);
  const session = await sessionFor(token);
  let joined;
  if (captchaKey) {
    const key = String(captchaKey);
    session.client.options.captchaSolver = async () => key;
  }
  try {
    joined = await session.client.acceptInvite(cleanInvite, {
      bypassOnboarding: true,
      bypassVerify: true,
    });
  } catch (error) {
    if (error?.captcha) throw error;
    const message = String(error?.message ?? error);
    if (/captcha/i.test(message) && session.captcha) {
      const captchaError = new Error("Discord requires a captcha.");
      captchaError.status = 409;
      captchaError.code = "CAPTCHA_REQUIRED";
      captchaError.captcha = captchaData(session.captcha);
      throw captchaError;
    }
    const status = /401|invalid token/i.test(message) ? 401 : 502;
    throw fail(`Discord rejected invite: ${message}`, status);
  } finally {
    session.client.options.captchaSolver = challengeSolver(session);
  }

  const guild = joined?.guild?.id ? joined.guild : joined?.id ? joined : null;
  session.usedAt = Date.now();
  return {
    account: {
      id: session.client.user?.id ?? "",
      username: session.client.user?.username ?? session.tag,
      globalName: session.client.user?.globalName ?? null,
    },
    guild: guild
      ? {
          id: String(guild.id ?? ""),
          name: String(guild.name ?? "server"),
          icon: guild.icon ? String(guild.icon) : null,
          memberCount: Number(guild.memberCount ?? 0),
        }
      : null,
    channelId: joined?.channelId ? String(joined.channelId) : null,
    alreadyMember: Boolean(guild?.id && session.client.guilds.cache.has(guild.id)),
  };
}

async function discordApi(token, route, attempt = 0) {
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    headers: { Authorization: token, "User-Agent": "Mozilla/5.0" },
    cache: "no-store",
  });
  if (response.status === 429 && attempt < 3) {
    const body = await response.json().catch(() => ({}));
    const delay = Math.min(Number(body.retry_after ?? 1) * 1000, 5000);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return discordApi(token, route, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw fail(
      `Discord API returned ${response.status}: ${text.slice(0, 160)}`,
      response.status === 401 ? 401 : 502,
    );
  }
  return response.json();
}

async function listGuilds(token) {
  const guilds = [];
  let before = null;
  for (let page = 0; page < 20; page += 1) {
    const query = `?limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`;
    const batch = await discordApi(token, `/users/@me/guilds${query}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    guilds.push(...batch);
    if (batch.length < 200) break;
    before = batch[batch.length - 1]?.id ?? null;
    if (!before) break;
  }
  return guilds;
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      output[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}

async function listVoiceChannels(token) {
  const guilds = await listGuilds(token);
  const groups = await mapLimit(guilds, 8, async (guild) => {
    try {
      const channels = await discordApi(token, `/guilds/${guild.id}/channels`);
      if (!Array.isArray(channels)) return null;
      const voice = channels
        .filter((channel) => channel.type === 2 || channel.type === 13)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map((channel) => ({
          id: String(channel.id),
          name: String(channel.name ?? "voice"),
          type: Number(channel.type),
          parentId: channel.parent_id ? String(channel.parent_id) : null,
        }));
      if (voice.length === 0) return null;
      return {
        id: String(guild.id),
        name: String(guild.name ?? "server"),
        icon: guild.icon ? String(guild.icon) : null,
        channels: voice,
      };
    } catch {
      return null;
    }
  });
  return groups
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const PIPED_INSTANCES = [
  "https://api.piped.private.coffee",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.leptons.xyz",
];

const INVIDIOUS_INSTANCES = [
  "https://yt.chocolatemoo53.com",
  "https://inv.nadeko.net",
  "https://invidious.tiekoetter.com",
];

function pickPipedUrl(data) {
  const streams = Array.isArray(data?.videoStreams) ? data.videoStreams : [];
  const candidates = streams
    .filter((stream) =>
      stream?.url &&
      stream.videoOnly === false &&
      /video\/mp4/i.test(String(stream.mimeType ?? "")) &&
      !/hls/i.test(String(stream.format ?? ""))
    )
    .map((stream) => ({
      url: stream.url,
      score:
        (String(stream.format ?? "").toUpperCase() === "MPEG_4" ? 1000 : 0) +
        (Number.parseInt(String(stream.quality ?? ""), 10) || 0),
    }))
    .sort((left, right) => right.score - left.score);
  return candidates[0]?.url ?? null;
}

async function loadPipedInstances() {
  const instances = new Set(PIPED_INSTANCES);
  try {
    const response = await fetch(
      "https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md",
      { signal: AbortSignal.timeout(15_000) },
    );
    if (response.ok) {
      const text = await response.text();
      for (const match of text.matchAll(/https:\/\/[^\s|)]+/g)) {
        const url = match[0].replace(/[),.;]+$/, "");
        if (/^https:\/\/(piped|api\.)/i.test(url) && !url.includes("/registered/")) {
          instances.add(url);
        }
      }
    }
  } catch {}
  return [...instances].slice(0, 24);
}

async function resolveYouTubeViaPiped(input) {
  const match = String(input).match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/);
  const videoId = match?.[1];
  if (!videoId) return null;
  const instances = await loadPipedInstances();
  const results = await Promise.allSettled(
    instances.map(async (instance) => {
      const response = await fetch(`${instance}/streams/${videoId}`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return null;
      return pickPipedUrl(await response.json());
    }),
  );
  for (const result of results) {
    if (result.status === "fulfilled" && result.value) return result.value;
  }
  return null;
}

async function resolveYouTubeViaInvidious(input) {
  const match = String(input).match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/);
  const videoId = match?.[1];
  if (!videoId) return null;
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const response = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) continue;
      const data = await response.json();
      const progressive = (Array.isArray(data?.formatStreams) ? data.formatStreams : [])
        .filter((stream) => stream?.url && /video\/mp4/i.test(String(stream.type ?? "")))
        .sort((left, right) => (Number(right.qualityLabel?.match(/\d+/)?.[0]) || 0) - (Number(left.qualityLabel?.match(/\d+/)?.[0]) || 0));
      if (progressive[0]?.url) return progressive[0].url;
      if (data?.hlsUrl) return data.hlsUrl;
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveYouTube(input) {
  const pipedUrl = await resolveYouTubeViaPiped(input);
  if (pipedUrl) return pipedUrl;
  const invidiousUrl = await resolveYouTubeViaInvidious(input);
  if (invidiousUrl) return invidiousUrl;

  const format =
    "18/best[height<=720][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]";
  let lastError = null;
  for (const playerClient of ["android_vr", "android", "tv", "ios", "web_safari"]) {
    try {
      const { stdout } = await execFileAsync(
        YTDLP_BIN,
        [
          "--no-playlist",
          "--format",
          format,
          "--ffmpeg-location",
          FFMPEG_DIR,
          "--extractor-args",
          `youtube:player_client=${playerClient}`,
          "--get-url",
          input,
        ],
        { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      );
      const mediaUrl = stdout.trim().split(/\r?\n/)[0];
      if (/^https?:\/\//i.test(mediaUrl)) return mediaUrl;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = String(lastError?.stderr ?? lastError?.message ?? "no url").slice(0, 200);
  throw fail(`YouTube resolve failed. ${detail}`, 502);
}

async function resolveKisskh(title) {
  const movie = await movies.resolveMovie(title);
  let subtitlePath = null;
  const subtitle = movies.pickEnglishSubtitle(movie.subtitles);
  if (subtitle?.url) {
    subtitlePath = await movies.downloadSubtitle(subtitle.url, "bridge").catch(() => null);
  }
  return {
    mediaUrl: movie.url,
    headers: movie.headers ?? {},
    inputOptions: movie.provider === "kisskh" ? KISSKH_INPUT_OPTIONS : (movie.inputOptions ?? []),
    subtitlePath,
    label: `${movie.title}${movie.year ? ` (${movie.year})` : ""}`,
  };
}

function stopCurrent() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const entry = current;
  current = null;
  if (!entry) return;
  entry.controller.abort();
  try {
    entry.streamer.leaveVoice();
  } catch {
    /* already gone */
  }
}

function scheduleIdleLeave(streamer) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (!current) {
      try {
        streamer.leaveVoice();
      } catch {
        /* already gone */
      }
    }
  }, IDLE_LEAVE_MS);
}

function withTimeout(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail(message, 504)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function positionOf(entry) {
  if (!entry) return 0;
  if (entry.paused) return entry.positionBase;
  return entry.positionBase + (Date.now() - entry.startedAt) / 1000;
}

async function hlsDuration(media, depth = 0) {
  if (depth > 2) return 0;
  try {
    const response = await fetch(media.mediaUrl, {
      headers: { "User-Agent": "ffmpeg", ...(media.headers ?? {}) },
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) return 0;
    const lines = (await response.text()).split(/\r?\n/).map((line) => line.trim());
    if (lines.some((line) => line.startsWith("#EXT-X-STREAM-INF"))) {
      const variant = lines.find((line) => line && !line.startsWith("#"));
      if (!variant) return 0;
      return hlsDuration(
        { ...media, mediaUrl: new URL(variant, media.mediaUrl).href },
        depth + 1,
      );
    }
    const total = lines
      .filter((line) => line.startsWith("#EXTINF:"))
      .reduce((sum, line) => {
        const seconds = Number.parseFloat(line.slice(8));
        return sum + (Number.isFinite(seconds) ? seconds : 0);
      }, 0);
    return Math.round(total);
  } catch {
    return 0;
  }
}

async function durationOf(entry) {
  const media = entry?.media;
  if (!media) return 0;
  const headers = Object.entries(media.headers ?? {})
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  try {
    const { stdout } = await execFileAsync(
      FFPROBE_BIN,
      [
        "-v",
        "error",
        "-user_agent",
        "ffmpeg",
        ...(headers ? ["-headers", headers] : []),
        ...(media.inputOptions ?? []),
        "-show_entries",
        "format=duration",
        "-of",
        "default=nk=1:nw=1",
        media.mediaUrl,
      ],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    const seconds = Number.parseFloat(stdout.trim().split(/\s+/)[0]);
    if (Number.isFinite(seconds) && seconds > 0) {
      entry.duration = Math.round(seconds);
    }
  } catch {
    /* HLS and live sources may not report a duration */
  }
  if (!entry.duration) {
    entry.duration = await hlsDuration(media);
  }
  return entry.duration || 0;
}

function haltEntry(entry) {
  if (!entry?.controller) return;
  entry.controller.abort();
  entry.volumeControl = null;
}

async function startStream(entry) {
  const { streamer } = entry;
  if (!streamer.voiceConnection) {
    await withTimeout(
      streamer.joinVoice(entry.guildId, entry.channelId),
      30_000,
      "Joining the voice channel timed out.",
    );
  }
  if (current !== entry) {
    try {
      streamer.leaveVoice();
    } catch {
      /* already gone */
    }
    return;
  }
  hardenMediaConn(streamer.voiceConnection?.webRtcConn);

  const controller = new AbortController();
  entry.controller = controller;
  const seek = Math.max(0, entry.positionBase || 0);
  const media = entry.media;

  const { command, output, promise, controller: volumeControl } = prepareStream(
    media.mediaUrl,
    {
      encoder: Encoders.software({
        x264: { preset: "ultrafast", tune: "zerolatency" },
        x265: { preset: "ultrafast", tune: "zerolatency" },
      }),
      minimizeLatency: false,
      width: STREAM_OPTS.width,
      height: STREAM_OPTS.height,
      frameRate: STREAM_OPTS.fps,
      bitrateVideo: STREAM_OPTS.bitrateKbps,
      bitrateVideoMax: STREAM_OPTS.maxBitrateKbps,
      videoCodec: Utils.normalizeVideoCodec("H264"),
      customFfmpegFlags: [
        ...(seek > 0 ? ["-ss", seek.toFixed(1)] : []),
        ...(media.subtitlePath
          ? [
              "-vf",
              `scale=${STREAM_OPTS.width}:${STREAM_OPTS.height},subtitles='${media.subtitlePath}'`,
            ]
          : []),
        "-bufsize:v",
        `${Math.round(STREAM_OPTS.maxBitrateKbps / 1.5)}k`,
        "-x264-params",
        "sliced-threads=1:rc-lookahead=0:sync-lookahead=0",
      ],
      customHeaders: {
        "User-Agent": "ffmpeg",
        Connection: "keep-alive",
        ...media.headers,
      },
      customInputOptions: [
        "-fflags",
        "nobuffer",
        "-flags",
        "low_delay",
        "-flush_packets",
        "1",
        "-max_delay",
        "100000",
        ...media.inputOptions,
      ],
    },
    controller.signal,
  );

  entry.volumeControl = volumeControl;
  entry.startedAt = Date.now();
  if (entry.volume !== 1 && volumeControl?.setVolume) {
    void volumeControl.setVolume(entry.volume);
  }

  command.on("stderr", (line) => {
    entry.ffmpegTail.push(line);
    if (entry.ffmpegTail.length > 40) entry.ffmpegTail.shift();
  });
  command.on("error", (error) => {
    console.error("ffmpeg:", error.message);
    if (current === entry) stopCurrent();
  });
  void promise.catch((error) => {
    if (!controller.signal.aborted) {
      entry.lastError = String(error?.message ?? error);
      console.error("ffmpeg failed:", entry.lastError);
    }
  });

  void playStream(output, streamer, { type: "go-live" }, controller.signal)
    .catch((error) => {
      if (!controller.signal.aborted) {
        entry.lastError = String(error?.message ?? error);
        console.error("playStream failed:", entry.lastError);
      }
    })
    .finally(() => {
      if (current === entry && !entry.paused && !controller.signal.aborted) {
        current = null;
        scheduleIdleLeave(streamer);
      }
    });
}

// Resolving a YouTube URL can take minutes on a slow link, and Cloudflare puts a
// hard 100s ceiling on tunneled requests, so the HTTP call only starts the job and
// the work continues in the background. Progress and errors show up on /health.
async function play(payload) {
  const session = await sessionFor(payload.token);
  const { client, streamer } = session;

  const guildId = String(payload.guildId ?? "");
  const channelId = String(payload.channelId ?? "");
  if (!/^\d{15,25}$/.test(guildId) || !/^\d{15,25}$/.test(channelId)) {
    throw fail("Invalid guild or channel id.");
  }

  const channel =
    client.channels?.cache?.get(channelId) ??
    (await client.channels?.fetch(channelId).catch(() => null));
  if (!channel) throw fail("Channel not found for this account.", 404);
  if (channel.type === 13) {
    throw fail("That is a stage channel; pick a normal voice channel.", 400);
  }
  if (typeof channel.joinable === "boolean" && !channel.joinable) {
    throw fail("This account cannot join that channel (missing Connect permission).", 403);
  }

  const source = payload.source === "kisskh" ? "kisskh" : "youtube";
  const title = String(payload.title ?? "").trim();
  const url = String(payload.url ?? "").trim();
  if (source === "kisskh" && !title) throw fail("Missing movie title.");
  if (source !== "kisskh" && !/^https?:\/\//i.test(url)) throw fail("Missing video url.");

  stopCurrent();
  const entry = {
    streamer,
    client,
    account: session.tag,
    label: "resolving…",
    source,
    guildId,
    channelId,
    startedAt: Date.now(),
    positionBase: 0,
    duration: 0,
    volume: 1,
    paused: false,
    media: null,
    controller: null,
    volumeControl: null,
    lastError: null,
    ffmpegTail: [],
  };
  current = entry;

  void (async () => {
    try {
      const media =
        source === "kisskh"
          ? await resolveKisskh(title)
          : {
              mediaUrl: await resolveYouTube(url),
              headers: {},
              inputOptions: [],
              subtitlePath: null,
              label: String(payload.title ?? url),
            };

      if (current !== entry || entry.paused) return;
      entry.media = media;
      entry.label = media.label;
      void durationOf(entry);
      await startStream(entry);
    } catch (error) {
      if (current === entry) {
        entry.lastError = String(error?.message ?? error);
        console.error("play failed:", entry.lastError);
        stopCurrent();
      }
    }
  })();

  return { label: entry.label, kind: source, account: session.tag, starting: true };
}

function streamStatus() {
  const entry = current;
  return {
    ok: true,
    playing: Boolean(entry),
    paused: Boolean(entry?.paused),
    starting: Boolean(entry && !entry.media),
    label: entry?.label || "",
    position: Math.floor(positionOf(entry)),
    duration: entry?.duration || 0,
    volume: entry?.volume ?? 1,
    source: entry?.source || "",
    guildId: entry?.guildId || "",
    channelId: entry?.channelId || "",
    account: entry?.account || "",
    lastError: entry?.lastError || null,
  };
}

async function control(body) {
  const action = String(body?.action ?? "");
  const entry = current;

  if (action === "stop") {
    stopCurrent();
    return { action, stopped: true };
  }
  if (!entry) throw fail("Nothing is playing.", 409);

  if (action === "pause") {
    if (!entry.paused) {
      entry.positionBase = positionOf(entry);
      entry.paused = true;
      haltEntry(entry);
    }
    return { action, paused: true, position: Math.floor(entry.positionBase) };
  }

  if (action === "resume") {
    if (entry.paused) {
      if (!entry.media) throw fail("Media is still resolving.", 409);
      entry.paused = false;
      await startStream(entry);
    }
    return { action, paused: false, position: Math.floor(positionOf(entry)) };
  }

  if (action === "seek") {
    const seconds = Number(body?.seconds);
    if (!Number.isFinite(seconds) || seconds < 0) throw fail("Invalid seek position.");
    const position = entry.duration
      ? Math.min(seconds, Math.max(0, entry.duration - 1))
      : seconds;
    entry.positionBase = position;
    entry.startedAt = Date.now();
    if (!entry.paused) {
      if (!entry.media) throw fail("Media is still resolving.", 409);
      haltEntry(entry);
      await startStream(entry);
    }
    return { action, position: Math.floor(position) };
  }

  if (action === "volume") {
    const volume = Number(body?.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 2) {
      throw fail("Volume must be between 0 and 2.");
    }
    entry.volume = volume;
    const applied = entry.volumeControl?.setVolume
      ? await entry.volumeControl.setVolume(volume)
      : false;
    return { action, volume, applied };
  }

  throw fail("Unknown control action.");
}

async function probe(title) {
  const media = await resolveKisskh(title);
  const headers = Object.entries(media.headers)
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  let stdout = "";
  let stderr = "";
  try {
    ({ stdout, stderr } = await execFileAsync(
      FFPROBE_BIN,
      [
        "-v",
        "error",
        "-user_agent",
        "ffmpeg",
        ...(headers ? ["-headers", headers] : []),
        ...media.inputOptions,
        "-show_entries",
        "stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        media.mediaUrl,
      ],
      { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    ));
  } catch (error) {
    stderr = String(error?.stderr ?? error?.message ?? "");
    stdout = String(error?.stdout ?? "");
  }
  if (!stdout.trim()) throw fail(`ffprobe failed: ${stderr.slice(0, 300)}`, 502);
  return { label: media.label, streams: JSON.parse(stdout).streams ?? [] };
}

function normalizeTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Kisskh's search only matches some titles ("matrix" finds nothing, "john wick"
// ranks an unrelated drama first), so cinemeta backs it up and the merged list is
// ranked by how well the title matches the query.
function queryScore(title, query) {
  const candidate = normalizeTitle(title);
  const needle = normalizeTitle(query);
  if (!needle) return 0;
  if (candidate === needle) return 4;
  if (candidate.startsWith(needle)) return 3;
  if (candidate.includes(needle)) return 2;
  const words = new Set(needle.split(" "));
  const hits = candidate.split(" ").filter((word) => words.has(word)).length;
  return hits > 0 ? hits / words.size : 0;
}

async function searchKisskh(query) {
  const [kisskh, cinemeta] = await Promise.all([
    movies.searchKisskh(query).catch(() => []),
    movies.searchMovies(query, 10).catch(() => []),
  ]);

  const items = [
    ...kisskh.map((item) => {
      const thumb = String(item.thumbnail ?? "");
      const image = thumb.startsWith("//")
        ? `https:${thumb}`
        : thumb.startsWith("/")
        ? `https://kisskh.do${thumb}`
        : thumb;
      return {
        id: String(item.id ?? ""),
        title: String(item.title ?? ""),
        year: String(item.releaseDate ?? "").slice(0, 4),
        episodes: Number(item.episodesCount ?? 0),
        thumb: image,
        source: "kisskh",
      };
    }),
    ...cinemeta.map((meta) => ({
      id: "",
      title: String(meta.title ?? ""),
      year: String(meta.year ?? "").slice(0, 4),
      episodes: 0,
      thumb: String(meta.poster ?? ""),
      source: "auto",
    })),
  ];

  const seen = new Set();
  return items
    .filter((item) => item.title)
    .sort((a, b) => queryScore(b.title, query) - queryScore(a.title, query))
    .filter((item) => {
      const key = `${normalizeTitle(item.title)}|${item.year}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(payload);
}

const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/app.js", "app.js"],
  ["/styles.css", "styles.css"],
  ["/config.js", "config.js"],
]);

const STATIC_TYPES = new Map([
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["config.js", "text/javascript; charset=utf-8"],
]);

function serveStatic(res, pathname) {
  const file = STATIC_FILES.get(pathname);
  if (!file) return false;
  let body;
  try {
    body = readFileSync(path.join(PUBLIC_DIR, file));
  } catch {
    return false;
  }
  res.writeHead(200, {
    "Content-Type": STATIC_TYPES.get(file) ?? "application/octet-stream",
    "Content-Length": body.length,
    "Cache-Control": "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
  return true;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("Body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sessionSummary() {
  return [...sessions.values()].map((session) => ({
    account: session.tag,
    guilds: session.client.guilds?.cache?.size ?? 0,
    lastError: session.lastError,
  }));
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [key, session] of sessions) {
    if (session.usedAt < cutoff && current?.client !== session.client) {
      try {
        session.streamer.leaveVoice();
      } catch {
        /* ignore */
      }
      session.client.destroy();
      sessions.delete(key);
    }
  }
}, 10 * 60 * 1000).unref();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bridge");
  const authorized = SECRET.length > 0 && req.headers.authorization === `Bearer ${SECRET}`;

  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Max-Age": "86400",
      });
      return res.end();
    }

    if (req.method === "GET" && url.pathname === "/debug-fetch") {
      if (!authorized) return send(res, 401, { ok: false, error: "Bad bridge secret." });
      const target = new URL(url.searchParams.get("url") ?? "");
      if (
        !["kisskh.do", "enc-dec.app"].includes(target.hostname) &&
        !target.hostname.endsWith(".cdnvideo11.shop") &&
        !target.hostname.endsWith(".verois3.site") &&
        !target.hostname.endsWith(".chocolatemoo53.com")
      )
        return send(res, 400, { ok: false, error: "Bad target." });
      const candidates = [
        target.toString(),
        `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
        `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(target)}`,
        `https://corsproxy.io/?url=${encodeURIComponent(target)}`,
        `https://api.cors.lol/?url=${encodeURIComponent(target)}`,
      ];
      const results = await Promise.all(
        candidates.map(async (candidate) => {
          try {
            const response = await fetch(candidate, { signal: AbortSignal.timeout(15000) });
            const body = await response.text();
            return { url: candidate, status: response.status, body: body.slice(0, 160) };
          } catch (error) {
            return { url: candidate, error: error.cause?.code ?? error.message };
          }
        }),
      );
      return send(res, 200, { ok: true, results });
    }

    if (req.method === "GET" && url.pathname === "/debug-probe") {
      if (!authorized) return send(res, 401, { ok: false, error: "Bad bridge secret." });
      const title = (url.searchParams.get("title") ?? "").trim();
      if (!title) return send(res, 400, { ok: false, error: "Missing title." });
      const media = await resolveKisskh(title);
      const headers = Object.entries(media.headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      let stdout = "";
      let stderr = "";
      try {
        ({ stdout, stderr } = await execFileAsync(
          FFPROBE_BIN,
          [
            "-v", "error", "-user_agent", "ffmpeg",
            ...(headers ? ["-headers", headers] : []),
            ...(media.inputOptions ?? []),
            "-show_entries", "stream=codec_type,codec_name,width,height",
            "-of", "json", media.mediaUrl,
          ],
          { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
        ));
      } catch (error) {
        stdout = String(error?.stdout ?? "");
        stderr = String(error?.stderr ?? error?.message ?? "");
      }
      return send(res, 200, {
        ok: true,
        label: media.label,
        mediaUrl: media.mediaUrl,
        stdout: stdout.slice(0, 2000),
        stderr: stderr.slice(0, 2000),
      });
    }

    if (req.method === "GET" && url.pathname === "/debug-visitor") {
      if (!authorized) return send(res, 401, { ok: false, error: "Bad bridge secret." });
      try {
        const page = await fetch("https://www.youtube.com/");
        const html = await page.text();
        const visitorData = html.match(/"VISITOR_DATA":"([^"]+)"/)?.[1] ?? "";
        return send(res, 200, { ok: Boolean(visitorData), status: page.status, visitorData });
      } catch (error) {
        return send(res, 502, { ok: false, error: String(error?.message ?? error).slice(0, 500) });
      }
    }

    if (req.method === "GET" && url.pathname === "/debug-youtube") {
      if (!authorized) return send(res, 401, { ok: false, error: "Bad bridge secret." });
      const videoUrl = (url.searchParams.get("url") ?? "").trim();
      if (!/^https:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(videoUrl))
        return send(res, 400, { ok: false, error: "Bad YouTube URL." });
      try {
        const mediaUrl = await resolveYouTube(videoUrl);
        return send(res, 200, { ok: true, mediaUrl: mediaUrl.slice(0, 300) });
      } catch (error) {
        return send(res, 502, {
          ok: false,
          error: String(error?.stderr ?? error?.message ?? error).slice(0, 20000),
        });
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return send(res, 200, {
        ok: true,
        ready: true,
        accounts: sessionSummary(),
        streaming: current
          ? {
              label: current.label,
              source: current.source,
              account: current.account,
              guildId: current.guildId,
              channelId: current.channelId,
              paused: current.paused,
              position: Math.floor(positionOf(current)),
              duration: current.duration || 0,
            }
          : null,
        ffmpeg: FFMPEG_DIR,
      });
    }

    if (req.method === "GET" && url.pathname === "/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) return send(res, 400, { ok: false, error: "Missing q." });
      return send(res, 200, { ok: true, items: await searchKisskh(query) });
    }

    if (req.method === "POST" && url.pathname === "/verify") {
      const body = await readBody(req);
      const session = await sessionFor(body.token);
      return send(res, 200, {
        ok: true,
        account: {
          id: session.client.user?.id ?? "",
          username: session.client.user?.username ?? session.tag,
          globalName: session.client.user?.globalName ?? null,
          avatar: session.client.user?.avatar ?? null,
          isBot: Boolean(session.client.user?.bot),
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/channels") {
      const body = await readBody(req);
      const session = await sessionFor(body.token);
      const groups = await listVoiceChannels(session.token);
      return send(res, 200, {
        ok: true,
        account: {
          id: session.client.user?.id ?? "",
          username: session.client.user?.username ?? session.tag,
          globalName: session.client.user?.globalName ?? null,
          avatar: session.client.user?.avatar ?? null,
          isBot: Boolean(session.client.user?.bot),
        },
        groups,
        servers: groups.length,
        channels: groups.reduce((sum, group) => sum + group.channels.length, 0),
      });
    }

    if (
      req.method === "POST" &&
      (url.pathname === "/join" || url.pathname === "/invite-join")
    ) {
      const body = await readBody(req);
      const result = await joinInvite(body.token, body.invite, body.captchaKey);
      return send(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/captcha-debug") {
      const body = await readBody(req);
      const lines = Array.isArray(body.lines) ? body.lines.slice(0, 32) : [];
      for (const line of lines) console.log("[browser-debug]", String(line).slice(0, 1000));
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return send(res, 200, streamStatus());
    }

    if (req.method === "POST" && url.pathname === "/control") {
      const body = await readBody(req);
      return send(res, 200, { ok: true, ...(await control(body)) });
    }

    if (url.pathname === "/probe" || url.pathname === "/stop") {
      if (!authorized) return send(res, 401, { ok: false, error: "Bad bridge secret." });
    }

    if (req.method === "GET" && url.pathname === "/probe") {
      const title = (url.searchParams.get("title") ?? "").trim();
      if (!title) return send(res, 400, { ok: false, error: "Missing title." });
      return send(res, 200, { ok: true, ...(await probe(title)) });
    }

    if (req.method === "POST" && url.pathname === "/play") {
      const body = await readBody(req);
      const result = await play(body);
      return send(res, 200, { ok: true, ...result });
    }

    if (req.method === "POST" && url.pathname === "/stop") {
      stopCurrent();
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && serveStatic(res, url.pathname)) return;

    return send(res, 404, { ok: false, error: "Not found." });
  } catch (error) {
    const status = Number(error?.status ?? 500);
    const message = String(error?.message ?? error);
    console.error(`${req.method} ${url.pathname} -> ${status}: ${message}`);
    const body = { ok: false, error: message };
    if (error?.code) body.code = error.code;
    if (error?.captcha) body.captcha = error.captcha;
    return send(res, status, body);
  }
});

server.listen(PORT, HOST, () => console.log(`bridge listening on ${HOST}:${PORT} (video + audio)`));

function shutdown() {
  stopCurrent();
  for (const session of sessions.values()) {
    try {
      session.client.destroy();
    } catch {
      /* ignore */
    }
  }
  server.close();
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
