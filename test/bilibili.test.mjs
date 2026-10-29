import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fetchOfficialSubtitle, fetchVideoMeta, looksLikeBilibili, parseBilibiliUrl,
  resolveShortLink, sessdataFromCookies, tryOfficialSubtitle,
} from '../src/bilibili.js';

/* ------------------------------------------------------------------ 假 fetch */

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
  ...init,
});

/** 按 url 正则分派；没命中就抛 —— 测试里"多打了一次没预期的请求"必须炸出来，不能静默。 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const href = typeof url === 'string' ? url : String(url);
    calls.push(href);
    for (const [pattern, handler] of routes) {
      if (pattern.test(href)) return handler(href, init);
    }
    throw new Error(`unexpected fetch: ${href}`);
  };
  impl.calls = calls;
  return impl;
}

const okApi = (data) => jsonResponse({ code: 0, message: '0', data });

/* ------------------------------------------------------------ 链接与 BV 号 */

test('parseBilibiliUrl: 标准链接、分 P、裸 BV 号', () => {
  assert.deepEqual(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7'),
    { bvid: 'BV1GJ411x7h7', page: 1 });
  assert.deepEqual(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3&spm_id_from=333'),
    { bvid: 'BV1GJ411x7h7', page: 3 });
  // 裸 BV 号（没有 scheme）也要认，用户从别处粘贴时经常只有这一串
  assert.deepEqual(parseBilibiliUrl('BV1fq4y1u7nC'), { bvid: 'BV1fq4y1u7nC', page: 1 });
});

test('parseBilibiliUrl: 非 B 站、本地路径、空值都返回 null', () => {
  assert.equal(parseBilibiliUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(parseBilibiliUrl('D:/videos/BV1GJ411x7h7.mp4'.replace('BV1GJ411x7h7', 'clip')), null);
  assert.equal(parseBilibiliUrl(''), null);
  assert.equal(parseBilibiliUrl(null), null);
  assert.equal(parseBilibiliUrl(undefined), null);
});

test('parseBilibiliUrl: 非法 p 参数回落为第 1 P', () => {
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=0').page, 1);
  assert.equal(parseBilibiliUrl('https://www.bilibili.com/video/BV1GJ411x7h7?p=abc').page, 1);
});

test('looksLikeBilibili: 只有 BV 链接和短链值得走这条路', () => {
  assert.equal(looksLikeBilibili('https://www.bilibili.com/video/BV1GJ411x7h7'), true);
  assert.equal(looksLikeBilibili('https://b23.tv/AbCdEf'), true);
  assert.equal(looksLikeBilibili('/tmp/a.mp4'), false);
  assert.equal(looksLikeBilibili('https://example.com/a.mp4'), false);
});

/* --------------------------------------------------------------- cookies */

// Netscape 格式每行 7 列，Tab 分隔 —— 少一列就会被整行忽略，这很容易写错。
const cookieLine = (domain, name, value) => [domain, 'TRUE', '/', 'TRUE', '0', name, value].join('\t');

test('sessdataFromCookies: 从 yt-dlp 的 cookies.txt 里抠出 SESSDATA', () => {
  const text = [
    '# Netscape HTTP Cookie File',
    '# 注释行不能当数据',
    cookieLine('.bilibili.com', 'buvid3', 'AAA'),
    cookieLine('.bilibili.com', 'SESSDATA', 'deadbeef%2C1700000000%2Cabc*11'),
    '',
  ].join('\n');
  assert.equal(sessdataFromCookies(text), 'deadbeef%2C1700000000%2Cabc*11');
});

test('sessdataFromCookies: 别的域名下的同名 cookie 不算数', () => {
  const text = cookieLine('.example.com', 'SESSDATA', 'WRONG');
  assert.equal(sessdataFromCookies(text), null);
});

test('sessdataFromCookies: 没有 SESSDATA、空文本、undefined 都返回 null', () => {
  assert.equal(sessdataFromCookies(cookieLine('.bilibili.com', 'buvid3', 'A')), null);
  assert.equal(sessdataFromCookies(''), null);
  assert.equal(sessdataFromCookies(undefined), null);
  // 列数不足（真实文件里偶尔有被截断的行）不能当成有效行
  assert.equal(sessdataFromCookies('SESSDATA\tvalue'), null);
});

/* ------------------------------------------------------------- 元数据接口 */

test('fetchVideoMeta: 单 P 视频直接取 cid 与时长', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/, () => okApi({
    aid: 123, title: '测试视频', cid: 456, duration: 213,
    owner: { name: '某 UP' }, tname: '生活',
  })]]);
  const meta = await fetchVideoMeta('BV1GJ411x7h7', { fetchImpl });
  assert.equal(meta.cid, 456);
  assert.equal(meta.duration, 213);
  assert.equal(meta.owner, '某 UP');
  assert.equal(meta.pageCount, 1);
  assert.equal(meta.title, '测试视频');       // 单 P 不该被加上 "/ P1" 后缀
});

