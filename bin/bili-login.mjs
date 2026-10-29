#!/usr/bin/env node
/**
 * bili-login.mjs — B 站扫码登录，把 SESSDATA 落到 cookies.txt。
 *
 *   node bin/bili-login.mjs              出码 → 扫码 → 写 cookies.txt + ~/.dsh/video.json
 *   node bin/bili-login.mjs --from <f>   从别处已有的凭证据导入（如 bili_credential.json），不用再扫码
 *   node bin/bili-login.mjs --check      只检查现有 cookies 还有没有登录态
 *   node bin/bili-login.mjs --out a.png  指定二维码图片路径
 *   node bin/bili-login.mjs --no-config  只写 cookies.txt，不动 ~/.dsh/video.json
 *
 * 为什么要登录：B 站对未登录用户有两道限制 —— 1080P 根本不出现在格式列表里
 * （下游察觉不到自己被降级），以及 CC 字幕接口返回空列表。扫码一次两边都通。
 *
 * 接口顺序照 bili-subagent 实测跑通的那条走（它踩过"把码存成 PNG 就返回、字段全空"的坑）：
 *   ① GET  /x/passport-login/web/qrcode/generate  → data.url + data.qrcode_key
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll
 *      data.code: 86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ ⭐ **凭证在轮询响应的 Set-Cookie 头里**。成功时 data.url 里没有 SESSDATA
 *      （那是别的域的游戏票），在 url 里找永远找不到。
 *   ④ 写 Netscape 格式的 cookies.txt —— yt-dlp 和本插件的官方字幕都读这一份。
 *
 * 二维码渲染用 `qrcode` 包（纯 JS，无原生依赖）。装在 profile 里通常已经有一份
 * （别的插件带进来的）；实在没有就退回"只给 URL"，自己去任意二维码工具生成。
 */

import { existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

import { BILI_SCROLL_PKGS, biliCredentialSource } from '../src/deps.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header';
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
  + `?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`;
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const COOKIES_PATH = join(DSH_HOME, 'bilibili-cookies.txt');
const VIDEO_CONFIG = join(DSH_HOME, 'video.json');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const valueOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

/* ------------------------------------------------------------------ cookie */

/**
 * 从 Set-Cookie 数组里抠出要的字段。
 *
 * ⚠ Node 的 `res.headers.get('set-cookie')` 会把多条揉成一个逗号串，值里本身带逗号时
 * 一切就乱了。必须用 `getSetCookie()` 拿数组。
 */
function pickCookies(list) {
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' };
  const jar = {};
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || '';
    const i = first.indexOf('=');
    if (i <= 0) continue;
    const name = first.slice(0, i).trim();
    const value = first.slice(i + 1).trim();
    if (want[name] && value) jar[want[name]] = value;
  }
  return jar;
}

/** buvid3 拿不到时补一张"指纹"（非致命，失败就当空） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar;
  try {
    const res = await fetch(SPI, { headers: { 'User-Agent': UA } });
    const json = await res.json();
    const v = json?.data?.b_3;
    if (v) jar.buvid3 = v;
  } catch { /* 拿不到就算了，不影响字幕 */ }
  return jar;
}

/** Netscape cookies.txt 的过期时间：一年后。用秒级时间戳，0 表示会话 cookie。 */
const oneYearLater = () => Math.floor(Date.now() / 1000) + 365 * 24 * 3600;

/**
 * 写成 yt-dlp / storyboard 都认的 Netscape 格式。
 *
 * 每行 7 列，Tab 分隔：domain / includeSubdomains / path / secure / expiry / name / value
 * 少一列整行都会被忽略 —— 这是手写 cookies.txt 最常见的错法。
 */
