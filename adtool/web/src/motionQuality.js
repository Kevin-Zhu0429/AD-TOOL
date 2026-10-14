import { useSyncExternalStore } from 'react';

/**
 * 首页动效的画质档位:
 * - 'full'   原样
 * - 'lite'   掉帧的电脑用:卡片切片更少、背景动效降帧
 * - 'static' 浏览器没用上显卡(软件渲染、远程桌面等),或 lite 下仍然卡成幻灯片:
 *            轮播不再自动转,卡片背景和页头云层只画一帧;拖动、点击照常
 *
 * 打开页面时先看浏览器是不是在用软件模拟显卡,是就直接 static。之后首页轮播转动时
 * 自己量帧率:每轮 60 帧或 1.5 秒,连续两轮低于 LITE_FPS 降到 lite,低于 STATIC_FPS 降到 static。
 * 结果记在本机,下次打开直接用;过 RETEST_DAYS 天重新检测。
 */
const KEY = 'adtool-motion-quality';
const LEVELS = ['full', 'lite', 'static'];
const LITE_FPS = 40;
const STATIC_FPS = 15;
const WINDOW_FRAMES = 60;
const WINDOW_MS = 1500;
const RETEST_DAYS = 7;
const SOFTWARE_GL = /swiftshader|llvmpipe|softpipe|software|basic render/i;
const listeners = new Set();

// 浏览器关了「使用图形加速」、显卡驱动被拉黑或在远程桌面里时,WebGL 由 CPU 模拟,动画会卡成幻灯片
export function usesSoftwareGraphics() {
  try {
    const gl = document.createElement('canvas').getContext('webgl', { failIfMajorPerformanceCaveat: true });
    // 只有带 failIfMajorPerformanceCaveat 时拿不到、普通方式拿得到,才说明是软件模拟;两种都拿不到是不支持 WebGL,走各组件自己的降级
    if (!gl) {
      const plain = document.createElement('canvas').getContext('webgl');
      plain?.getExtension('WEBGL_lose_context')?.loseContext();
      return Boolean(plain);
    }
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return SOFTWARE_GL.test(String(name || ''));
  } catch {
    return false;
  }
}

let pinned = false;

function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    // pinned:手动指定的档位(测试也用它),不再自动调整
    if (saved?.pinned && LEVELS.includes(saved.quality)) {
      pinned = true;
      return saved.quality;
    }
    if (LEVELS.includes(saved?.quality) && saved.quality !== 'full' && Date.now() - saved.at < RETEST_DAYS * 864e5) return saved.quality;
  } catch { /* 隐私模式等读不到本机存储时按检测结果处理 */ }
  if (usesSoftwareGraphics()) return 'static';
  return navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2 ? 'lite' : 'full';
}

let quality = initial();
let samples = [];
let windowStart = 0;
let slowWindows = 0;

export function getMotionQuality() {
  return quality;
}

function setMotionQuality(next) {
  if (next === quality) return;
  quality = next;
  samples = [];
  slowWindows = 0;
  try {
    localStorage.setItem(KEY, JSON.stringify({ quality: next, at: Date.now() }));
  } catch { /* 存不下就只在这次打开时生效 */ }
  for (const listener of listeners) listener();
}

/** 动画每画一帧报一次两帧间隔(毫秒)。切页、切标签页造成的长停顿不算。 */
export function reportFrameGap(gap, now = performance.now()) {
  if (pinned || quality === 'static' || !(gap > 0) || gap > 1000) return;
  if (!samples.length) windowStart = now;
  samples.push(gap);
  if (samples.length < WINDOW_FRAMES && now - windowStart < WINDOW_MS) return;
  if (samples.length < 4) return;
  const sorted = samples.sort((a, b) => a - b);
  const fps = 1000 / sorted[sorted.length >> 1];
  samples = [];
  const floor = quality === 'lite' ? STATIC_FPS : LITE_FPS;
  slowWindows = fps < floor ? slowWindows + 1 : 0;
  if (slowWindows < 2) return;
  // 满档时就已经低于 STATIC_FPS 的,直接跳到 static,不再多卡一轮
  setMotionQuality(quality === 'full' && fps >= STATIC_FPS ? 'lite' : 'static');
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMotionQuality() {
  return useSyncExternalStore(subscribe, getMotionQuality);
}
