#!/usr/bin/env node
/**
 * Rend hamid.html en MP4 (image + son synthétisé).
 *
 * On ne filme pas en temps réel : la page serait capturée au rythme réel de
 * la machine, donc saccadée. À la place, le temps de la page est remplacé par
 * une horloge virtuelle qui avance d'exactement 1/FPS par image, ce qui donne
 * un rendu fluide même sur une machine lente — et reproductible, car
 * Math.random est graine.
 *
 * Le son est synthétisé par la page elle-même. On journalise chaque appel
 * sonore avec son instant virtuel, puis on le rejoue dans un
 * OfflineAudioContext d'une page propre : sous le harness, startRendering()
 * ne se résout jamais, les timers étant détournés.
 *
 * Usage : node tools/capture-mp4.js [--seconds 10] [--fps 60]
 *                                   [--width 1280] [--height 720]
 *                                   [--seed 20261020] [--out hamid-le-zgg.mp4]
 * Requiert : playwright, ffmpeg.
 */
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d;
};
const FPS     = +arg('fps', 60);
const SECONDS = +arg('seconds', 10);
const W       = +arg('width', 1280);
const H       = +arg('height', 720);
const SEED    = +arg('seed', 20261020);
const OUT     = path.resolve(arg('out', 'hamid-le-zgg.mp4'));
const PAGE    = 'file://' + path.resolve(__dirname, '..', 'hamid.html');
const N       = Math.round(FPS * SECONDS);

const harness = `(() => {
  const STEP = 1000 / ${FPS};
  let V = 0;
  let s = ${SEED} >>> 0;
  Math.random = () => {                       // PRNG graine : run reproductible
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  performance.now = () => V;
  Date.now = () => 1700000000000 + V;

  let seq = 1; const timers = new Map();
  window.setTimeout  = (fn, d = 0, ...a) => { const id = seq++; timers.set(id, {t: V + Math.max(0, d|0), fn, args: a, iv: null}); return id; };
  window.setInterval = (fn, d = 0, ...a) => { const id = seq++; const p = Math.max(1, d|0); timers.set(id, {t: V + p, fn, args: a, iv: p}); return id; };
  window.clearTimeout = id => timers.delete(id);
  window.clearInterval = id => timers.delete(id);

  let rafSeq = 1, rafQ = new Map();
  window.requestAnimationFrame = fn => { const id = rafSeq++; rafQ.set(id, fn); return id; };
  window.cancelAnimationFrame = id => rafQ.delete(id);

  const known = new Map();                    // WAAPI + CSS pilotées à la main
  function sync(){
    for (const a of document.getAnimations()){
      if (!known.has(a)){ known.set(a, V); try { a.pause(); } catch(_){} }
      try { a.currentTime = V - known.get(a); } catch(_){}
    }
  }
  window.__frame = () => {
    V += STEP;
    for (let g = 0; g < 20000; g++){
      let best = null, bestId = -1;
      for (const [id, t] of timers) if (t.t <= V && (best === null || t.t < best.t)) { best = t; bestId = id; }
      if (!best) break;
      if (best.iv === null) timers.delete(bestId); else best.t += best.iv;
      try { best.fn(...best.args); } catch(e){ console.error(e); }
    }
    sync();
    const q = rafQ; rafQ = new Map();
    for (const fn of q.values()){ try { fn(V); } catch(e){ console.error(e); } }
    sync();
  };
  window.__V = () => V;
})();`;

