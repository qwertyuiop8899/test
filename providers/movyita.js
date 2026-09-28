// MovyITA - Nuvio provider: Movy video (up to 4K) + StreamingCommunity/vixsrc Italian audio in a single HLS stream.
// Written without async/await (generators via __async) so it runs on both Hermes and QuickJS plugin runtimes.

var TMDB_KEY = (typeof TMDB_API_KEY !== "undefined" && TMDB_API_KEY) ? TMDB_API_KEY : "68e094699525b18a70bab2f86b1fa706";
var TMDB_BASE = "https://api.themoviedb.org/3";

// Tried in order; add new mirrors here if the site moves without a redirect.
var MOVY_SITES = ["https://www.movy.sx", "https://movy.sx"];
var MOVY_API_FALLBACK = "https://api.wecollege.net";
var MOVY_SERVERS = ["miami", "boise"];
var MOVY_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

var VIX_DOMAINS_URL = "https://raw.githubusercontent.com/realbestia1/domains/refs/heads/main/domains.json";
var VIX_DEFAULT_BASE = "https://vixsrc.to";
var VIX_UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

var TOASTFLIX_URL = "https://toastflix.stremio-italia.eu";
// Lip-sync becomes noticeable around 45 ms early / 125 ms late (ITU-R BT.1359); 100 ms is a safe "in sync" band.
var SYNC_OK_SECONDS = 0.1;
// A speed mismatch below this drifts less than the sync band over a 2-hour film.
var SYNC_RATE_TOLERANCE = SYNC_OK_SECONDS / 7200;
// NuvioTV clamps the manual audio delay to ±3000 ms in 25 ms steps.
var NUVIO_MAX_DELAY_MS = 3000;
var NUVIO_DELAY_STEP_MS = 25;

var QUALITY_INFO = {
  "2160": { label: "4K", resolution: "3840x2160", bandwidth: 16000000 },
  "1440": { label: "1440p", resolution: "2560x1440", bandwidth: 10000000 },
  "1080": { label: "1080p", resolution: "1920x1080", bandwidth: 6000000 },
  "720": { label: "720p", resolution: "1280x720", bandwidth: 3000000 },
  "480": { label: "480p", resolution: "854x480", bandwidth: 1500000 },
  "360": { label: "360p", resolution: "640x360", bandwidth: 800000 }
};

var vixBaseCache = { value: null, at: 0 };
var movyCfgCache = { value: null, at: 0 };

function __async(gen) {
  return new Promise(function (resolve, reject) {
    function step(method, arg) {
      var r;
      try {
        r = gen[method](arg);
      } catch (e) {
        reject(e);
        return;
      }
      if (r.done) resolve(r.value);
      else Promise.resolve(r.value).then(function (v) { step("next", v); }, function (e) { step("throw", e); });
    }
    step("next");
  });
}

// ---------------------------------------------------------------- HTTP

function fetchWithTimeout(url, options, ms) {
  // NuvioTV's QuickJS runtime has no timers; its native fetch already has its own timeouts.
  if (typeof setTimeout !== "function") return fetch(url, options);
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () {
      if (!done) { done = true; reject(new Error("Timeout: " + url)); }
    }, ms || 15000);
    fetch(url, options).then(function (res) {
      if (!done) { done = true; clearTimeout(timer); resolve(res); }
    }, function (err) {
      if (!done) { done = true; clearTimeout(timer); reject(err); }
    });
  });
}

function getText(url, headers, ms) {
  return fetchWithTimeout(url, { headers: headers || {} }, ms).then(function (res) {
    if (!res.ok) throw new Error("HTTP " + res.status + " " + url.split("?")[0]);
    return res.text();
  });
}

function getJson(url, headers, ms) {
  return getText(url, headers, ms).then(function (text) { return JSON.parse(text); });
}

function toQuery(params) {
  return Object.keys(params).map(function (k) {
    return encodeURIComponent(k) + "=" + encodeURIComponent(params[k]).replace(/%20/g, "+");
  }).join("&");
}

