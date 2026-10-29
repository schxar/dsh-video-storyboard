/**
 * deps.js — 找到"宿主装了、但不属于我们"的那些包。
 *
 * 背景：storyboard 有两块能力**寄生**在别的 DSH 插件上，而不是自己复制一份：
 *
 *   · 本地语音识别 —— 模型（239MB）和原生运行时（sherpa-onnx-node）
 *     都由 `@deepseek-ai/dsh-experimental-voice-input-bundle` 带来；
 *   · B 站免扫码 —— 登录态是 `dsh-bili-scroll`（包名 dsh-bili-subagent）写下的
 *     `~/.dsh/bili-duty/bili_credential.json`。
 *
 * 这两个包是 DSH 生态里的底层公共件，绝大多数装机都有。**它们不在我们的依赖树里**，
 * 所以不能裸 import —— 但也正因为如此，我们不能假定它们在，只能探。
 *
 * 探测顺序（从最可靠到最兜底）：
 *   1. 从本模块自身位置向上找 —— 插件被装进某个 profile 时，这就是那条正确的链
 *   2. DSH 各 profile 的 node_modules —— 开发和跨 profile 调用时的常见情况
 *   3. `$DSH_HOME/node_modules`
 *   4. **从当前可执行文件反推** `resources/app/node_modules` —— 桌面端把宿主包放在
 *      安装目录里，这一条比写死 `D:/DSHV2/...` 靠谱得多：换安装盘、改目录名都还成立
 *   5. `$DSH_EXTRA_MODULE_ROOTS`（冒号/分号分隔）—— 留给特殊布局
 *
 * 全都找不到就返回 null，调用方据此把对应功能关掉。**不抛错、不猜**。
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));

/** DSH 家目录 */
export const dshHome = (env = process.env) => env.DSH_HOME || join(homedir(), '.dsh');

/**
 * 可能藏着宿主包的 node_modules 根目录，按可靠性排序、去重。
 * @returns {string[]}
 */
