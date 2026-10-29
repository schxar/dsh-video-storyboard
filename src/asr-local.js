/**
 * asr-local.js — 用本机已有的 SenseVoice 模型做转写，不需要任何 API key。
 *
 * 模型和运行时都是现成的，不用重新下载：
 *   · 模型  `~/.dsh/speech-to-text/sensevoice/models/sensevoice-onnx/`
 *           （DSH 的语音输入插件装好的：model.int8.onnx + tokens.txt，外加 silero_vad.onnx）
 *   · 运行时 `sherpa-onnx-node`（同样由那个插件带来，原生模块，win32-x64 已编译好）
 *
 * 为什么值得复用而不是让用户再配一个 ASR 服务：
 *   1. 那是 239MB 的模型，重下一遍纯浪费；
 *   2. storyboard 的主要用途是「看视频」，绝大多数人不会为了它单独起一个 whisper 服务；
 *   3. 官方 CC 字幕只覆盖 B 站，本地文件和别的站点仍然需要转写。
 *
 * 时间戳怎么来（这是关键，SenseVoice 本身**只吐文本**）：
 *   用 silero VAD 把音频切成语音段，每段的 `start` 是样本索引 → 除以 16000 就是秒。
 *   没有这一步，整段只能给一个 `from`，台词会被贴到错误的格子上。
 *
 * 一切异常都返回 null：本地转写是**兜底**，它挂了不能连带把出图也搞挂。
 */

import { join } from 'node:path';

import { voiceInputRuntime } from './deps.js';

/** SenseVoice 只吃 16k 单声道 —— ffmpeg 那边已经转好，这里只是常量。 */
const SAMPLE_RATE = 16000;

/** SenseVoice 支持的语言。'auto' 靠模型自己猜，猜错时输出会变成中英日混排的乱码。 */
const LANGS = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'yue']);

/** storyboard 传进来的 `zh` / `en` 之类映射到 SenseVoice 的取值，不认识的退回 auto。 */
export function normaliseLanguage(language) {
  const v = String(language ?? '').trim().toLowerCase();
  if (!v) return 'auto';
  if (LANGS.has(v)) return v;
  // 常见的长写法：zh-CN / en-US / Chinese
  const head = v.split(/[-_]/)[0];
  if (LANGS.has(head)) return head;
  if (v.startsWith('chinese') || v === 'cn') return 'zh';
  if (v.startsWith('english')) return 'en';
  return 'auto';
}

/**
 * 找模型。返回 null 表示这台机器上没装过语音输入插件，走不了本地这条路。
 *
 * 判据是**那个包在不在**，不是"某个路径下有没有文件"：模型文件名和精度档位都从
 * 包里的 runtime/assets.json 取，上游换文件名我们不用跟着改。
 * @returns {{model:string, tokens:string, vad:string, dir:string}|null}
 */
export function locateModel({ env = process.env } = {}) {
  const rt = voiceInputRuntime({ env });
  if (!rt.available) return null;
  return {
    model: rt.model,
    tokens: rt.tokens,
    vad: rt.vad,
    dir: join(rt.models, 'sensevoice-onnx'),
  };
}

/**
 * 找 `sherpa-onnx-node`。
 *
 * 它是语音输入包自己的依赖，所以从那个包的位置去 require —— 走 Node 正常的解析规则，
 * 比手拼一堆 node_modules 候选路径稳，也不依赖安装目录长什么样。
 * @returns {{sherpa:object, from:string}|null}
 */
export function locateSherpa({ env = process.env } = {}) {
  const rt = voiceInputRuntime({ env });
  if (!rt.available) return null;
  return { sherpa: rt.sherpa, from: rt.pkgDir };
}

/* ------------------------------------------------------------ WAV → Float32 */

/**
 * 从一段 WAV 里取出 16-bit PCM 转成 [-1,1] 的 Float32。
 *
 * 不假设 44 字节头：ffmpeg 有时会在 data 前面塞 LIST/fact 块。按 chunk 走一遍，
 * 遇到 'data' 才取——按固定偏移切会在那些文件上整体错位，听起来像"识别出乱码"。
 */
export function decodeWav(buffer) {
  if (!buffer || buffer.length < 44) return null;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  let offset = 12;
  let dataStart = -1;
  let dataLen = 0;
  let channels = 1;
  let bits = 16;

  while (offset + 8 <= view.byteLength) {
    const id = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;

    if (id === 'fmt ' && body + 16 <= view.byteLength) {
      channels = view.getUint16(body + 2, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataStart = body;
      // 长度字段偶尔比真实数据大（流式录制），夹一下防止越界读
      dataLen = Math.min(size, view.byteLength - body);
      break;
    }
    offset = body + size + (size % 2); // chunk 按偶数对齐
  }

  if (dataStart < 0 || dataLen <= 0 || bits !== 16) return null;

  const count = Math.floor(dataLen / 2);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    samples[i] = view.getInt16(dataStart + i * 2, true) / 32768;
  }
  // 多声道就地混成单声道（ffmpeg 那边已经 -ac 1，这里是防御）
  if (channels > 1) {
    const mono = new Float32Array(Math.floor(count / channels));
    for (let i = 0; i < mono.length; i += 1) {
      let sum = 0;
      for (let c = 0; c < channels; c += 1) sum += samples[i * channels + c];
      mono[i] = sum / channels;
    }
    return mono;
  }
  return samples;
}