async function writeCookiesTxt(jar) {
  await mkdir(dirname(COOKIES_PATH), { recursive: true });
  const exp = oneYearLater();
  const rows = [
    ['SESSDATA', jar.sessdata],
    ['bili_jct', jar.bili_jct],
    ['DedeUserID', jar.dedeuserid],
    ['buvid3', jar.buvid3],
  ].filter(([, v]) => v);

  const lines = [
    '# Netscape HTTP Cookie File',
    '# 由 dsh-video-storyboard 的 bili-login 生成；换账号就重跑一次',
    '',
    ...rows.map(([name, val]) => ['.bilibili.com', 'TRUE', '/', 'TRUE', String(exp), name, val].join('\t')),
    '',
  ];
  await writeFile(COOKIES_PATH, lines.join('\n'), 'utf8');

  // 这个文件等于账号钥匙。Windows 上 chmod 基本无效，但在 Linux/macOS 上是实打实的隔离。
  try {
    const { chmod } = await import('node:fs/promises');
    await chmod(COOKIES_PATH, 0o600);
  } catch { /* 文件系统不支持就算了，别把登录搞挂 */ }

  return COOKIES_PATH;
}

/** 把 cookies 路径写进 ~/.dsh/video.json（保留原有其它字段） */
async function writeVideoConfig() {
  let current = {};
  try {
    current = JSON.parse(await readFile(VIDEO_CONFIG, 'utf8')) ?? {};
  } catch { current = {}; }
  if (current.cookies === COOKIES_PATH) return { changed: false, path: VIDEO_CONFIG };
  const next = { ...current, cookies: COOKIES_PATH };
  await mkdir(dirname(VIDEO_CONFIG), { recursive: true });
  try {
    await copyFile(VIDEO_CONFIG, `${VIDEO_CONFIG}.bak-${Date.now()}`);
  } catch { /* 原文件不存在就没有备份可做 */ }
  await writeFile(VIDEO_CONFIG, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { changed: true, path: VIDEO_CONFIG };
}

/* ------------------------------------------------------------------ 二维码 */

/**
 * 找一个能用 qrcode。
 *
 * 为什么不写死在 package.json：storyboard 是零依赖装法（clone 就能跑），
 * 为了一个一次性的登录动作引进一个 npm 依赖不划算。
 *
 * 但裸 `import('qrcode')` 在两种常见位置会失败：
 *   · 开发目录（D:\...\dsh-video-storyboard）—— ESM 按文件位置向上找，找不到 profile 里的包
 *   · 装到别的 profile 时 —— 那份 qrcode 是别的插件带进来的，不保证存在
 * 所以补一条"去 DSH 各 profile 的 node_modules 里翻"的退路。都没有就交给调用方降级。
 */
async function loadQrcode() {
  try {
    const mod = await import('qrcode');
    return mod.default ?? mod;
  } catch { /* 继续找 */ }

  const profilesDir = join(DSH_HOME, 'profiles');
  let names = [];
  try {
    names = await readdir(profilesDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const entry = join(profilesDir, name, 'node_modules', 'qrcode', 'lib', 'index.js');
    try {
      await access(entry);
    } catch {
      continue;
    }
    try {
      const mod = await import(pathToFileURL(entry).href);
      return mod.default ?? mod;
    } catch { /* 这个 profile 里的坏了，试下一个 */ }
  }
  return null;
}

async function renderQr(url, outPath) {
  const qrcode = await loadQrcode();
  if (!qrcode) {
    return { error: '没找到 qrcode 包（可以 npm i qrcode 后再试）' };
  }
  try {
    await qrcode.toFile(outPath, url, {
      width: 480,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#FFFFFF' },
    });
    return outPath;
  } catch (error) {
    // 渲染失败不是致命错误：把 URL 给出去，用户自己找工具生成即可。
    return { error: String(error?.message ?? error) };
  }
}

/* -------------------------------------------------------------------- 登录 */

async function loginStart() {
  const res = await fetch(GEN, { headers: { 'User-Agent': UA } });
  const json = await res.json();
  const data = json?.data;
  if (!data?.qrcode_key || !data?.url) {
    throw new Error(`生成二维码失败：${json?.message || '返回里没有 qrcode_key'}`);
  }
  return { key: data.qrcode_key, url: data.url };
}

/** 轮询一次。redirect:'manual' 是必须的 —— follow 会把 Set-Cookie 吃在跳转里拿不到。 */
async function loginPoll(key) {
  const res = await fetch(pollUrl(key), {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
  });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  let body = {};
  try { body = await res.json(); } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code;
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies));
    if (!jar.sessdata) {
      return { state: 'unknown', code, message: '登录成功了但响应里没有 SESSDATA' };
    }
    return { state: 'ok', code, credential: jar };
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' };
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' };
}