const hookSfx = () => {
  window.__sfx = [];
  for (const k of ['boom','crash','riser','glitch','tick','chord','shimmer']){
    const o = Audio_.prototype[k];
    Audio_.prototype[k] = function(...a){ window.__sfx.push([k, a, window.__V()]); return o.apply(this, a); };
  }
  document.querySelector('#start').click();
};

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hamid-'));
  const frames = path.join(tmp, 'frames');
  fs.mkdirSync(frames);
  const browser = await chromium.launch({
    args: ['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  try {
    // ── 1. images, sur horloge virtuelle ───────────────────────────────
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.addInitScript({ content: harness });
    await page.goto(PAGE);
    await page.waitForLoadState('load');
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: '#replay,#nosound{display:none!important}' });
    await page.evaluate(hookSfx);

    const t0 = Date.now();
    for (let i = 0; i < N; i++){
      await page.evaluate(() => window.__frame());
      await page.screenshot({ path: path.join(frames, `f${String(i).padStart(5,'0')}.jpg`), type: 'jpeg', quality: 92 });
      if (i % 60 === 59) process.stdout.write(`\r  images ${i+1}/${N}`);
    }
    const sfx = await page.evaluate(() => window.__sfx);
    console.log(`\r  images ${N}/${N} en ${((Date.now()-t0)/1000).toFixed(0)}s, ${sfx.length} sons`);
    if (errors.length) console.warn('  erreurs page :', errors);
    await page.close();

    // ── 2. bande-son, page propre (OfflineAudioContext) ────────────────
    const clean = await browser.newPage();
    await clean.goto(PAGE);
    await clean.waitForLoadState('load');
    const res = await clean.evaluate(async ({ log, secs }) => {
      const SR = 44100;
      const off = new OfflineAudioContext(2, Math.ceil(secs * SR), SR);
      const saved = window.AudioContext;
      window.AudioContext = function(){ return off; };
      const inst = new Audio_();
      window.AudioContext = saved;
      for (const [k, args, v] of log){
        const a = args.slice();
        a[0] = (a[0] || 0) + v / 1000;              // instant virtuel -> absolu
        try { inst[k](...a); } catch(_){}
      }
      const buf = await off.startRendering();
      const len = buf.length, ch = buf.numberOfChannels;
      const cd = []; for (let c = 0; c < ch; c++) cd.push(buf.getChannelData(c));
      let peak = 0;                                 // normalisation : les
      for (let c = 0; c < ch; c++){ const d = cd[c];// impacts dépassent 1.0 et
        for (let i = 0; i < len; i++){              // écrêteraient sinon
          const v = d[i] < 0 ? -d[i] : d[i]; if (v > peak) peak = v; } }
      const gain = peak > 0 ? 0.891 / peak : 1;
      const ab = new ArrayBuffer(44 + len*ch*2), dv = new DataView(ab);
      const wr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o+i, s.charCodeAt(i)); };
      wr(0,'RIFF'); dv.setUint32(4, 36+len*ch*2, true); wr(8,'WAVEfmt ');
      dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,ch,true);
      dv.setUint32(24,SR,true); dv.setUint32(28,SR*ch*2,true); dv.setUint16(32,ch*2,true);
      dv.setUint16(34,16,true); wr(36,'data'); dv.setUint32(40, len*ch*2, true);
      let o = 44;
      for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++){
        let s = cd[c][i] * gain;
        dv.setInt16(o, (s < -1 ? -1 : s > 1 ? 1 : s) * 32767, true); o += 2;
      }
      const u8 = new Uint8Array(ab); let bin = '';
      for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i+8192));
      return { b64: btoa(bin), peak: +peak.toFixed(3) };
    }, { log: sfx, secs: SECONDS + 1 });
    const wav = path.join(tmp, 'audio.wav');
    fs.writeFileSync(wav, Buffer.from(res.b64, 'base64'));
    console.log(`  bande-son rendue (crete avant normalisation : ${res.peak})`);

    // ── 3. muxage ──────────────────────────────────────────────────────
    execFileSync('ffmpeg', ['-y', '-v', 'error',
      '-framerate', String(FPS), '-i', path.join(frames, 'f%05d.jpg'),
      '-i', wav,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high',
      '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart',
      OUT], { stdio: 'inherit' });
    console.log(`  -> ${OUT} (${(fs.statSync(OUT).size/1e6).toFixed(1)} Mo)`);
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
