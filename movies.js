import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const YIFY = "https://www.yifysubtitles.ch";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const KISSKH = "https://kisskh.do";
const KISSKH_HEADERS = {
    "User-Agent": UA,
    Referer: `${KISSKH}/`,
    Origin: KISSKH,
};
const KKEY_API = "https://enc-dec.app/api/enc-kisskh";

const VIXSRC = "https://vixsrc.to";
const VIXSRC_HEADERS = { "User-Agent": UA, Referer: `${VIXSRC}/` };

const SUBTITLE_DIR = "/tmp/dvsp-subs";
const SUBTITLE_TTL_MS = 30 * 60 * 1000;

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;

const PROXY_BUILDERS = [
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
    (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function fetchOnce(url, headers, timeoutMs) {
    const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
        throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    return response.text();
}

// Direct first; on Cloudflare-style blocks (403/429/5xx) retry through public
// relays so the lookup still resolves from a datacenter-hosted IP.
async function fetchText(url, headers, timeoutMs = 15000) {
    const attempts = [];
    try {
        return await fetchOnce(url, headers, timeoutMs);
    }
    catch (error) {
        attempts.push(error.message);
    }
    for (const build of PROXY_BUILDERS) {
        const proxyUrl = build(url);
        try {
            const body = await fetchOnce(proxyUrl, { "User-Agent": UA }, timeoutMs + 5000);
            if (proxyUrl.includes("/get?url=")) {
                const parsed = JSON.parse(body);
                if (typeof parsed.contents === "string")
                    return parsed.contents;
                continue;
            }
            return body;
        }
        catch (error) {
            attempts.push(error.message);
        }
    }
    throw new Error(attempts.join("; "));
}

function normalizeTitle(value) {
    return String(value ?? "")
        .toLowerCase()
        .replace(/\([^)]*\)/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

// "John Wick 4" -> "John Wick", "Mission Impossible 4" -> "Mission Impossible".
// Strips a trailing sequel marker so kisskh search returns the base franchise.
function baseTitleFor(value) {
    const stripped = String(value ?? "")
        .replace(/\s*[\(\[]?\s*(?:part|chapter|season|vol|volume)\.?\s*[0-9ivx]+\s*[\)\]]?\s*$/i, " ")
        .replace(/\s+[0-9]+\s*$/, " ")
        .replace(/\s+/g, " ")
        .trim();
    return stripped || String(value ?? "");
}

function titleScore(candidate, query) {
    const a = normalizeTitle(candidate);
    const b = normalizeTitle(query);
    if (!a || !b)
        return 0;
    if (a === b)
        return 1;
    // Tolerate spacing differences: "Spiderman 1" vs "Spider Man 1".
    const ac = a.replace(/\s+/g, "");
    const bc = b.replace(/\s+/g, "");
    if (ac === bc)
        return 0.98;
    if (a.startsWith(b) || b.startsWith(a))
        return 0.9;
    if (a.includes(b) || b.includes(a))
        return 0.85;
    const wanted = b.split(" ").filter(Boolean);
    const have = new Set(a.split(" ").filter(Boolean));
    const matched = wanted.filter((token) => have.has(token)).length;
    return wanted.length === 0 ? 0 : (matched / wanted.length) * 0.8;
}

function pickBest(results, query, titleKey = "title") {
    let best = null;
    let bestScore = 0;
    for (const result of results) {
        const score = titleScore(result[titleKey], query);
        if (score > bestScore) {
            best = result;
            bestScore = score;
        }
    }
    return best ? { result: best, score: bestScore } : null;
}

export async function searchKisskh(query) {
    const url = `${KISSKH}/api/DramaList/Search?q=${encodeURIComponent(query)}&type=0`;
    const results = JSON.parse(await fetchText(url, KISSKH_HEADERS));
    return Array.isArray(results) ? results : [];
}

async function kisskhKey(episodeId, type) {
    const response = JSON.parse(await fetchText(`${KKEY_API}?text=${episodeId}&type=${type}`, { "User-Agent": UA }, 20000));
    if (!response?.result)
        throw new Error("kisskh: stream key unavailable");
    return response.result;
}

async function resolveKisskh(query, options = {}) {
    const results = options.results ?? await searchKisskh(query);
    if (results.length === 0)
        throw new Error("kisskh: no search results");
    const resultIndex = options.resultIndex ?? (() => {
        const best = pickBest(results, query);
        if (!best || best.score < 0.75)
            throw new Error("kisskh: no close title match");
        return results.indexOf(best.result);
    })();
    const picked = results[resultIndex];
    const drama = options.drama ?? JSON.parse(await fetchText(`${KISSKH}/api/DramaList/Drama/${picked.id}?isq=false`, KISSKH_HEADERS));
    const episodes = (drama?.episodes ?? []).slice().sort((a, b) => a.number - b.number);
    const episodeIndex = options.episodeIndex ?? 0;
    const episode = episodes[episodeIndex];
    if (!episode?.id)
        throw new Error("kisskh: no playable episode");
    // Stream and subtitle keys come from the same slow helper; ask both at once.
    const streamCacheKey = `kisskh-ep:${episode.id}`;
    const cachedStream = cache.get(streamCacheKey);
    const subPromise = kisskhKey(episode.id, "sub")
        .then((subKey) => fetchText(`${KISSKH}/api/Sub/${episode.id}?kkey=${encodeURIComponent(subKey)}`, KISSKH_HEADERS))
        .then((body) => (JSON.parse(body) ?? []))
        .catch(() => []);
    let video;
    let subList;
    if (cachedStream && cachedStream.expiresAt > Date.now()) {
        video = cachedStream.value.video;
        subList = await subPromise;
    }
    else {
        const [key, subs] = await Promise.all([kisskhKey(episode.id, "vid"), subPromise]);
        subList = subs;
        const streamUrl = `${KISSKH}/api/DramaList/Episode/${episode.id}.png?err=false&ts=&time=&kkey=${encodeURIComponent(key)}`;
        const stream = JSON.parse(await fetchText(streamUrl, KISSKH_HEADERS));
        video = stream?.Video;
        if (video)
            cache.set(streamCacheKey, { value: { video }, expiresAt: Date.now() + 5 * 60 * 1000 });
    }
    if (!video)
        throw new Error("kisskh: no video url");
    const subtitles = (Array.isArray(subList) ? subList : [])
        .filter((entry) => entry?.src)
        .map((entry) => ({ lang: entry.land || entry.label || "", label: entry.label ?? "", url: entry.src }));
    return {
        provider: "kisskh",
        title: drama.title ?? picked.title,
        year: String(drama.releaseDate ?? "").slice(0, 4),
        url: video,
        headers: { Referer: `${KISSKH}/`, Origin: KISSKH },
        // kisskh serves MPEG-TS segments named .png; HLS demuxer needs the check relaxed.
        inputOptions: ["-extension_picky", "false"],
        subtitles,
        series: {
            query,
            provider: "kisskh",
            results,
            resultIndex,
            drama,
            episodes,
            episodeIndex,
        },
    };
}

async function resolveVixsrc(query, options = {}) {
    const candidates = options.candidates ?? await (async () => {
        const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`;
        const data = JSON.parse(await fetchText(url, { "User-Agent": UA }));
        return (data.metas ?? []).filter((meta) => meta?.imdb_id && meta?.name);
    })();
    if (candidates.length === 0)
        throw new Error("vixsrc: no search results");
    let index = options.index;
    if (index == null) {
        const best = pickBest(candidates, query, "name");
        if (!best || best.score < 0.65)
            throw new Error("vixsrc: no close title match");
        index = candidates.indexOf(best.result);
    }
    const match = candidates[index];
    if (!match)
        throw new Error("vixsrc: no more results");
    const api = JSON.parse(await fetchText(`${VIXSRC}/api/movie/${match.imdb_id}`, VIXSRC_HEADERS));
    if (!api?.src)
        throw new Error("vixsrc: no stream");
    const embed = await fetchText(`${VIXSRC}${api.src}`, VIXSRC_HEADERS);
    const token = embed.match(/'token':\s*'([^']+)'/)?.[1];
    const expires = embed.match(/'expires':\s*'([^']+)'/)?.[1];
    const base = embed.match(/url:\s*'([^']+)'/)?.[1];
    if (!token || !expires || !base)
        throw new Error("vixsrc: stream not resolved");
    return {
        provider: "vixsrc",
        title: match.name,
        year: match.releaseInfo ?? "",
        url: `${base}?token=${token}&expires=${expires}&h=1&lang=en`,
        headers: { Referer: `${VIXSRC}/` },
        inputOptions: [],
        subtitles: [],
        imdbId: match.imdb_id,
        series: { query, provider: "vixsrc", candidates, index },
    };
}

export async function searchMovies(query, limit = 8) {
    const url = `https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(query)}.json`;
    const data = JSON.parse(await fetchText(url, { "User-Agent": UA }));
    return (data.metas ?? [])
        .filter((meta) => meta?.imdb_id && meta?.name)
        .slice(0, limit)
        .map((meta) => ({
            title: meta.name,
            year: meta.releaseInfo ?? "",
            imdbId: meta.imdb_id,
            poster: meta.poster ?? "",
        }));
}

export async function resolveMovie(query) {
    const cacheKey = `movie:${query.trim().toLowerCase()}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now())
        return cached.value;

    const errors = [];
    // Resolve the exact film through a movie database first. Raw kisskh search
    // ranks by whatever contains "2"/"4", so "John Wick 4" lands on unrelated
    // season-2 dramas; cinemeta turns it into "John Wick: Chapter 4" (2023).
    let canonical = null;
    try {
        const metas = await searchMovies(query, 5);
        // Cinemeta already relevance-ranks the search; its top hit is the film
        // the user means ("John Wick 4" -> "John Wick: Chapter 4"). Local scoring
        // here only misfires on base-vs-sequel, so trust the database order.
        if (metas.length)
            canonical = metas[0];
    }
    catch (error) {
        errors.push(`cinemeta: ${error.message}`);
    }
    // Search kisskh with the bare title ("John Wick"), then rank the hits against
    // the canonical full title ("John Wick: Chapter 4") so the exact sequel wins.
    const baseQuery = baseTitleFor(query);
    const providers = [];
    if (canonical) {
        providers.push(async () => {
            const results = await searchKisskh(baseQuery);
            // Same title across years ("Inception" 2010 vs 2025): if several exact
            // matches exist, float the one whose year is closest to the database pick.
            const wantYear = Number(String(canonical.year ?? "").slice(0, 4)) || 0;
            const want = normalizeTitle(canonical.title);
            if (wantYear) {
                let bestIdx = -1;
                let bestDist = Infinity;
                for (let i = 0; i < results.length; i += 1) {
                    if (normalizeTitle(results[i].title) !== want)
                        continue;
                    const y = Number(String(results[i].releaseDate ?? "").slice(0, 4)) || 0;
                    const d = y ? Math.abs(y - wantYear) : 500;
                    if (d < bestDist) {
                        bestDist = d;
                        bestIdx = i;
                    }
                }
                if (bestIdx > 0) {
                    const [hit] = results.splice(bestIdx, 1);
                    results.unshift(hit);
                }
            }
            return resolveKisskh(canonical.title, { results });
        });
        providers.push(() => resolveVixsrc(canonical.title, {
            candidates: [{ imdb_id: canonical.imdbId, name: canonical.title, releaseInfo: canonical.year }],
            index: 0,
        }));
    }
    providers.push(() => resolveKisskh(query));
    providers.push(() => resolveVixsrc(query));
    providers.push(async () => {
        const metas = await searchMovies(query, 5);
        let lastError = null;
        for (const meta of metas.slice(0, 3)) {
            if (!meta.imdb_id || meta.imdb_id === canonical?.imdbId)
                continue;
            try {
                return await resolveVixsrc(meta.title, {
                    candidates: [meta],
                    index: 0,
                });
            }
            catch (error) {
                lastError = error;
            }
        }
        throw lastError ?? new Error("vixsrc: no alternate candidates");
    });
    if (process.env.MOVIE_DEBUG)
        console.error(`[movie] "${query}" canonical="${canonical?.title}" base="${baseTitleFor(query)}"`);
    for (const provider of providers) {
        try {
            const value = await provider();
            if (process.env.MOVIE_DEBUG)
                console.error(`[movie] hit ${value.provider}: ${value.title} (${value.year})`);
            cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
            return value;
        }
        catch (error) {
            if (process.env.MOVIE_DEBUG)
                console.error(`[movie] miss: ${error.message}`);
            errors.push(error.message);
        }
    }
    throw new Error(`No stream found for "${query}" (${errors.join("; ")})`);
}

export async function resolveNext(series) {
    if (!series)
        throw new Error("Nothing is playing yet.");
    if (series.provider === "kisskh") {
        if (series.episodeIndex + 1 < series.episodes.length)
            return resolveKisskh(series.query, {
                results: series.results,
                resultIndex: series.resultIndex,
                drama: series.drama,
                episodeIndex: series.episodeIndex + 1,
            });
        if (series.resultIndex + 1 < series.results.length)
            return resolveKisskh(series.query, {
                results: series.results,
                resultIndex: series.resultIndex + 1,
                episodeIndex: 0,
            });
        throw new Error("No next episode on this source.");
    }
    if (series.provider === "vixsrc" && series.index + 1 < series.candidates.length)
        return resolveVixsrc(series.query, { candidates: series.candidates, index: series.index + 1 });
    throw new Error("No next episode on this source.");
}

export function pickEnglishSubtitle(subtitles) {
    if (!Array.isArray(subtitles) || subtitles.length === 0)
        return null;
    const english = subtitles.find((entry) => /^en(-|$)/i.test(String(entry.lang).trim()))
        ?? subtitles.find((entry) => /english/i.test(String(entry.label)));
    return english ?? null;
}

export async function findStreamSubtitle(imdbId) {
    if (!imdbId)
        return null;
    try {
        const response = await fetch(`https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`, {
            headers: { "User-Agent": UA },
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok)
            return null;
        const data = await response.json();
        const english = (data.subtitles ?? []).filter((entry) => /^eng/i.test(String(entry.lang ?? "")));
        for (const entry of english) {
            try {
                const check = await fetch(entry.url, {
                    headers: { "User-Agent": UA },
                    signal: AbortSignal.timeout(6000),
                });
                if (!check.ok)
                    continue;
                const body = await check.text();
                if (body.includes("-->"))
                    return entry.url;
            }
            catch {
            }
        }
    }
    catch {
    }
    return null;
}

export async function downloadYifySubtitle(imdbId, tag = "sub") {
    if (!imdbId)
        return null;
    try {
        const page = await fetchText(`${YIFY}/movie-imdb/${imdbId}`, { "User-Agent": UA }, 8000);
        const detailPath = (page.match(/\/subtitles\/[^"' ]*-english-yify-\d+/i) ?? [])[0];
        if (!detailPath)
            return null;
        const detail = await fetchText(`${YIFY}${detailPath}`, { "User-Agent": UA }, 8000);
        const zipPath = (detail.match(/href="(\/subtitle\/[^"]+\.zip)"/i) ?? [])[1];
        if (!zipPath)
            return null;
        const response = await fetch(`${YIFY}${zipPath}`, {
            headers: { "User-Agent": UA, Referer: `${YIFY}/` },
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok)
            return null;
        const zipFile = `${SUBTITLE_DIR}/yify-${Date.now()}.zip`;
        mkdirSync(SUBTITLE_DIR, { recursive: true });
        writeFileSync(zipFile, Buffer.from(await response.arrayBuffer()));
        const { stdout } = await run("unzip", ["-p", zipFile, "*.srt"], { encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
        try {
            unlinkSync(zipFile);
        }
        catch {
        }
        const body = stdout.toString("utf8");
        if (!body.includes("-->"))
            return null;
        const path = `${SUBTITLE_DIR}/${tag}.srt`;
        writeFileSync(path, body);
        return path;
    }
    catch {
        return null;
    }
}

export async function downloadSubtitle(url, tag = "sub") {
    const response = await fetch(url, {
        headers: { "User-Agent": UA },
        signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
        throw new Error(`subtitle HTTP ${response.status}`);
    const body = await response.text();
    if (!body.includes("-->"))
        throw new Error("subtitle is not SRT");
    mkdirSync(SUBTITLE_DIR, { recursive: true });
    for (const entry of readdirSync(SUBTITLE_DIR)) {
        const full = `${SUBTITLE_DIR}/${entry}`;
        if (entry === `${tag}.srt` || !existsSync(full))
            continue;
        if (Date.now() - statSync(full).mtimeMs > SUBTITLE_TTL_MS) {
            try {
                unlinkSync(full);
            }
            catch {
            }
        }
    }
    const path = `${SUBTITLE_DIR}/${tag}.srt`;
    writeFileSync(path, body);
    return path;
}