export function moduleRoots({ env = process.env } = {}) {
  const roots = [];
  const seen = new Set();
  const add = (dir) => {
    if (typeof dir !== 'string' || dir === '' || seen.has(dir)) return;
    seen.add(dir);
    roots.push(dir);
  };

  // 1. 自身向上 —— 插件装在 profile 里时，这条链末尾正是 profile 的 node_modules
  let cursor = HERE;
  for (let i = 0; i < 6; i += 1) {
    add(join(cursor, 'node_modules'));
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  // 2. DSH 各 profile
  const home = dshHome(env);
  for (const name of ['web', 'desktop', 'headless']) {
    add(join(home, 'profiles', name, 'node_modules'));
  }
  add(join(home, 'node_modules'));

  // 3. 桌面端：从可执行文件反推，而不是写死安装路径。
  //    注意这条**只在插件里跑时**才准 —— 那时 execPath 是 DSH Desktop.exe。
  //    用 `node bin/storyboard.mjs` 独立跑时 execPath 是 node.exe，反推出来是空，
  //    所以下面还有一档兜底。
  if (env.DSH_DESKTOP_APP) add(join(env.DSH_DESKTOP_APP, 'node_modules'));
  try {
    const exeDir = dirname(process.execPath);
    add(join(exeDir, 'resources', 'app', 'node_modules'));
    add(join(exeDir, '..', 'resources', 'app', 'node_modules'));
  } catch {
    /* 拿不到就算了 */
  }

  // 3b. 兜底：CLI 模式下反推不出来，扫几个常见安装位置。
  //     这一档存在的唯一理由是 `node bin/storyboard.mjs` 这种独立用法；
  //     想让插件完全不依赖它，设 DSH_DESKTOP_APP 即可（优先级更高）。
  const localAppData = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  for (const base of [
    'D:/DSHV2/DSH Desktop',
    'D:/DSH Desktop',
    'C:/Program Files/DSH Desktop',
    join(localAppData, 'Programs', 'DSH Desktop'),
  ]) {
    add(join(base, 'resources', 'app', 'node_modules'));
  }

  // 4. 用户显式追加
  const extra = env.DSH_EXTRA_MODULE_ROOTS;
  if (typeof extra === 'string' && extra.trim()) {
    for (const part of extra.split(new RegExp(`[${delimiter};]`))) add(part.trim());
  }

  return roots;
}

/**
 * 找包目录。**只返回真实存在的目录**，不做任何假设。
 * @returns {string|null}
 */
export function locatePackage(name, { env = process.env, roots = null } = {}) {
  for (const root of roots ?? moduleRoots({ env })) {
    const dir = join(root, ...name.split('/'));
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

/** 读一个包的 package.json（找不到就 null） */
export function readPackageJson(dir) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 从某个包出发，require 它自己依赖树里的模块。
 *
 * 为什么不用裸 `import(name)`：宿主包不在我们的解析链上，裸 import 必然失败；
 * 而 `createRequire(<该包的 package.json>)` 是 Node 自己的解析规则，
 * 会正确走过它的 node_modules，比手拼路径可靠。
 *
 * @returns {any|null}
 */
export function requireFrom(packageDir, name) {
  if (!packageDir) return null;
  try {
    const require = createRequire(join(packageDir, 'noop.js'));
    return require(name);
  } catch {
    return null;
  }
}

/* --------------------------------------------------------- 具体的那两个包 */

/** DSH 语音输入里的 SenseVoice 实现包 */
export const SENSEVOICE_PKG = '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice';
/** B 站刷视频插件（npm 名 dsh-bili-scroll，包内 name 是 dsh-bili-subagent） */
export const BILI_SCROLL_PKGS = ['dsh-bili-subagent', 'dsh-bili-scroll'];

/**
 * 本地语音识别能力：包在、原生运行时在、模型在，三样齐了才算可用。
 *
 * 模型路径用 DSH 自己的约定（`dshHomePath('speech-to-text','sensevoice')`），
 * 因为那份模型是**按这个约定**下载的；包只是用来确认"这台机器装过语音输入"
 * 并顺带提供 sherpa-onnx-node。
 *
 * @returns {{available:boolean, reason?:string, sherpa?:object, models?:string,
 *   model?:string, tokens?:string, vad?:string, pkgDir?:string}}
 */
export function voiceInputRuntime({ env = process.env, precision = 'int8' } = {}) {
  const pkgDir = locatePackage(SENSEVOICE_PKG, { env });
  if (!pkgDir) {
    return { available: false, reason: `未安装 ${SENSEVOICE_PKG}` };
  }

  const sherpa = requireFrom(pkgDir, 'sherpa-onnx-node');
  if (typeof sherpa?.OfflineRecognizer !== 'function' || typeof sherpa?.Vad !== 'function') {
    return { available: false, reason: 'sherpa-onnx-node 加载失败', pkgDir };
  }

  // 模型清单以包内 runtime/assets.json 为准：文件名和精度档位都从那里来，
  // 不自己拼，升版换文件名也不会错。
  let lock = null;
  try {
    lock = JSON.parse(readFileSync(join(pkgDir, 'runtime', 'assets.json'), 'utf8'));
  } catch {
    return { available: false, reason: '读不到 runtime/assets.json', pkgDir };
  }
  const entry = lock?.models?.[precision] ?? lock?.models?.int8 ?? lock?.models?.fp32;
  if (!entry?.name || !lock?.tokens?.name || !lock?.vad?.name) {
    return { available: false, reason: 'runtime/assets.json 缺条目', pkgDir };
  }

  const models = join(dshHome(env), 'speech-to-text', 'sensevoice', 'models');
  const paths = {
    model: join(models, 'sensevoice-onnx', entry.name),
    tokens: join(models, 'sensevoice-onnx', lock.tokens.name),
    vad: join(models, 'silero', lock.vad.name),
  };
  const missing = Object.entries(paths).filter(([, p]) => !existsSync(p)).map(([k]) => k);
  if (missing.length > 0) {
    return { available: false, reason: `模型文件缺失：${missing.join('/')}`, pkgDir, models };
  }

  return { available: true, sherpa, pkgDir, models, ...paths };
}

/**
 * B 站登录态来源：`dsh-bili-scroll` 落地的那份凭证。
 * 没有这个包就返回 null —— 调用方据此只能走扫码，或者干脆不提供登录功能。
 *
 * @returns {{pkgDir:string, credential:string}|null}
 */
export function biliCredentialSource({ env = process.env } = {}) {
  let pkgDir = null;
  for (const name of BILI_SCROLL_PKGS) {
    pkgDir = locatePackage(name, { env });
    if (pkgDir) break;
  }
  if (!pkgDir) return null;

  // 凭证目录由插件自己决定（它现在的实现写在家目录的 bili-duty 下）。
  // 这里按"包在 → 去常见位置找凭证"，找不到文件也算数：包在就说明登录这条路可用。
  const candidates = [
    join(dshHome(env), 'bili-duty', 'bili_credential.json'),
    join(dshHome(env), 'bili-scroll', 'bili_credential.json'),
  ];
  const credential = candidates.find((p) => existsSync(p)) ?? candidates[0];
  return { pkgDir, credential };
}
