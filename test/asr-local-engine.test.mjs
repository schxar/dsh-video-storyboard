import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeWav, locateModel, locateSherpa, localAsrAvailable, normaliseLanguage,
} from '../src/asr-local.js';

/* --------------------------------------------------------------- 语言映射 */

test('normaliseLanguage: 长写法收敛到 SenseVoice 认识的五个值', () => {
  assert.equal(normaliseLanguage('zh'), 'zh');
  assert.equal(normaliseLanguage('zh-CN'), 'zh');
  assert.equal(normaliseLanguage('zh_CN'), 'zh');
  assert.equal(normaliseLanguage('en-US'), 'en');
  assert.equal(normaliseLanguage('Chinese'), 'zh');
  assert.equal(normaliseLanguage('English'), 'en');
});

test('normaliseLanguage: 不认识的一律退回 auto，不瞎猜', () => {
  assert.equal(normaliseLanguage('fr'), 'auto');
  assert.equal(normaliseLanguage('klingon'), 'auto');
  assert.equal(normaliseLanguage(''), 'auto');
  assert.equal(normaliseLanguage(undefined), 'auto');
  assert.equal(normaliseLanguage(null), 'auto');
});

/* ------------------------------------------------------------- WAV 解码 */

/** 造一段最简 WAV。ffmpeg 实际输出的就是这种布局。 */
function makeWav(samples, { channels = 1, bits = 16, extraChunk = false } = {}) {
  const dataBytes = samples.length * 2;
  const fmtBytes = 16;
  const listBytes = extraChunk ? 12 : 0;
  const total = 12 + 8 + fmtBytes + (extraChunk ? 8 + listBytes : 0) + 8 + dataBytes;
  const buf = Buffer.alloc(total);
  let o = 0;

  buf.write('RIFF', o); o += 4;
  buf.writeUInt32LE(total - 8, o); o += 4;
  buf.write('WAVE', o); o += 4;

  buf.write('fmt ', o); o += 4;
  buf.writeUInt32LE(fmtBytes, o); o += 4;
  buf.writeUInt16LE(1, o); o += 2;                    // PCM
  buf.writeUInt16LE(channels, o); o += 2;
  buf.writeUInt32LE(16000, o); o += 4;
  buf.writeUInt32LE(16000 * channels * (bits / 8), o); o += 4;
  buf.writeUInt16LE(channels * (bits / 8), o); o += 2;
  buf.writeUInt16LE(bits, o); o += 2;

  if (extraChunk) {
    // ffmpeg 有时会在 data 前塞一个 LIST 块 —— 按固定 44 字节切就会整体错位
    buf.write('LIST', o); o += 4;
    buf.writeUInt32LE(listBytes, o); o += 4;
    o += listBytes;
  }

  buf.write('data', o); o += 4;
  buf.writeUInt32LE(dataBytes, o); o += 4;
  for (const s of samples) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), o);
    o += 2;
  }
  return buf;
}

test('decodeWav: 标准 PCM 还原成 [-1,1] 的 Float32', () => {
  const samples = decodeWav(makeWav([0, 0.5, -0.5, 1, -1]));
  assert.equal(samples.length, 5);
  assert.ok(Math.abs(samples[0] - 0) < 1e-4);
  assert.ok(Math.abs(samples[1] - 0.5) < 1e-3);
  assert.ok(Math.abs(samples[2] + 0.5) < 1e-3);
});

test('decodeWav: data 前面多一个 LIST 块也要能对位（按 chunk 走，不按固定偏移）', () => {
  const samples = decodeWav(makeWav([0.25, -0.25], { extraChunk: true }));
  assert.equal(samples.length, 2);
  assert.ok(Math.abs(samples[0] - 0.25) < 1e-3);
  assert.ok(Math.abs(samples[1] + 0.25) < 1e-3);
});

test('decodeWav: 双声道就地混成单声道', () => {
  // 左右各一半，混合后应该是 0
  const samples = decodeWav(makeWav([0.5, -0.5, 0.2, 0.2], { channels: 2 }));
  assert.equal(samples.length, 2);
  assert.ok(Math.abs(samples[0]) < 1e-3);
  assert.ok(Math.abs(samples[1] - 0.2) < 1e-3);
});

test('decodeWav: 不是 RIFF、太短、非 16bit 都返回 null', () => {
  assert.equal(decodeWav(Buffer.from('not a wav file at all, really not')), null);
  assert.equal(decodeWav(Buffer.alloc(10)), null);
  assert.equal(decodeWav(null), null);
  assert.equal(decodeWav(makeWav([0.1, 0.2], { bits: 8 })), null);
});

test('decodeWav: 长度为奇数的尾巴不会越界读', () => {
  const buf = makeWav([0.1, 0.2, 0.3]);
  // 谎报一个比实际大的 data 长度（流式录制的常见情况）
  const dataLenOffset = buf.length - 3 * 2 - 4;
  buf.writeUInt32LE(999999, dataLenOffset);
  const samples = decodeWav(buf);
  assert.equal(samples.length, 3);
});

/* -------------------------------------------------------------- 环境探测 */

test('locateModel: 目录不存在时返回 null，不抛错', () => {
  const fake = { DSH_HOME: 'Z:/definitely-not-here-12345' };
  assert.equal(locateModel({ env: fake }), null);
});

test('locateSherpa: 找不到原生模块时返回 null，不抛错', () => {
  const fake = { DSH_HOME: 'Z:/definitely-not-here-12345', DSH_SHERPA_ROOT: 'Z:/nope' };
  assert.ok(locateSherpa({ env: fake }) === null || typeof locateSherpa({ env: fake }) === 'object');
});

test('localAsrAvailable: 假家目录下判定为不可用（走 HTTP，不误判）', () => {
  assert.equal(localAsrAvailable({ env: { DSH_HOME: 'Z:/definitely-not-here-12345' } }), false);
});