function absUrl(uri, base) {
  if (/^https?:\/\//i.test(uri)) return uri;
  var origin = (base.match(/^https?:\/\/[^\/]+/i) || [""])[0];
  if (uri.charAt(0) === "/") return origin + uri;
  return base.split("?")[0].replace(/[^\/]*$/, "") + uri;
}

// ---------------------------------------------------------------- Encoding helpers (no Buffer/atob/TextDecoder needed)

var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64ToBytes(str) {
  var s = String(str).replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
  var out = new Uint8Array(Math.floor(s.length * 3 / 4));
  var buf = 0, bits = 0, n = 0;
  for (var i = 0; i < s.length; i++) {
    buf = ((buf << 6) | B64.indexOf(s.charAt(i))) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (buf >> bits) & 255;
    }
  }
  return out.subarray(0, n);
}

function asciiToBase64(str) {
  var out = "", i = 0, n;
  for (; i + 2 < str.length; i += 3) {
    n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + B64.charAt(n & 63);
  }
  if (str.length - i === 1) {
    n = str.charCodeAt(i) << 16;
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + "==";
  } else if (str.length - i === 2) {
    n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8);
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63) + B64.charAt((n >> 6) & 63) + "=";
  }
  return out;
}

function utf8Decode(bytes) {
  var out = "", i = 0, c, cp;
  while (i < bytes.length) {
    c = bytes[i++];
    if (c < 0x80) {
      out += String.fromCharCode(c);
    } else if (c < 0xe0) {
      out += String.fromCharCode(((c & 31) << 6) | (bytes[i++] & 63));
    } else if (c < 0xf0) {
      out += String.fromCharCode(((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      cp = (((c & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63)) - 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023));
    }
  }
  return out;
}

// ---------------------------------------------------------------- Movy payload cipher (ported from movy.js)

var MAGIC = [109, 118, 109, 49]; // "mvm1"

function uHash(e) {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 0x85ebca6b) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 0xc2b2ae35) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}

function rotl(e, t) {
  e >>>= 0;
  t &= 31;
  return t === 0 ? e >>> 0 : ((e << t) | (e >>> (32 - t))) >>> 0;
}

function initKey(seed, mediaId) {
  var s = new Array(61);
  var h = 0x811c9dc5;
  for (var a = 0; a < seed.length; a++) h = Math.imul(h ^ seed.charCodeAt(a), 0x1000193) >>> 0;
  var i = uHash(uHash(h) ^ uHash((mediaId >>> 0) ^ 0x9e3779b9)) >>> 0;
  for (var e = 0; e < 8; e++) {
    var t = i % 61;
    i = rotl((i + 0x9e3779b9) >>> 0, 7 + (7 & e));
    s[t] = (i ^ uHash(i)) >>> 0;
    i = uHash((i + t) >>> 0);
  }
  return { S: s, acc: uHash(0xa5a5a5a5 ^ i) >>> 0 };
}

function nextWord(state, t) {
  var S = state.S, acc = state.acc, idx = acc % 61;
  var inBounds = idx in S ? -1 : 0;
  var s = ((S[idx] >>> 0) ^ (Math.imul(0x9e3779b9, t + 1) >>> 0)) >>> 0;
  var c = (((acc ^ s) >>> 0) | ((acc & s & inBounds) >>> 0)) >>> 0;
  c = (rotl((c + acc) >>> 0, 31 & idx) ^ rotl(acc, 31 & Math.imul(idx, 7))) >>> 0;
  acc = uHash((c + 0x9e3779b9) >>> 0);
  S[idx] = acc >>> 0;
  state.acc = acc;
  return acc >>> 0;
}

function decryptMovyPayload(encB64, seed, mediaId) {
  var raw = base64ToBytes(encB64);
  var state = initKey(seed, mediaId);
  var out = new Uint8Array(raw.length);
  for (var i = 0, r = 0; i < raw.length; r++) {
    var w = nextWord(state, r);
    for (var b = 0; b < 4 && i < raw.length; b++, i++) out[i] = raw[i] ^ ((w >>> (8 * b)) & 255);
  }
  for (var m = 0; m < MAGIC.length; m++) {
    if (out[m] !== MAGIC[m]) throw new Error("Movy payload magic mismatch");
  }
  return utf8Decode(out.subarray(MAGIC.length));
}

// ---------------------------------------------------------------- TMDB

