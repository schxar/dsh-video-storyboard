/**
 * bilibili.js — 把 B 站的官方元数据与 CC 字幕接进 storyboard。
 *
 * 为什么需要这一层：storyboard 原本对 B 站视频的处理是「yt-dlp 下 360P 扫描 + ASR 转写」。
 * 但 B 站**大量中文视频本身就带官方 CC 字幕**（UP 主上传，或平台自动生成），
 * 精度比本地 ASR 高，还省掉整段转写时间。yt-dlp 拿不到它 —— B 站字幕走的是独立 JSON
 * 接口，不在 dash 清单里，所以只能单独调。
 *
 * 这一层刻意**只做两件事**：取元数据（bvid → cid / 分 P / 时长）、取官方字幕。
 * 不下载、不抽帧、不碰 ASR —— 那些 storyboard 已经有更好的实现，重复实现只会变成两套。
 *
 * 跟 bili-vision 的关系：能力从它那里来，但实现是重写的。那边是 1082 行 Python
 * （requests / numpy / Pillow / faster-whisper / rapidocr），这边是纯 JS、零新增依赖，
 * SESSDATA 直接从用户已有的 yt-dlp cookies.txt 里解析，不新增配置文件。
 *
 * **所有失败都返回 null，不抛**：字幕是锦上添花，拿不到就降级走 ASR，
 * 绝不能因为 B 站接口改版把整条流水线打断。
 */

import { readFile } from 'node:fs/promises';
import { resolveAuth } from './fetch.js';

const API_ROOT = 'https://api.bilibili.com';

// B 站接口对 UA 敏感：空 UA 或 curl/xx 会被直接挡回 code -412（风控）。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

const BVID_RE = /BV[0-9A-Za-z]{10}/;
const SHORT_HOST_RE = /^(?:https?:\/\/)?(?:b23\.tv|bili2233\.cn)\//i;
const HTTP_RE = /^https?:\/\//i;

/** 这个输入值不值得走 B 站这条路。本地文件直接 false，不做无谓工作。 */
export function looksLikeBilibili(input) {
  return typeof input === 'string' && (BVID_RE.test(input) || SHORT_HOST_RE.test(input));
}

/**
 * 从任意 B 站链接里抠出 BV 号与分 P。
 *
 * 支持：`https://www.bilibili.com/video/BV1xx/?p=2`、带一堆追踪参数的分享链接、
 * `b23.tv` 短链（**仅当已经展开过**，短链展开是异步的，见 resolveShortLink）、
 * 以及裸的 `BV1xxxxxxxxx`。
 *
 * @returns {{bvid:string, page:number}|null}
 */
export function parseBilibiliUrl(raw) {
  if (typeof raw !== 'string') return null;
  const hit = raw.match(BVID_RE);
  if (!hit) return null;
  let page = 1;
  try {
    const url = new URL(HTTP_RE.test(raw) ? raw : `https://${raw}`);
    const p = Number(url.searchParams.get('p'));
    if (Number.isInteger(p) && p > 0) page = p;
  } catch {
    // 裸 BV 号（没有 ?p=）走到这里很正常，不是错误。
  }
  return { bvid: hit[0], page };
}

/**
 * 从 yt-dlp 的 Netscape cookies.txt 里抠 SESSDATA。
 *
 * 为什么不单开一个配置项：用户为了让 yt-dlp 拿到高清，**本来就已经导出过 cookies.txt**
 * （`~/.dsh/video.json` 的 `cookies` 指过去）。SESSDATA 就在那份文件里，
 * 再要求填一次等于让人重复劳动，而且容易两边不同步。
 *
 * 文件格式每行 7 列，Tab 分隔：
 *   domain  includeSubdomains  path  secure  expiry  name  value
 *
 * @returns {string|null}
 */
export function sessdataFromCookies(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('\t');
    if (cols.length < 7) continue;
    const domain = cols[0].replace(/^\./, '').toLowerCase();
    const name = cols[5];
    const value = cols[6];
    if (name === 'SESSDATA' && domain.endsWith('bilibili.com') && value) return value;
  }
  return null;
}

