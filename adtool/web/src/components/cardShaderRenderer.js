import { CARD_VERTEX, GRAINY_FRAGMENT, AURORA_FRAGMENT, WAVES_FRAGMENT } from './cardShaderSources.js';

// One WebGL2 context and clock. Render each original shader once and copy its
// matching strips to the curved cards, without one shader per DOM segment.
let renderer;
let generation = 0;
const FRAGMENTS = { gradient: GRAINY_FRAGMENT, aurora: AURORA_FRAGMENT, waves: WAVES_FRAGMENT };

const mixColor = (a, b, amount) => a.map((value, index) => value * (1 - amount) + b[index] * amount);
function themeRgb(value) {
  const hex = value.trim().replace('#', '');
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source.trim()); gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const error = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader); throw new Error(error || '无法编译卡片背景');
  }
  return shader;
}

function createProgram(gl, fragment) {
  const vertex = compile(gl, gl.VERTEX_SHADER, CARD_VERTEX);
  let pixel, program;
  try {
    pixel = compile(gl, gl.FRAGMENT_SHADER, fragment); program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, pixel);
    gl.bindAttribLocation(program, 0, 'aPosition'); gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
      const info = gl.getActiveUniform(program, i);
      uniforms[info.name.replace('[0]', '')] = gl.getUniformLocation(program, info.name);
    }
    return { program, uniforms };
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertex); if (pixel) gl.deleteShader(pixel);
  }
}