test('fetchVideoMeta: 多 P 要按 page 选对 cid —— 选错会让字幕和画面错位', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/, () => okApi({
    aid: 1, title: '合集', cid: 999, duration: 100, owner: { name: 'UP' },
    pages: [
      { cid: 111, duration: 100, part: '第一集' },
      { cid: 222, duration: 200, part: '第二集' },
    ],
  })]]);
  const meta = await fetchVideoMeta('BV1GJ411x7h7', { page: 2, fetchImpl });
  assert.equal(meta.cid, 222);
  assert.equal(meta.duration, 200);
  assert.match(meta.title, /P2.*第二集/);
});

test('fetchVideoMeta: page 越界钳到最后一个分 P，不抛错', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/, () => okApi({
    title: '合集', cid: 1, duration: 10, owner: { name: 'UP' },
    pages: [{ cid: 111, duration: 10, part: 'A' }, { cid: 222, duration: 20, part: 'B' }],
  })]]);
  assert.equal((await fetchVideoMeta('BV1x', { page: 9, fetchImpl })).cid, 222);
  assert.equal((await fetchVideoMeta('BV1x', { page: 0, fetchImpl })).cid, 111);
});

test('fetchVideoMeta: B 站业务失败（code != 0）要抛出来，不能当数据用', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/,
    () => jsonResponse({ code: -404, message: '啥都木有' })]]);
  await assert.rejects(() => fetchVideoMeta('BV1x', { fetchImpl }), /-404/);
});

/* ------------------------------------------------------------- 字幕接口 */

test('fetchOfficialSubtitle: 解析字幕 JSON，过滤空句，优先中文', async () => {
  const fetchImpl = fakeFetch([
    [/\/x\/player\/v2/, () => okApi({
      subtitle: {
        subtitles: [
          { lan: 'en', lan_doc: 'English', subtitle_url: '//aisubtitle.hdslb.com/en.json' },
          { lan: 'zh-CN', lan_doc: '中文（自动生成）', subtitle_url: 'https://aisubtitle.hdslb.com/zh.json' },
        ],
      },
    })],
    [/zh\.json$/, () => jsonResponse({
      body: [
        { from: 0.5, to: 2.1, content: '第一句' },
        { from: 2.1, to: 3.0, content: '   ' },      // 空白句要丢掉
        { from: 3.0, to: 5.5, content: '第二句' },
      ],
    })],
  ]);
  const sub = await fetchOfficialSubtitle({ bvid: 'BV1x', cid: 1, sessdata: 'S', fetchImpl });
  assert.equal(sub.language, 'zh-CN');
  assert.deepEqual(sub.segments, [
    { from: 0.5, to: 2.1, text: '第一句' },
    { from: 3.0, to: 5.5, text: '第二句' },
  ]);
});

test('fetchOfficialSubtitle: 没有字幕列表时返回空段 + loggedIn=false（未登录的典型表现）', async () => {
  const fetchImpl = fakeFetch([[/\/x\/player\/v2/, () => okApi({ subtitle: { subtitles: [] } })]]);
  const res = await fetchOfficialSubtitle({ bvid: 'BV1x', cid: 1, fetchImpl });
  assert.deepEqual(res.segments, []);
  assert.equal(res.loggedIn, false);
});

test('fetchOfficialSubtitle: 已登录但该片无字幕时 loggedIn=true（原因要和未登录分开）', async () => {
  const fetchImpl = fakeFetch([[/\/x\/player\/v2/, () => okApi({
    isLogin: true, login_mid: 42, subtitle: { subtitles: [] },
  })]]);
  const res = await fetchOfficialSubtitle({ bvid: 'BV1x', cid: 1, sessdata: 'S', fetchImpl });
  assert.deepEqual(res.segments, []);
  assert.equal(res.loggedIn, true);
});