/* ---------------------------------------------------------------- 推理引擎 */

/**
 * 引擎是进程级单例。**这不是性能优化，是必需的**：int8 模型 239MB，
 * 每次 transcribe 都重新 new 一遍的话，一条 5 分钟视频会被切 6–8 片，
 * 光加载就几十秒，比转写本身还慢。
 */
let engine = null;

function ensureEngine(paths, sherpa, threads) {
  if (engine && engine.model === paths.model && engine.sherpa === sherpa) return engine;

  const config = {
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: paths.model,
        language: 'auto',
        useInverseTextNormalization: 1,
      },
      tokens: paths.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  };
  const recognizer = new sherpa.OfflineRecognizer(config);
  // VAD 的环形缓冲要能装下「最长语音段 + 静音判定窗口」，否则长句子会被切开。
  const segmentSeconds = 20;
  const minSilence = 0.3;
  const vad = new sherpa.Vad({
    sileroVad: {
      model: paths.vad,
      threshold: 0.5,
      minSilenceDuration: minSilence,
      minSpeechDuration: 0.25,
      maxSpeechDuration: segmentSeconds,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    provider: 'cpu',
    debug: 0,
  }, segmentSeconds + minSilence + 1);

  engine = { model: paths.model, sherpa, recognizer, vad, config, segmentSeconds };
  return engine;
}

/** 测试用：把缓存的引擎丢掉 */
export function __resetEngine() {
  engine = null;
}

/**
 * 核心：一段 Float32 音频 → 带时间戳的句子。
 *
 * VAD 切出来的每段单独 decode —— 比"整段丢进去出坨文本"多出的正是**时间信息**，
 * 而时间信息是 storyboard 唯一真正在乎的东西。
 */
function decodeWithTimestamps(eng, samples, { offset = 0, language = 'auto' } = {}) {
  const { vad, recognizer, config } = eng;
  vad.reset();

  // 语言每次都要重新下发：config 对象是复用的，改完必须 setConfig 才生效。
  // 不设的话它一直用上一次的值 —— 先跑中文再跑英文片就会整段串味。
  config.modelConfig.senseVoice.language = normaliseLanguage(language);
  recognizer.setConfig(config);

  const out = [];
  const push = () => {
    while (!vad.isEmpty()) {
      const segment = vad.front(false);
      const speech = segment.samples;
      if (speech && speech.length > 0) {
        const stream = recognizer.createStream();
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: speech });
        recognizer.decode(stream);
        const text = String(recognizer.getResult(stream).text ?? '').trim();
        if (text) {
          const from = offset + segment.start / SAMPLE_RATE;
          const to = from + speech.length / SAMPLE_RATE;
          out.push({ from: +from.toFixed(3), to: +to.toFixed(3), text });
        }
      }
      vad.pop();
    }
  };

  for (let i = 0; i < samples.length; i += 512) {
    vad.acceptWaveform(samples.subarray(i, Math.min(i + 512, samples.length)));
    push();
  }
  vad.flush();
  push();

  void config;
  return out;
}

/**
 * 对外入口：一段 WAV buffer → `{segments, model, language}`；不可用时返回 null。
 *
 * @param {Buffer} wavBuffer  ffmpeg 抽出来的 16k 单声道 wav
 * @param {{offset?:number, language?:string, env?:NodeJS.ProcessEnv, threads?:number}} opts
 */
export function transcribeLocal(wavBuffer, { offset = 0, language = 'auto', env = process.env, threads = 2 } = {}) {
  // 一次探测拿全部：模型路径、原生运行时、包目录。分两次调（locateModel + locateSherpa）
  // 会把模块解析和文件存在性检查各跑一遍，白花时间。
  const rt = voiceInputRuntime({ env, });
  if (!rt.available) return null;

  const samples = decodeWav(wavBuffer);
  if (!samples || samples.length === 0) return null;

  const eng = ensureEngine(rt, rt.sherpa, threads);
  const segments = decodeWithTimestamps(eng, samples, { offset, language });
  if (segments.length === 0) {
    // 静音片：返回空数组而不是 null，让上层知道"确实跑了、确实没话"
    return { segments: [], model: 'sensevoice-local', language: normaliseLanguage(language) };
  }
  return {
    segments,
    model: 'sensevoice-local',
    language: normaliseLanguage(language),
  };
}

/** 本机到底能不能走本地转写（给 --plan 和能力提示用，不加载模型） */
export function localAsrAvailable({ env = process.env } = {}) {
  return voiceInputRuntime({ env }).available;
}

/**
 * 本地转写为什么不可用 —— 直接说人话，别让人去猜是模型坏了还是包没装。
 * @returns {string|null} 可用时返回 null
 */
export function localAsrUnavailableReason({ env = process.env } = {}) {
  const rt = voiceInputRuntime({ env });
  return rt.available ? null : (rt.reason ?? '本地语音识别不可用');
}