const STATE_TEXT = {
  waiting: '等待扫码…',
  scanned: '已扫码，请在手机上点确认',
  expired: '二维码已过期',
  unknown: '状态未知',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function doLogin({ outPath }) {
  const { key, url } = await loginStart();
  const png = await renderQr(url, outPath);

  console.log('─'.repeat(64));
  if (typeof png === 'string') {
    console.log(`二维码已生成：${png}`);
    console.log('用手机 B 站 App → 我的 → 扫一扫（点「记住我」可以久一点）');
  } else {
    console.log('没装上 qrcode 包，二维码图片没画出来。把下面这个链接用任意二维码工具生成后扫：');
    console.log(`  ${url}`);
    console.log(`（原因：${png.error}）`);
  }
  console.log('─'.repeat(64));

  const deadline = Date.now() + 180_000;
  let last = '';
  while (Date.now() < deadline) {
    let result;
    try {
      result = await loginPoll(key);
    } catch (error) {
      // 单次网络抖动不该中断整个登录，继续轮询
      process.stderr.write(`轮询失败，重试：${String(error?.message ?? error).slice(0, 120)}\n`);
      await sleep(2000);
      continue;
    }

    if (result.state === 'ok') {
      const file = await writeCookiesTxt(result.credential);
      console.log(`\n✓ 登录成功，cookies 已写入 ${file}`);
      if (!flag('--no-config')) {
        const cfg = await writeVideoConfig();
        console.log(cfg.changed
          ? `✓ 已把 cookies 路径写进 ${cfg.path}`
          : `· ${cfg.path} 里已经指向这份 cookies，没改动`);
      }
      console.log('\n现在 1080P 和官方 CC 字幕都能用了。');
      return 0;
    }

    if (result.state === 'expired') {
      console.error(`\n✗ ${STATE_TEXT.expired}，重新运行一次就好。`);
      return 2;
    }

    if (result.state !== last) {
      last = result.state;
      console.log(`  ${STATE_TEXT[result.state] ?? result.state}`);
    }
    await sleep(2000);
  }

  console.error('\n✗ 等了三分钟还没扫，二维码已失效。重新运行一次。');
  return 3;
}

/* ------------------------------------------------------------------ 自检 */

/** 账号信息接口：比 playurl 更直接，一次就能看出"是不是登录着、登的是谁"。 */
const NAV = 'https://api.bilibili.com/x/web-interface/nav';

/**
 * 验证一份 SESSDATA 还活着没有。
 * @returns {Promise<{ok:boolean, mid?:number, uname?:string}>}
 */
async function checkSessdata(sessdata) {
  if (!sessdata) return { ok: false };
  const res = await fetch(NAV, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Cookie: `SESSDATA=${sessdata}` },
  });
  const json = await res.json();
  const d = json?.data ?? {};
  // 未登录时 isLogin:false 且 code:-101；两者都要认
  const ok = json?.code === 0 && d.isLogin === true && Number(d.mid) > 0;
  return { ok, mid: Number(d.mid) || undefined, uname: d.uname || undefined };
}