function resolveTmdbId(rawId, isTv) {
  var id = String(rawId || "").trim().replace(/^tmdb:/i, "");
  if (/^\d+$/.test(id)) return Promise.resolve(id);
  var imdb = (id.match(/tt\d+/) || [])[0];
  if (!imdb) return Promise.resolve(null);
  return getJson(TMDB_BASE + "/find/" + imdb + "?api_key=" + TMDB_KEY + "&external_source=imdb_id", {}, 10000).then(function (d) {
    var list = (isTv ? d.tv_results : d.movie_results) || [];
    return list.length ? String(list[0].id) : null;
  });
}

function tmdbMeta(tmdbId, isTv) {
  var url = TMDB_BASE + "/" + (isTv ? "tv" : "movie") + "/" + tmdbId + "?api_key=" + TMDB_KEY + "&append_to_response=external_ids";
  return getJson(url, {}, 10000).then(function (d) {
    return {
      title: (isTv ? d.name : d.title) || "",
      year: ((isTv ? d.first_air_date : d.release_date) || "").slice(0, 4),
      imdbId: (d.external_ids && d.external_ids.imdb_id) || d.imdb_id || ""
    };
  });
}

// ---------------------------------------------------------------- Movy sources

function qualityKey(q) {
  var s = String(q || "").toLowerCase();
  if (s.indexOf("4k") >= 0) return "2160";
  var m = s.match(/(\d{3,4})/);
  return m && QUALITY_INFO[m[1]] ? m[1] : "1080";
}

function movyHeaders(site) {
  return { "User-Agent": MOVY_UA, "Accept": "*/*", "Origin": site, "Referer": site + "/" };
}

