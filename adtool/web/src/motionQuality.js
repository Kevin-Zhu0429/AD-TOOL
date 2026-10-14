import { useSyncExternalStore } from 'react';

/**
 * 首页动效的画质档位:'full' 原样,'lite' 给掉帧的电脑用(卡片切片更少、背景动效降帧)。
 *
 * 首页轮播转动时会自己量帧率,连续两轮都低于 LITE_FPS 就切到 lite,并记在本机,
 * 下次打开首页直接从 lite 开始,不用再卡一遍;过 RETEST_DAYS 天重新量一次。
 */
const KEY = 'adtool-motion-quality';
const LITE_FPS = 40;
const WINDOW = 60;
const RETEST_DAYS = 7;
const listeners = new Set();

function initial() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved?.quality === 'lite' && Date.now() - saved.at < RETEST_DAYS * 864e5) return 'lite';
  } catch { /* 隐私模式等读不到本机存储时按 full 处理 */ }
  return navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 2 ? 'lite' : 'full';
}

let quality = initial();
let samples = [];
let slowWindows = 0;

export function getMotionQuality() {
  return quality;
}

function setMotionQuality(next) {
  if (next === quality) return;
  quality = next;
  try {
    localStorage.setItem(KEY, JSON.stringify({ quality: next, at: Date.now() }));
  } catch { /* 存不下就只在这次打开时生效 */ }
  for (const listener of listeners) listener();
}

/** 动画每画一帧报一次两帧间隔(毫秒)。切页、切标签页造成的长停顿不算。 */
export function reportFrameGap(gap) {
  if (quality === 'lite' || !(gap > 0) || gap > 1000) return;
  samples.push(gap);
  if (samples.length < WINDOW) return;
  const sorted = samples.sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  samples = [];
  slowWindows = median > 1000 / LITE_FPS ? slowWindows + 1 : 0;
  if (slowWindows >= 2) setMotionQuality('lite');
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMotionQuality() {
  return useSyncExternalStore(subscribe, getMotionQuality);
}