/** 读一份别处插件留下的凭证（bili-subagent 写的是 bili_credential.json）并验证。 */
async function importCredential(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    console.error(`✗ 读不了凭证文件 ${file}：${String(error?.message ?? error).slice(0, 160)}`);
    return 1;
  }
  // 字段名以 bili-subagent 的为准（dedeuserid 全小写）；顺手兼容一下别的写法
  const jar = {
    sessdata: raw.sessdata ?? raw.SESSDATA,
    bili_jct: raw.bili_jct,
    dedeuserid: raw.dedeuserid ?? raw.deduuserid ?? raw.DedeUserID,
    buvid3: raw.buvid3,
  };
  if (!jar.sessdata) {
    console.error(`✗ ${file} 里没有 sessdata 字段，这份凭证用不了`);
    return 1;
  }

  const check = await checkSessdata(jar.sessdata);
  if (!check.ok) {
    console.error(`✗ ${file} 里的凭证已失效（B 站判定未登录），需要重新扫码：node bin/bili-login.mjs`);
    return 1;
  }

  const out = await writeCookiesTxt(jar);
  console.log(`✓ 凭证有效（${check.uname ?? '?'} · uid ${check.mid ?? '?'}），cookies 已写入 ${out}`);
  if (!flag('--no-config')) {
    const cfg = await writeVideoConfig();
    console.log(cfg.changed
      ? `✓ 已把 cookies 路径写进 ${cfg.path}`
      : `· ${cfg.path} 里已经指向这份 cookies，没改动`);
  }
  console.log('\n现在 1080P 和官方 CC 字幕都能用了。');
  return 0;
}

/** 用账号接口判断现有 cookies 还是不是登录态。 */
async function checkLogin() {
  let sessdata = '';
  try {
    const text = await readFile(COOKIES_PATH, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length >= 7 && cols[5] === 'SESSDATA') { sessdata = cols[6]; break; }
    }
  } catch {
    console.log(`✗ 还没有 cookies 文件：${COOKIES_PATH}\n  跑一次 ${'node bin/bili-login.mjs'}，或用 --from 导入现成凭证`);
    return 1;
  }
  if (!sessdata) {
    console.log(`✗ ${COOKIES_PATH} 里没有 SESSDATA，重跑登录`);
    return 1;
  }

  const check = await checkSessdata(sessdata);
  console.log(check.ok
    ? `✓ cookies 有效（${check.uname ?? '?'} · uid ${check.mid ?? '?'}）`
    : '✗ cookies 已失效或未登录，重跑一次 node bin/bili-login.mjs');
  return check.ok ? 0 : 1;
}

/* -------------------------------------------------------------------- main */

/**
 * 先看别的插件有没有留登录态。
 *
 * 装了 `dsh-bili-scroll` 的人必然已经登录过一次（那个插件不登录干不了活），
 * 凭证就摆在那儿。这时候再让人掏手机扫一遍是纯粹浪费 —— 直接借来用。
 *
 * @returns {Promise<number|null>} 0 复用成功 / 1 有文件但失效 / null 没有可复用的
 */
async function tryReuseCredential() {
  const src = biliCredentialSource();
  if (!src) {
    console.log(`· 没装 ${BILI_SCROLL_PKGS[0]}，没有可复用的登录态，走扫码`);
    return null;
  }
  if (!existsSync(src.credential)) {
    console.log('· 装了 bili-scroll 但它还没登录过，走扫码');
    return null;
  }
  console.log(`· 发现 bili-scroll 留下的凭证：${src.credential}`);
  return importCredential(src.credential);
}

const outPath = valueOf('--out')
  || join(DSH_HOME, 'bilibili-qrcode.png');

const fromFile = valueOf('--from');

if (flag('--check')) {
  process.exitCode = await checkLogin();
} else if (fromFile) {
  // 显式指定就从指定文件导
  process.exitCode = await importCredential(fromFile);
} else {
  // 没指定：先试现成凭证，实在没有才出二维码
  const reused = await tryReuseCredential();
  if (reused === 0) {
    process.exitCode = 0;
  } else {
    // 二维码图片要先落到磁盘，所以确保父目录在
    await mkdir(dirname(outPath), { recursive: true });
    process.exitCode = await doLogin({ outPath });
  }
}