function toOklch(rgb) {
  const [r, g, b] = rgb.map((c) => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  const l = Math.cbrt(.4122214708 * r + .5363325363 * g + .0514459929 * b);
  const m = Math.cbrt(.2119034982 * r + .6806995451 * g + .1073969566 * b);
  const s = Math.cbrt(.0883024619 * r + .2817188376 * g + .6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + .4505937099 * s;
  const bb = .0259040371 * l + .7827717662 * m - .808675766 * s;
  return [.2104542553 * l + .793617785 * m - .0040720468 * s, Math.hypot(a, bb), Math.atan2(bb, a)];
}
const auroraStops = [[82 / 255, 39 / 255, 1], [124 / 255, 1, 103 / 255], [82 / 255, 39 / 255, 1]].map(toOklch);
for (let i = 1; i < auroraStops.length; i++) {
  while (auroraStops[i][2] - auroraStops[i - 1][2] > Math.PI) auroraStops[i][2] -= Math.PI * 2;
  while (auroraStops[i][2] - auroraStops[i - 1][2] < -Math.PI) auroraStops[i][2] += Math.PI * 2;
}

function createRenderer() {
  const source = document.createElement('canvas');
  const gl = source.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  const subscribers = new Set(), groups = new Map(), programs = new Map(), caches = new Map();
  const id = String(++generation);
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let raf = 0, previous = 0, time = 3.5, dirty = true, failed = !gl, errorMessage = '';
  let width = 0, height = 0, buffer;
  let lightPalette;
  if (gl) {
    try {
      for (const [effect, fragment] of Object.entries(FRAGMENTS)) programs.set(effect, createProgram(gl, fragment));
      buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.clearColor(0, 0, 0, 0);
    } catch (error) { failed = true; errorMessage = error.message; }
  }

  function sizeSlice(sub) {
    const { axis, offset, size, cardWidth, cardHeight } = sub.slice;
    sub.canvas.width = axis === 'x' ? width : Math.max(1, Math.ceil(width * size / cardWidth));
    sub.canvas.height = axis === 'x' ? Math.max(1, Math.ceil(height * size / cardHeight)) : height;
    sub.crop = axis === 'x' ? [0, height * offset / cardHeight, width, height * size / cardHeight]
      : [width * offset / cardWidth, 0, width * size / cardWidth, height];
  }
  function resize() {
    const nextWidth = window.innerWidth < 600 ? 144 : 256;
    if (nextWidth === width) return;
    width = nextWidth; height = Math.round(width / .88);
    source.width = width; source.height = height;
    for (const cache of caches.values()) { cache.canvas.width = width; cache.canvas.height = height; }
    for (const sub of subscribers) sizeSlice(sub);
    dirty = true;
  }
  function active(group) {
    return !document.hidden && !reduced.matches && !group.root.hasAttribute('data-motion-hidden')
      && !group.showcase.hasAttribute('data-effects-paused') && group.card.dataset.motionSide !== 'rear';
  }
  function paint(effect) {
    const { program, uniforms: u } = programs.get(effect);
    gl.useProgram(program); gl.viewport(0, 0, width, height); gl.clear(gl.COLOR_BUFFER_BIT);
    const f = (name, value) => { if (u[name] !== undefined) gl.uniform1f(u[name], value); };
    const n = (name, value) => { if (u[name] !== undefined) gl.uniform1i(u[name], value); };
    const v2 = (name, x, y) => { if (u[name] !== undefined) gl.uniform2f(u[name], x, y); };
    const v3 = (name, x, y, z) => { if (u[name] !== undefined) gl.uniform3f(u[name], x, y, z); };
    const light = document.documentElement.dataset.theme === 'light';
    if (effect === 'gradient') {
      f('iTime', time); v3('iResolution', width, height, 1);
      for (const [name, value] of Object.entries({ noiseIntensity: 1.55, noiseScale: 2, noiseSpeed: .15,
        waveNoiseIntensity: 1.2, waveNoiseScale1: .5, waveNoiseScale2: .8, waveNoiseScale3: 1.2,
        waveNoiseSpeed1: .24, waveNoiseSpeed2: .2, waveNoiseSpeed3: .3 })) f(name, value);
      n('rippleCount', 0);
    } else if (effect === 'aurora') {
      v2('uResolution', width, height); f('uTime', time * .65);
      gl.uniform3fv(u.uStops, new Float32Array(auroraStops.flat())); n('uStopCount', 3);
      for (const [name, value] of Object.entries({ uAmplitude: 1, uBlend: .5, uHeight: .62, uScale: 1,
        uGlow: .6, uBrightness: 1, uFlip: 0, uReveal: 1, uOpacity: 1, uLightMode: 0 })) f(name, value);
      n('uLayers', 2); v3('uPointer', 0, 0, 0);
    } else {
      v2('iResolution', width, height); f('iTime', time);
      for (const [name, value] of Object.entries({ uSpeed: .4, uAmplitude: 2.5, uWaveScale: .6, uWaveRatio: .9,
        uSwell: 35, uTurbulence: 20, uTilt: 1.11, uZoom: 1, uHeight: 5.5, uFogDepth: 15,
        uSteps: width < 200 ? 40 : 70, uBrightness: 1, uOpacity: light ? 2.6 : 1, uGrain: 1, uGrainIntensity: .05, uParallax: 0 })) f(name, value);
      n('uEnableMouse', 0); v2('uMouse', .5, .5);
      if (light) {
        if (!lightPalette) {
          const tokens = getComputedStyle(document.documentElement);
          const violet = themeRgb(tokens.getPropertyValue('--violet'));
          const accent = themeRgb(tokens.getPropertyValue('--accent'));
          lightPalette = { horizon: mixColor(violet, accent, .4), wave: violet, crest: mixColor(violet, [1, 1, 1], .48) };
        }
        v3('uHorizonColor', ...lightPalette.horizon); v3('uWaveColor', ...lightPalette.wave); v3('uCrestColor', ...lightPalette.crest);
      } else {
        v3('uHorizonColor', 82 / 255, 39 / 255, 1); v3('uWaveColor', 1, 159 / 255, 252 / 255); v3('uCrestColor', 1, 1, 1);
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    let cache = caches.get(effect);
    if (!cache) {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      cache = { canvas, context: canvas.getContext('2d'), frame: 0 }; caches.set(effect, cache);
    }
    cache.context.clearRect(0, 0, width, height); cache.context.drawImage(source, 0, 0); cache.frame++;
    return cache;
  }
  function copy(sub, cache) {
    sub.context.clearRect(0, 0, sub.canvas.width, sub.canvas.height);
    sub.context.drawImage(cache.canvas, ...sub.crop, 0, 0, sub.canvas.width, sub.canvas.height);
    sub.canvas.dataset.shaderFrame = String(cache.frame); sub.canvas.dataset.renderer = 'webgl2';
  }
  function fail(message) {
    failed = true; errorMessage = message;
    for (const sub of subscribers) { sub.canvas.dataset.renderer = 'fallback'; sub.canvas.dataset.shaderError = message; }
    cancelAnimationFrame(raf); raf = 0;
  }
  function frame(now) {
    raf = 0;
    if (failed || document.hidden) { previous = 0; return; }
    const moving = [...groups.values()].some(active);
    const interval = width < 200 ? 50 : 1000 / 24;
    if (!dirty && previous && now - previous < interval) { if (moving) raf = requestAnimationFrame(frame); return; }
    if (moving && previous) time += Math.min((now - previous) / 1000, .12);
    previous = moving ? now : 0;
    try {
      const effects = new Set([...groups.values()].filter((group) => dirty || active(group)).map((group) => group.effect));
      for (const effect of effects) {
        const cache = paint(effect);
        for (const sub of subscribers) if (sub.effect === effect && (dirty || active(sub.group))) copy(sub, cache);
      }
      dirty = false;
    } catch (error) { fail(error.message); return; }
    if (moving) raf = requestAnimationFrame(frame);
  }
  function wake(force = false) {
    dirty ||= force;
    if (!failed && !document.hidden && !raf) raf = requestAnimationFrame(frame);
    if (document.hidden) { cancelAnimationFrame(raf); raf = 0; previous = 0; }
  }
  const observer = new MutationObserver((records) => {
    const themeChanged = records.some((record) => record.attributeName === 'data-theme');
    if (themeChanged) lightPalette = undefined;
    wake(themeChanged);
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onResize = () => { resize(); wake(true); };
  const onVisibility = () => wake();
  const onPreference = () => wake(true);
  const onLost = (event) => { event.preventDefault(); fail('显卡上下文不可用'); };
  window.addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVisibility);
  reduced.addEventListener('change', onPreference); source.addEventListener('webglcontextlost', onLost);
  resize();
  return {
    subscribe(canvas, effect, slice) {
      const card = canvas.closest('.circular-carousel__card'), root = canvas.closest('.circular-carousel'), showcase = canvas.closest('.home-showcase');
      let group = groups.get(card);
      if (!group) {
        group = { card, root, showcase, effect, count: 0 }; groups.set(card, group);
        observer.observe(card, { attributes: true, attributeFilter: ['data-motion-side'] });
        observer.observe(root, { attributes: true, attributeFilter: ['data-motion-hidden'] });
        observer.observe(showcase, { attributes: true, attributeFilter: ['data-effects-paused'] });
      }
      group.count++;
      const sub = { canvas, context: canvas.getContext('2d'), effect, slice, group };
      subscribers.add(sub); sizeSlice(sub); canvas.dataset.shaderContext = id;
      canvas.dataset.renderer = failed ? 'fallback' : 'webgl2';
      if (failed) canvas.dataset.shaderError = errorMessage || '浏览器不支持 WebGL2';
      if (caches.has(effect) && !failed) copy(sub, caches.get(effect));
      wake(true);
      return () => {
        subscribers.delete(sub); if (!--group.count) groups.delete(card);
        if (!subscribers.size) {
          cancelAnimationFrame(raf); observer.disconnect();
          window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisibility);
          reduced.removeEventListener('change', onPreference); source.removeEventListener('webglcontextlost', onLost);
          if (gl) {
            for (const item of programs.values()) gl.deleteProgram(item.program);
            if (buffer) gl.deleteBuffer(buffer);
            gl.getExtension('WEBGL_lose_context')?.loseContext();
          }
          caches.clear(); renderer = undefined;
        }
      };
    },
  };
}
export function subscribeCardShader(canvas, effect, slice) {
  renderer ||= createRenderer();
  return renderer.subscribe(canvas, effect, slice);
}