/** 带超时的 fetch，统一注 UA / Referer / Cookie。 */
async function request(url, { sessdata = '', fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': UA, Referer: REFERER };
    if (sessdata) headers.Cookie = `SESSDATA=${sessdata}`;
    return await fetchImpl(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * 调 `api.bilibili.com` 的 x/ 接口。B 站即使业务失败也返回 200，
 * 真正表示成功的是 body 里的 `code === 0` —— 这点不看就会把错误当数据用。
 */
async function apiGet(pathname, params, opts = {}) {
  const url = new URL(pathname, API_ROOT);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const json = await getJson(url.href, opts);
  if (json?.code !== 0) {
    throw new Error(`bilibili code ${json?.code ?? '?'}${json?.message ? `: ${json.message}` : ''}`);
  }
  return json.data;
}

/**
 * 展开 b23.tv 短链。手动跟 3 跳，逐跳读 Location —— 不用 follow 模式，
 * 因为短链背后可能是个 200MB 的视频流，我们只要那串 URL。
 *
 * @returns {Promise<string|null>} 展开后的链接；失败返回 null
 */
export async function resolveShortLink(url, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let current = HTTP_RE.test(url) ? url : `https://${url}`;
  for (let hop = 0; hop < 3; hop += 1) {
    let res;
    try {
      res = await request(current, { fetchImpl, timeoutMs });
    } catch {
      return null;
    }
    const location = res.headers?.get?.('location');
    if (!location) return current;
    try {
      current = new URL(location, current).href;
    } catch {
      return null;
    }
    if (BVID_RE.test(current)) return current; // 已经到视频页，不必再跟
  }
  return current;
}

/**
 * 取视频元数据。多分 P 的视频会按 `page` 挑出对应的 cid —— 拿错 cid 会导致
 * 字幕和画面错位（第 2 集的字幕配第 1 集的画面，而且时间轴看起来完全正常）。
 *
 * @returns {Promise<{bvid:string, aid:number, cid:number, page:number, pageCount:number,
 *   title:string, duration:number, owner:string, tid:string}>}
 */
export async function fetchVideoMeta(bvid, { page = 1, sessdata = '', ...opts } = {}) {
  const data = await apiGet('/x/web-interface/view', { bvid }, { sessdata, ...opts });
  const pages = Array.isArray(data?.pages) && data.pages.length > 0
    ? data.pages
    : [{ cid: data?.cid, duration: data?.duration, part: data?.title }];
  const idx = Math.min(Math.max(1, Number(page) || 1), pages.length);
  const part = pages[idx - 1];
  const suffix = pages.length > 1 ? ` / P${idx} ${part?.part ?? ''}`.trimEnd() : '';
  return {
    bvid,
    aid: data?.aid ?? 0,
    cid: part?.cid,
    page: idx,
    pageCount: pages.length,
    title: `${data?.title ?? ''}${suffix}`.trim(),
    duration: Number(part?.duration ?? 0),
    owner: data?.owner?.name ?? '',
    tid: data?.tname ?? '',
  };
}

/**
 * 取官方 CC 字幕。
 *
 * 匿名基本返回 0 条 —— 这不是接口坏了，是 B 站对未登录用户的限制。
 * 所以要**把「没登录」「登录失效」「真没字幕」三件事分开报**：只说"没有字幕"
 * 会让用户以为这条片子本来就没字幕，跑去查别的原因，实际上他只需要重新导出 cookies。
 *
 * 判据是 `/x/player/v2` 返回体里的 `isLogin` / `login_mid`——B 站对未登录请求
 * 也一样返回 200，只有这两个字段能区分。
 *
 * 字幕按语言优先级挑：中文 → 第一条。多语言视频里选错语言，后面整段台词都是外文。
 *
 * 返回值始终是对象（不是 null）：`segments` 为空表示没取到，`loggedIn` 说明原因。
 * @returns {Promise<{segments:Array<{from:number,to:number,text:string}>, language:string, ai:boolean, loggedIn:boolean}>}
 */
export async function fetchOfficialSubtitle({ bvid, cid, sessdata = '', ...opts } = {}) {
  const empty = (loggedIn) => ({ segments: [], language: '', ai: false, loggedIn });
  if (!bvid || !cid) return empty(false);

  const data = await apiGet('/x/player/v2', { bvid, cid }, { sessdata, ...opts });
  const loggedIn = data?.isLogin === true || Number(data?.login_mid) > 0;
  const subs = data?.subtitle?.subtitles ?? [];
  if (!Array.isArray(subs) || subs.length === 0) return empty(loggedIn);

  const pick = subs.find((s) => /^zh/i.test(String(s?.lan ?? ''))) ?? subs[0];
  let url = String(pick?.subtitle_url ?? '');
  if (!url) return empty(loggedIn);
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('http://')) url = url.replace(/^http:\/\//, 'https://');

  const body = await getJson(url, opts);
  const segments = (Array.isArray(body?.body) ? body.body : [])
    .map((s) => ({
      from: Number(s?.from ?? 0),
      to: Number(s?.to ?? 0),
      text: String(s?.content ?? '').replace(/\s+/g, ' ').trim(),
    }))
    .filter((s) => s.text && Number.isFinite(s.from) && s.to > s.from);

  if (segments.length === 0) return empty(loggedIn);
  return {
    segments,
    language: String(pick?.lan ?? ''),
    ai: String(pick?.lan_doc ?? '').includes('AI') || pick?.ai_status === 1,
    loggedIn,
  };
}

/**
 * 顶层入口：给一个原始 input，能拿到官方字幕就返回，拿不到任何情况下都返回 null。
 *
 * 刻意不做缓存：一次 `/x/player/v2` 加一次字幕 JSON 通常 200–600ms，
 * 比 storyboard 任何一帧提取都便宜，缓存带来的失效问题反而不划算。
 */
export async function tryOfficialSubtitle({ input, cookiesPath, env = process.env, fetchImpl = fetch, log = () => {} } = {}) {
  if (!looksLikeBilibili(input)) return null;

  try {
    let url = input;
    if (SHORT_HOST_RE.test(url)) {
      const expanded = await resolveShortLink(url, { fetchImpl });
      if (!expanded) return null;
      url = expanded;
    }

    const parsed = parseBilibiliUrl(url);
    if (!parsed) return null;

    // cookie 来源（按可靠性排序）：
    //   ① BILI_SESSDATA 环境变量 —— bili-vision 用的就是这个，用户可能已经配过，直接复用
    //   ② cookies.txt 里的 SESSDATA —— yt-dlp 下高清用的那份，同一个登录态
    //   ③ 都没有 → 匿名，字幕接口会返回空列表（B 站 2023 起强制登录）
    let sessdata = String(env.BILI_SESSDATA ?? '').trim();
    let cookiePath = cookiesPath ?? null;
    if (!sessdata && !cookiePath) {
      try {
        const auth = await resolveAuth({ env });
        cookiePath = auth?.cookiesPath ?? null;
      } catch {
        cookiePath = null; // 配置指向的文件不存在 —— 按匿名处理，不阻断
      }
    }
    if (!sessdata && cookiePath) {
      try {
        sessdata = sessdataFromCookies(await readFile(cookiePath, 'utf8')) ?? '';
      } catch {
        sessdata = '';
      }
    }

    const meta = await fetchVideoMeta(parsed.bvid, { page: parsed.page, sessdata, fetchImpl });
    const subtitle = await fetchOfficialSubtitle({ bvid: parsed.bvid, cid: meta.cid, sessdata, fetchImpl });
    if (subtitle.segments.length === 0) {
      // 三种"没拿到"的原因要分开说 —— 用户据此决定去配 cookie、重导 cookie，还是什么都不用管。
      let why;
      if (!sessdata) {
        why = '[bilibili] 匿名拿不到 CC 字幕（B 站限制登录），配 cookies 或 BILI_SESSDATA 后可读官方字幕；这次走 ASR';
      } else if (!subtitle.loggedIn) {
        why = '[bilibili] SESSDATA 已失效（B 站仍判定为未登录），重新导出 cookies 后再试；这次走 ASR';
      } else {
        why = `[bilibili] 该视频确实没有官方 CC 字幕（${meta.title || parsed.bvid}），走 ASR`;
      }
      log(why);
      return null;
    }

    return { ...meta, ...subtitle };
  } catch (error) {
    // 接口改版、风控、网络抖动都到这里。字幕是加分项，不能让它炸掉主流程。
    log(`[bilibili] 官方字幕不可用，降级 ASR：${String(error?.message ?? error).slice(0, 160)}`);
    return null;
  }
}