test('fetchOfficialSubtitle: 字幕体全空也返回空段，不返回空数组当成功', async () => {
  const fetchImpl = fakeFetch([
    [/\/x\/player\/v2/, () => okApi({
      isLogin: true,
      subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://x/empty.json' }] },
    })],
    [/empty\.json$/, () => jsonResponse({ body: [] })],
  ]);
  const res = await fetchOfficialSubtitle({ bvid: 'BV1x', cid: 1, fetchImpl });
  assert.deepEqual(res.segments, []);
  assert.equal(res.loggedIn, true);
});

test('fetchOfficialSubtitle: 缺 bvid 或 cid 直接返回空，不发请求', async () => {
  const fetchImpl = fakeFetch([]);
  assert.deepEqual((await fetchOfficialSubtitle({ bvid: '', cid: 1, fetchImpl })).segments, []);
  assert.deepEqual((await fetchOfficialSubtitle({ bvid: 'BV1x', cid: 0, fetchImpl })).segments, []);
  assert.equal(fetchImpl.calls.length, 0);
});

/* ------------------------------------------------------- 短链与顶层降级 */

test('resolveShortLink: 跟随 302 到视频页', async () => {
  const fetchImpl = fakeFetch([[/b23\.tv/, () => new Response(null, {
    status: 302,
    headers: { location: 'https://www.bilibili.com/video/BV1GJ411x7h7?p=1' },
  })]]);
  const out = await resolveShortLink('https://b23.tv/AbCdEf', { fetchImpl });
  assert.match(out, /BV1GJ411x7h7/);
});

test('tryOfficialSubtitle: 非 B 站输入一个请求都不发', async () => {
  const fetchImpl = fakeFetch([]);
  assert.equal(await tryOfficialSubtitle({ input: 'D:/v/a.mp4', env: {}, fetchImpl }), null);
  assert.equal(await tryOfficialSubtitle({ input: 'https://youtu.be/xxx', env: {}, fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('tryOfficialSubtitle: 有 SESSDATA 时把元数据与字幕一起带回来', async () => {
  const fetchImpl = fakeFetch([
    [/\/x\/web-interface\/view/, () => okApi({
      aid: 7, title: '真视频', cid: 42, duration: 60, owner: { name: 'UP' },
    })],
    [/\/x\/player\/v2/, () => okApi({
      subtitle: { subtitles: [{ lan: 'zh-CN', subtitle_url: 'https://h/z.json' }] },
    })],
    [/z\.json$/, () => jsonResponse({ body: [{ from: 0, to: 2, content: '你好' }] })],
  ]);
  const out = await tryOfficialSubtitle({
    input: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    env: { BILI_SESSDATA: 'SESS' },
    fetchImpl,
  });
  assert.equal(out.bvid, 'BV1GJ411x7h7');
  assert.equal(out.cid, 42);
  assert.equal(out.title, '真视频');
  assert.deepEqual(out.segments, [{ from: 0, to: 2, text: '你好' }]);
});

test('tryOfficialSubtitle: 接口炸了也只返回 null，绝不把异常抛给主流程', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/, () => { throw new Error('network down'); }]]);
  const out = await tryOfficialSubtitle({
    input: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    env: { BILI_SESSDATA: 'SESS' },
    fetchImpl,
  });
  assert.equal(out, null);
});

test('tryOfficialSubtitle: HTTP 500 也降级为 null', async () => {
  const fetchImpl = fakeFetch([[/\/x\/web-interface\/view/, () => new Response('boom', { status: 500 })]]);
  assert.equal(await tryOfficialSubtitle({
    input: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    env: { BILI_SESSDATA: 'SESS' },
    fetchImpl,
  }), null);
});

test('tryOfficialSubtitle: 有字幕列表但字幕体取不到时降级为 null', async () => {
  const fetchImpl = fakeFetch([
    [/\/x\/web-interface\/view/, () => okApi({ title: 't', cid: 1, duration: 10, owner: {} })],
    [/\/x\/player\/v2/, () => okApi({
      subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://h/missing.json' }] },
    })],
    [/missing\.json$/, () => { throw new Error('404'); }],
  ]);
  assert.equal(await tryOfficialSubtitle({
    input: 'https://www.bilibili.com/video/BV1GJ411x7h7',
    env: { BILI_SESSDATA: 'SESS' },
    fetchImpl,
  }), null);
});