function getMovyConfig() {
  if (movyCfgCache.value && Date.now() - movyCfgCache.at < 60 * 60 * 1000) return Promise.resolve(movyCfgCache.value);
  return __async(function* () {
    for (var i = 0; i < MOVY_SITES.length; i++) {
      try {
        var res = yield fetchWithTimeout(MOVY_SITES[i] + "/", { headers: { "User-Agent": MOVY_UA, "Accept": "text/html" } }, 8000);
        if (!res.ok) continue;
        var html = yield res.text();
        var site = ((res.url || MOVY_SITES[i]).match(/^https?:\/\/[^\/]+/i) || [MOVY_SITES[i]])[0];
        var apis = (html.match(/https:\/\/api\.[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).filter(function (u) { return !/tmdb|themoviedb|google|cloudflare/i.test(u); });
        movyCfgCache = { value: { site: site, api: apis[0] || MOVY_API_FALLBACK }, at: Date.now() };
        return movyCfgCache.value;
      } catch (e) {
        console.warn("[MovyITA] Movy site " + MOVY_SITES[i] + ": " + e.message);
      }
    }
    return { site: MOVY_SITES[0], api: MOVY_API_FALLBACK };
  }());
}

function getMovySources(tmdbId, isTv, season, episode, meta) {
  return __async(function* () {
    var cfg = yield getMovyConfig();
    var headers = movyHeaders(cfg.site);
    var seedRes = yield getJson(cfg.api + "/seed?mediaId=" + tmdbId, headers, 10000);
    var seed = seedRes && seedRes.seed;
    if (!seed) throw new Error("Movy: no seed");

    var result = { sources: [], subtitles: [], headers: headers, api: cfg.api };
    var seen = {};
    for (var n = 0; n < MOVY_SERVERS.length; n++) {
      var server = MOVY_SERVERS[n];
      var params = {
        title: encodeURIComponent(meta.title),
        mediaType: isTv ? "tv" : "movie",
        year: meta.year || "",
        tmdbId: String(tmdbId),
        imdbId: meta.imdbId || "",
        enc: "2",
        seed: seed
      };
      if (isTv) {
        params.seasonId = String(season);
        params.episodeId = String(episode);
      }
      try {
        var enc = yield getText(cfg.api + "/" + server + "/sources?" + toQuery(params), headers, 15000);
        if (!enc || !enc.trim()) continue;
        var data = JSON.parse(decryptMovyPayload(enc.trim(), seed, Number(tmdbId)));
        (data.sources || []).forEach(function (s) {
          if (!s || !s.url || seen[s.url]) return;
          seen[s.url] = true;
          result.sources.push({ url: s.url, qkey: qualityKey(s.quality), server: server.charAt(0).toUpperCase() + server.slice(1) });
        });
        (data.subtitles || []).forEach(function (sub) {
          if (sub && sub.url) result.subtitles.push({ url: sub.url, language: String(sub.language || sub.lang || "en"), name: sub.label || sub.name || sub.language || sub.lang || "Sub" });
        });
        if (result.sources.some(function (s) { return s.qkey === "2160"; })) break;
      } catch (e) {
        console.warn("[MovyITA] Movy " + server + ": " + e.message);
      }
    }
    return result;
  }());
}

// ---------------------------------------------------------------- vixsrc (StreamingCommunity) Italian audio

function getVixBase() {
  if (vixBaseCache.value && Date.now() - vixBaseCache.at < 10 * 60 * 1000) return Promise.resolve(vixBaseCache.value);
  return getText(VIX_DOMAINS_URL + "?_=" + Date.now(), { "Accept": "application/json" }, 6000).then(function (text) {
    var cfg = JSON.parse(text.replace(/("[^"\r\n]+")\s*("[^"]+"\s*:)/g, "$1,$2"));
    var base = String((cfg && cfg.vixsrc) || "").trim().replace(/\/+$/, "");
    return /^https?:\/\//i.test(base) ? base : VIX_DEFAULT_BASE;
  }).catch(function () {
    return VIX_DEFAULT_BASE;
  }).then(function (base) {
    vixBaseCache = { value: base, at: Date.now() };
    return base;
  });
}

function attr(line, key) {
  var m = line.match(new RegExp("(?:^|[,:])" + key + "=(\"([^\"]*)\"|[^,]*)"));
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[1];
}

function getItalianTracks(tmdbId, isTv, season, episode) {
  return __async(function* () {
    var base = yield getVixBase();
    var apiPath = isTv ? "/api/tv/" + tmdbId + "/" + season + "/" + episode : "/api/movie/" + tmdbId;
    var payload = yield getJson(base + apiPath + "?lang=it", {
      "User-Agent": VIX_UA,
      "Referer": base + "/",
      "Accept": "application/json",
      "Accept-Language": "it-IT,it;q=0.9,en;q=0.8"
    }, 12000);
    if (!payload || !payload.src) return null;

    var embedUrl = absUrl(String(payload.src), base + "/");
    var html = yield getText(embedUrl, { "User-Agent": VIX_UA, "Referer": base + "/" }, 12000);
    var token = (html.match(/'token'\s*:\s*'([^']+)'/) || [])[1];
    var expires = (html.match(/'expires'\s*:\s*'([^']+)'/) || [])[1];
    var playlist = (html.match(/url\s*:\s*'([^']+\/playlist\/\d+[^']*)'/) || [])[1];
    if (!token || !expires || !playlist) return null;
    var fhd = /window\.canPlayFHD\s*=\s*true/.test(html) || /[?&]canPlayFHD=1/.test(embedUrl);

    var masterUrl = playlist + (playlist.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(token) +
      "&expires=" + encodeURIComponent(expires) + (fhd ? "&h=1" : "") + "&lang=it";
    var master = yield getText(masterUrl, { "User-Agent": VIX_UA, "Referer": embedUrl, "Origin": base }, 12000);

    var audio = null, subtitles = [];
    master.split(/\r?\n/).forEach(function (line) {
      if (line.indexOf("#EXT-X-MEDIA:") !== 0 || !attr(line, "URI")) return;
      var type = attr(line, "TYPE");
      var lang = String(attr(line, "LANGUAGE") || "").toLowerCase();
      var name = String(attr(line, "NAME") || "");
      if (type === "AUDIO" && !audio && (lang === "ita" || lang === "it" || /^ita/i.test(name))) {
        audio = { uri: absUrl(attr(line, "URI"), masterUrl) };
      } else if (type === "SUBTITLES") {
        var subUri = absUrl(attr(line, "URI"), masterUrl);
        var forced = /forced/i.test(name + " " + lang) || attr(line, "FORCED") === "YES";
        if (subtitles.some(function (s) { return s.uri === subUri || s.forced === forced; })) return;
        subtitles.push({ uri: subUri, name: name || "Italiano", lang: lang || "ita", forced: forced });
      }
    });
    return audio ? { audio: audio, subtitles: subtitles } : null;
  }());
}

// ---------------------------------------------------------------- Combined HLS master (data: URI)

function quoteSafe(v) {
  return String(v).replace(/["\r\n]/g, "").replace(/[^\x20-\x7e]/g, "");
}

function buildMasterDataUri(movyUrl, qinfo, ita) {
  // First line ends with a bare CR so mpv's generic m3u parser doesn't grab it; FFmpeg/ExoPlayer accept CR line breaks.
  var lines = ["#EXTM3U\r#EXT-X-VERSION:6", "#EXT-X-INDEPENDENT-SEGMENTS"];
  lines.push('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Italiano",LANGUAGE="it",DEFAULT=YES,AUTOSELECT=YES,URI="' + quoteSafe(ita.audio.uri) + '"');
  ita.subtitles.forEach(function (s) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="' + quoteSafe(s.name) + '",LANGUAGE="it"' +
      ',DEFAULT=NO,AUTOSELECT=' + (s.forced ? "YES" : "NO") + ',FORCED=' + (s.forced ? "YES" : "NO") + ',URI="' + quoteSafe(s.uri) + '"');
  });
  lines.push("#EXT-X-STREAM-INF:BANDWIDTH=" + qinfo.bandwidth + ",RESOLUTION=" + qinfo.resolution + ',AUDIO="aud"' +
    (ita.subtitles.length ? ',SUBTITLES="subs"' : ""));
  lines.push(quoteSafe(movyUrl));
  var text = lines.join("\n") + "\n";
  // Base64 must end with '=' so FFmpeg's decoder stops before the "#.m3u8" hint used for HLS probing.
  if (text.length % 3 === 0) text += "\n";
  // "data://" instead of "data:": mpv only treats proto:// strings as URLs; ExoPlayer still reads the payload after the comma.
  // "/m3u8/" in the media type lets NuvioTV (URL-based MIME detection, ignores "type") pick the HLS source.
  return "data://application/m3u8/;base64," + asciiToBase64(text) + "#.m3u8";
}

// ---------------------------------------------------------------- Entry point

function pad2(n) {
  return (Number(n) < 10 ? "0" : "") + Number(n);
}

function nuvioDelayMs(seconds) {
  return Math.round(Number(seconds) * 1000 / NUVIO_DELAY_STEP_MS) * NUVIO_DELAY_STEP_MS;
}

function formatDelay(ms) {
  return (ms > 0 ? "+" : "") + String(ms / 1000).replace(".", ",") + " s";
}

// Offsets measured by ToastFlix for Movy video vs vixsrc audio; positive offset = audio must be delayed.
function getSyncStatus(meta, isTv, season, episode) {
  if (!meta.imdbId) return Promise.resolve({ level: "red", reason: "titolo senza IMDb" });
  var url = TOASTFLIX_URL + "/dual/offset/status?imdb=" + encodeURIComponent(meta.imdbId) +
    "&type=" + (isTv ? "series" : "movie") + "&season=" + (isTv ? Number(season) : 0) +
    "&episode=" + (isTv ? Number(episode) : 0) + "&provider=movy&audio_source=vixsrc";
  return getJson(url, { "Accept": "application/json" }, 8000).then(function (d) {
    if (!d || !d.found) return { level: "red", reason: "offset non presente nel DB" };
    if (d.status !== "ok") return { level: "red", reason: d.status === "incompatible" ? "versioni audio/video diverse" : "sync non calcolabile" };
    if (Math.abs(Number(d.rate || 1) - 1) > SYNC_RATE_TOLERANCE) return { level: "red", reason: "velocit\u00E0 diversa (fps)" };
    if (d.has_cuts) return { level: "red", reason: "versioni con tagli diversi" };
    var offset = Number(d.offset || 0);
    if (Math.abs(offset) <= SYNC_OK_SECONDS) return { level: "green" };
    var delayMs = nuvioDelayMs(offset);
    if (Math.abs(delayMs) > NUVIO_MAX_DELAY_MS) return { level: "red", reason: "offset " + formatDelay(delayMs) + " oltre il limite di Nuvio \u00B13 s" };
    return { level: "yellow", delayMs: delayMs };
  }).catch(function (e) {
    console.warn("[MovyITA] ToastFlix sync status: " + e.message);
    return { level: "unknown" };
  });
}

function syncBadge(sync) {
  if (sync.level === "green") return { icon: "\uD83D\uDD0A\u2705", line: "\uD83D\uDD0A\u2705 Audio in sync" };
  if (sync.level === "yellow") return { icon: "\u26A0\uFE0F", line: "\u26A0\uFE0F Attenzione: audio da impostare a " + formatDelay(sync.delayMs) + " (poi rimetti 0)" };
  if (sync.level === "red") return { icon: "\u26D4", line: "\u26D4 Audio non in sync, non riproducibile (" + sync.reason + ")" };
  return { icon: "\u2754", line: "\u2754 Sync audio non verificato (ToastFlix non raggiungibile)" };
}

function getStreams(tmdbId, mediaType, season, episode) {
  console.log("[MovyITA] getStreams id=" + tmdbId + " type=" + mediaType + " s=" + season + " e=" + episode);
  return __async(function* () {
    var isTv = mediaType === "tv" || mediaType === "series" || mediaType === "show";
    if (isTv && (season == null || episode == null)) return [];
    var id = yield resolveTmdbId(tmdbId, isTv);
    if (!id) {
      console.warn("[MovyITA] unsupported id: " + tmdbId);
      return [];
    }

    var meta = yield tmdbMeta(id, isTv);
    if (!meta.title) return [];

    var results = yield Promise.all([
      getMovySources(id, isTv, season, episode, meta).catch(function (e) {
        console.warn("[MovyITA] Movy failed: " + e.message);
        return { sources: [], subtitles: [] };
      }),
      getItalianTracks(id, isTv, season, episode).catch(function (e) {
        console.warn("[MovyITA] SC/vixsrc failed: " + e.message);
        return null;
      }),
      getSyncStatus(meta, isTv, season, episode)
    ]);
    var movy = results[0], ita = results[1], badge = syncBadge(results[2]);
    if (!movy.sources.length) {
      console.warn("[MovyITA] no Movy sources for " + meta.title);
      return [];
    }

    var heading = "\uD83D\uDCC1 " + meta.title + (isTv ? " S" + pad2(season) + "E" + pad2(episode) : "") + (meta.year ? " (" + meta.year + ")" : "");
    var streams = movy.sources.map(function (src) {
      var q = QUALITY_INFO[src.qkey];
      var audioLine = ita ? "\uD83C\uDDEE\uD83C\uDDF9 Audio ITA (SC) + \uD83C\uDF0D originale\n" + badge.line : "\uD83C\uDF0D Solo audio originale (ITA non trovato)";
      return {
        name: "MovyITA " + q.label + (ita ? " \uD83C\uDDEE\uD83C\uDDF9 " + badge.icon : ""),
        title: heading + "\n" + audioLine + "\n\uD83C\uDFAC Movy \u00B7 " + src.server + (ita && ita.subtitles.length ? " \u00B7 Sub ITA" : ""),
        url: ita ? buildMasterDataUri(src.url, q, ita) : src.url,
        quality: q.label,
        type: "hls",
        language: ita ? "Italian" : "Original",
        provider: "movyita",
        headers: movy.headers,
        subtitles: movy.subtitles,
        _rank: Number(src.qkey)
      };
    });
    streams.sort(function (a, b) { return b._rank - a._rank; });
    streams.forEach(function (s) { delete s._rank; });
    console.log("[MovyITA] " + streams.length + " stream(s) via " + movy.api + ", ITA audio: " + (ita ? "yes" : "no") + ", sync: " + results[2].level);
    return streams;
  }()).catch(function (e) {
    console.error("[MovyITA] " + e.message);
    return [];
  });
}

if (typeof module !== "undefined" && module.exports) module.exports = { getStreams: getStreams };
if (typeof globalThis !== "undefined") globalThis.getStreams = getStreams;
