/**
 * 舒呼(SootheBreath) v9.1 ES6 Module — interactive3d.js
 * 3D 互動模式（微風風車 Pinwheel & 蒲公英 Dandelion）P0–P2 高效能優化與 Three.js 資源生命週期管理模組
 *
 * v9.1 核心效能優化 (P0 – P2 Performance Optimizations):
 * - [P0-1] 單一主迴圈整合 (Unified rAF Loop)：匯出 renderInteractive3DFrame() 由 trainingInferenceLoop 統一驅動，消除雙重 requestAnimationFrame 搶佔 Main Thread 與 WebGL Context。
 * - [P0-2] 蒲公英零動態記憶體配置物件池 (Zero-Allocation In-Place Seed Pool & Reduced Draw Calls)：
 *          - 廢除吹氣時每幀 new THREE.Group/Mesh/Sprite 之 spawnFlyingSeed()，改為全數種子原位轉換飛行狀態 (In-Place Flight State)，吸氣時原位平滑重生，實現 0 GC 停頓。
 *          - 精簡種子數量至 128 粒並合併為單一高飽滿度絨毛 Sprite，減少 >72% Draw Calls 與 Scene Graph 節點。
 * - [P1-1] 預烘焙淺景深背景 (Pre-baked DOF Canvas)：於初始化時一次性以低解析度平滑漸層烘焙淺景深草地，徹底移除實時 CSS filter: blur(22px) 與 backdrop-filter。
 * - [P2-1] 風車網格與材質輕量化：葉片網格細分由 48×44 降至 24×22（減少 75% 頂點），以 MeshStandardMaterial 取代昂貴之 MeshPhysicalMaterial (Clearcoat)，並限制 pixelRatio <= 1.25 及啟用 high-performance GPU 模式。
 * - [P2-2] Web Audio 節點自動釋放與節流：為風聲碎片音效加入 90ms Cooldown 節流，並於所有短命音源綁定 onended 自動 disconnect()，防止 Audio Graph 節點堆積。
 */

import { AppState } from './state.js';

export const INTERACTIVE_MODES = {
  PINWHEEL: 'PINWHEEL',
  DANDELION: 'DANDELION'
};

export const INTERACTIVE_STATES = {
  IDLE: 'IDLE',
  ACTIVE_HOLD: 'ACTIVE_HOLD',
  RELEASE_RECOVERY: 'RELEASE_RECOVERY'
};

// ---------------------------------------------------------------------------
// 內部模組狀態與資源追蹤 (Internal Lifecycle & Resource Tracking)
// ---------------------------------------------------------------------------
let isInitialized = false;
let disposedCount = 0;
let animFrameId = null;
let resizeListener = null;

let audioEngine = null;
let scene = null;
let camera = null;
let renderer = null;
let clock = null;

let windmillRoot = null;
let rotorGroup = null;
let dandelionRoot = null;
let dandelionHead = null;
let pGeo = null;

let headSeeds = [];
let pSpeeds = [];
let trackedGeometries = [];
let trackedMaterials = [];
let trackedTextures = [];

let activeMode = INTERACTIVE_MODES.PINWHEEL;
let currentState = INTERACTIVE_STATES.IDLE;
let isButtonHeld = false;

const TARGET_SPIN_SPEED = 3.4;
const FULL_DECEL_DURATION = 7.0;
export const TOTAL_SEEDS = 128; // P0-2: 由 260 精簡至 128 粒高飽滿度種子，大幅降低 Draw Calls
const PARTICLE_COUNT = 32;      // 精簡背景微粒數量
const DANDELION_DISPERSE_DURATION = 4.0;
const DANDELION_REFILL_DURATION = 1.0;

let angularVelocity = 0;
let accumulatedSpinAngle = 0;
let decelElapsed = 0;
let decelTotalTime = FULL_DECEL_DURATION;
let releaseVelocity = 0;
let idleBlendWeight = 1.0;

let disperseElapsed = 0.0;
let refillSpeedRate = 4.0;
let lastSpeedMeterText = '';

// Shared seed creation references within active session
let acheneGeoRef = null;
let acheneMatsRef = [];
let uniformSeedLinesGeoRef = null;
let seedLinesMatRef = null;
let pappusSpriteMatRef = null;
const STALK_LEN = 1.84;

function trackGeo(geo) {
  if (geo && !trackedGeometries.includes(geo)) trackedGeometries.push(geo);
  return geo;
}

function trackMat(mat) {
  if (mat && !trackedMaterials.includes(mat)) trackedMaterials.push(mat);
  return mat;
}

function trackTex(tex) {
  if (tex && !trackedTextures.includes(tex)) trackedTextures.push(tex);
  return tex;
}

// ============================================================================
// 0. 預烘焙淺景深草地背景 (P1-1: Pre-baked Low-Res Soft Grassland — Zero CSS Blur)
// ============================================================================
function renderGrasslandDOFBackground() {
  const c = document.getElementById('bg-dof-canvas');
  if (!c) return;
  // 使用低解析度 (160x120) 搭配柔和漸層直接烘焙淺景深效果，避免瀏覽器每幀執行 CSS filter: blur(22px)
  c.width = 160;
  c.height = 120;
  const ctx = c.getContext('2d');
  if (!ctx) return;

  const baseGrad = ctx.createLinearGradient(0, 0, 160, 120);
  baseGrad.addColorStop(0, '#3a5610');
  baseGrad.addColorStop(0.45, '#2b4409');
  baseGrad.addColorStop(1, '#1d3203');
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, 160, 120);

  const patches = [
    { x: 24,  y: 30, r: 48, col: 'rgba(98, 138, 28, 0.58)' },
    { x: 130, y: 28, r: 52, col: 'rgba(32, 54, 6, 0.72)' },
    { x: 70,  y: 20, r: 42, col: 'rgba(72, 108, 18, 0.50)' },
    { x: 35,  y: 95, r: 55, col: 'rgba(42, 68, 9, 0.68)' },
    { x: 120, y: 90, r: 58, col: 'rgba(86, 126, 22, 0.52)' },
    { x: 15,  y: 65, r: 40, col: 'rgba(118, 158, 36, 0.45)' }
  ];
  patches.forEach((p) => {
    const rg = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, p.r);
    rg.addColorStop(0, p.col);
    rg.addColorStop(0.55, p.col.replace(/[\d.]+\)$/, '0.22)'));
    rg.addColorStop(1, 'rgba(36, 60, 8, 0)');
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ============================================================================
// 1. WEB AUDIO 合成引擎 (P2-2: 含 90ms 音效節流與 onended 自動 disconnect)
// ============================================================================
class PinwheelAudioEngine {
  constructor() {
    this.ctx = null;
    this.isMuted = false;
    this.isStarted = false;
    this.masterGain = null;
    this.musicGain = null;
    this.windGain = null;
    this.windFilter = null;
    this.airFilter = null;
    this.loopTimer = null;
    this.noteIndex = 0;
    this.bladePhaseAccum = 0;
    this.lastFlutterTime = 0;
    this.activeOscillators = [];
    this.noiseSource = null;

    this.melodyPattern = [
      { f: 261.63, bass: 130.81, dur: 1.4, vel: 0.22 },
      { f: 392.00, bass: null,   dur: 1.2, vel: 0.18 },
      { f: 659.25, bass: null,   dur: 1.5, vel: 0.20 },
      { f: 523.25, bass: null,   dur: 1.2, vel: 0.17 },
      { f: 587.33, bass: 196.00, dur: 1.4, vel: 0.19 },
      { f: 659.25, bass: null,   dur: 1.3, vel: 0.21 },
      { f: 783.99, bass: null,   dur: 1.6, vel: 0.16 },
      { f: 587.33, bass: null,   dur: 1.4, vel: 0.18 },
      { f: 523.25, bass: 130.81, dur: 1.4, vel: 0.21 },
      { f: 329.63, bass: null,   dur: 1.2, vel: 0.17 },
      { f: 392.00, bass: null,   dur: 1.2, vel: 0.18 },
      { f: 523.25, bass: null,   dur: 1.3, vel: 0.19 },
      { f: 587.33, bass: 146.83, dur: 1.4, vel: 0.20 },
      { f: 659.25, bass: null,   dur: 1.4, vel: 0.21 },
      { f: 783.99, bass: null,   dur: 1.5, vel: 0.17 },
      { f: 659.25, bass: null,   dur: 1.4, vel: 0.18 },
      { f: 392.00, bass: 196.00, dur: 1.4, vel: 0.20 },
      { f: 523.25, bass: null,   dur: 1.2, vel: 0.18 },
      { f: 587.33, bass: null,   dur: 1.5, vel: 0.21 },
      { f: 293.66, bass: null,   dur: 1.2, vel: 0.16 },
      { f: 392.00, bass: 146.83, dur: 1.3, vel: 0.19 },
      { f: 493.88, bass: null,   dur: 1.3, vel: 0.18 },
      { f: 587.33, bass: null,   dur: 1.6, vel: 0.20 },
      { f: 392.00, bass: null,   dur: 1.5, vel: 0.16 }
    ];
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    try {
      this.ctx = new AudioCtx();
    } catch (e) {
      return;
    }

    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.isMuted ? 0 : 0.85;
    this.masterGain.connect(this.ctx.destination);

    this.reverbBus = this.ctx.createGain();
    this.reverbBus.gain.value = 0.32;
    const delay1 = this.ctx.createDelay(1.0);
    delay1.delayTime.value = 0.25;
    const fb1 = this.ctx.createGain();
    fb1.gain.value = 0.30;
    const dampFilter = this.ctx.createBiquadFilter();
    dampFilter.type = 'lowpass';
    dampFilter.frequency.value = 1800;

    this.reverbBus.connect(delay1);
    delay1.connect(dampFilter);
    dampFilter.connect(fb1);
    fb1.connect(delay1);
    dampFilter.connect(this.masterGain);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.55;
    this.musicGain.connect(this.masterGain);
    this.musicGain.connect(this.reverbBus);

    this.startWarmPad();
    this.setupWindSound();

    this.isStarted = true;
    this.scheduleNextNote();
  }

  startWarmPad() {
    if (!this.ctx) return;
    const padGain = this.ctx.createGain();
    padGain.gain.value = 0.035;
    padGain.connect(this.musicGain);

    [130.81, 196.00, 261.63].forEach((freq, idx) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = (idx - 1) * 3;
      osc.connect(padGain);
      osc.start();
      this.activeOscillators.push(osc);
    });
  }

  playPianoNote(freq, duration, velocity) {
    if (!this.ctx || this.isMuted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;

    const noteGain = this.ctx.createGain();
    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.linearRampToValueAtTime(velocity, now + 0.028);
    noteGain.gain.exponentialRampToValueAtTime(velocity * 0.45, now + 0.25);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(freq * 3.0, now);
    filter.frequency.exponentialRampToValueAtTime(freq * 1.2, now + duration * 0.8);

    const osc1 = this.ctx.createOscillator();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(freq, now);

    const osc2 = this.ctx.createOscillator();
    osc2.type = 'triangle';
    osc2.frequency.setValueAtTime(freq, now);
    const osc2Gain = this.ctx.createGain();
    osc2Gain.gain.value = 0.20;

    osc1.connect(filter);
    osc2.connect(osc2Gain);
    osc2Gain.connect(filter);

    filter.connect(noteGain);
    noteGain.connect(this.musicGain);

    // P2-2: 播放完畢自動 disconnect 釋放音訊節點，防止 Audio Graph 堆積
    osc1.onended = () => {
      try {
        osc1.disconnect();
        osc2.disconnect();
        osc2Gain.disconnect();
        filter.disconnect();
        noteGain.disconnect();
      } catch (e) {}
    };

    osc1.start(now);
    osc2.start(now);
    osc1.stop(now + duration + 0.05);
    osc2.stop(now + duration + 0.05);
  }

  scheduleNextNote() {
    if (!this.isStarted) return;
    const step = this.melodyPattern[this.noteIndex];
    this.noteIndex = (this.noteIndex + 1) % this.melodyPattern.length;

    if (this.ctx && this.ctx.state === 'running') {
      this.playPianoNote(step.f, step.dur, step.vel);
      if (step.bass) {
        this.playPianoNote(step.bass, step.dur * 1.8, step.vel * 0.65);
      }
    }

    const intervalMs = 320 + Math.sin(this.noteIndex * 0.7) * 18;
    this.loopTimer = setTimeout(() => this.scheduleNextNote(), intervalMs);
  }

  setupWindSound() {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * 2;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufferSize; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99 * b0 + white * 0.08;
      b1 = 0.96 * b1 + white * 0.15;
      b2 = 0.85 * b2 + white * 0.30;
      data[i] = (b0 + b1 + b2 + white * 0.25) * 0.04;
    }

    this.noiseBuffer = buffer;
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;

    this.windFilter = this.ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 260;
    this.windFilter.Q.value = 1.6;

    this.airFilter = this.ctx.createBiquadFilter();
    this.airFilter.type = 'lowpass';
    this.airFilter.frequency.value = 650;

    this.windGain = this.ctx.createGain();
    this.windGain.gain.value = 0.0;

    noiseSource.connect(this.windFilter);
    this.windFilter.connect(this.airFilter);
    this.airFilter.connect(this.windGain);
    this.windGain.connect(this.masterGain);
    noiseSource.start();
    this.noiseSource = noiseSource;
  }

  triggerBladeFlutter(speedRatio) {
    if (!this.ctx || this.ctx.state !== 'running' || this.isMuted || !this.noiseBuffer) return;
    if (speedRatio < 0.04) return;

    // P2-2: 限制最少間隔 90ms 先觸發一次碎片音效，避免蒲公英吹散時瞬間建立過多音源
    const nowPerf = performance.now();
    if (nowPerf - this.lastFlutterTime < 90) return;
    this.lastFlutterTime = nowPerf;

    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const flt = this.ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.setValueAtTime(380 + speedRatio * 520, now);
    flt.Q.setValueAtTime(2.2, now);

    const g = this.ctx.createGain();
    const peak = Math.min(0.16, Math.pow(speedRatio, 1.25) * 0.13);
    const dur = Math.max(0.035, 0.095 - speedRatio * 0.045);

    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(peak, now + dur * 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(flt);
    flt.connect(g);
    g.connect(this.masterGain);

    src.onended = () => {
      try {
        src.disconnect();
        flt.disconnect();
        g.disconnect();
      } catch (e) {}
    };

    const randomOffset = Math.random() * 1.5;
    src.start(now, randomOffset, dur + 0.02);
  }

  updateSpinSound(angularVel, maxVelocity, isHolding, dt, isDandelion = false) {
    if (!this.ctx || !this.windGain || this.ctx.state !== 'running') return;
    const speedRatio = Math.min(1, Math.max(0, angularVel / maxVelocity));

    const targetGain = isHolding
      ? (isDandelion ? 0.28 * speedRatio : 0.24 + speedRatio * 0.28)
      : Math.pow(speedRatio, 1.35) * 0.32;
    const now = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(targetGain, now, 0.06);
    this.windFilter.frequency.setTargetAtTime(
      isDandelion ? (260 + 320 * speedRatio) : (220 + speedRatio * 420 + (isHolding ? 90 : 0)),
      now,
      0.08
    );
    this.airFilter.frequency.setTargetAtTime(480 + speedRatio * 900, now, 0.08);

    if (!isDandelion) {
      this.bladePhaseAccum += angularVel * dt;
      const bladeStep = Math.PI / 4;
      if (this.bladePhaseAccum >= bladeStep) {
        this.bladePhaseAccum %= bladeStep;
        this.triggerBladeFlutter(speedRatio);
      }
    }
  }

  toggleMute() {
    if (!this.ctx) {
      this.init();
      this.isMuted = false;
    } else {
      this.isMuted = !this.isMuted;
      if (this.ctx.state === 'suspended' && !this.isMuted) {
        this.ctx.resume().catch(() => {});
      }
    }
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(this.isMuted ? 0 : 0.85, this.ctx.currentTime, 0.05);
    }
    return !this.isMuted;
  }

  dispose() {
    this.isStarted = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    this.activeOscillators.forEach(osc => {
      try { osc.stop(); osc.disconnect(); } catch (e) {}
    });
    this.activeOscillators = [];
    if (this.noiseSource) {
      try { this.noiseSource.stop(); this.noiseSource.disconnect(); } catch (e) {}
      this.noiseSource = null;
    }
    if (this.ctx) {
      try { this.ctx.close(); } catch (e) {}
      this.ctx = null;
    }
    this.noiseBuffer = null;
    this.masterGain = null;
    this.musicGain = null;
    this.windGain = null;
    this.windFilter = null;
    this.airFilter = null;
  }
}

// ============================================================================
// 2. 輕量化幾何與材質生成輔助函式 (P2-1: Reduced Subdivision & Standard Materials)
// ============================================================================
function createWoodTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#9c6838');
    grad.addColorStop(0.35, '#bd8958');
    grad.addColorStop(0.7, '#a37042');
    grad.addColorStop(1, '#82542b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 256);

    ctx.strokeStyle = 'rgba(85, 48, 18, 0.22)';
    ctx.lineWidth = 1.0;
    for (let i = 0; i < 24; i++) {
      const x = Math.random() * 64;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + (Math.random() - 0.5) * 4, 85, x + (Math.random() - 0.5) * 4, 170, x, 256);
      ctx.stroke();
    }
  }
  const tex = trackTex(new THREE.CanvasTexture(c));
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

/**
 * P2-1: 風車葉片網格細分由 48×44 優化為 24×22 (cone 14×22)，減少 75% 頂點運算量，同時保持平滑弧度
 */
function createPhotoMatchedPinwheelGeometries(THREE) {
  const segU = 24;
  const segV = 22;
  const R_peak = 2.44;

  const petalGeom = trackGeo(new THREE.BufferGeometry());
  const pPos = [];
  const pNorm = [];
  const pUv = [];
  const pIdx = [];

  for (let iv = 0; iv <= segV; iv++) {
    const v = iv / segV;
    const ridge_ang = -0.34 - 0.10 * Math.sin(v * Math.PI * 0.8) + 0.06 * Math.pow(v, 1.2);
    const ridge_z = 0.18 * Math.sin(v * Math.PI * 0.85);

    for (let iu = 0; iu <= segU; iu++) {
      const p = iu / segU;
      let r_out;
      if (p < 0.34) {
        const tp = p / 0.34;
        r_out = 0.63 + 0.37 * Math.pow(Math.sin(tp * Math.PI * 0.5), 1.15);
      } else {
        const tp = (p - 0.34) / 0.66;
        const thumb_lobe = 0.24 * Math.exp(-Math.pow(tp / 0.18, 2));
        const shoulder_arch = 0.76 * (1 - 0.26 * Math.pow(tp, 2.2));
        r_out = shoulder_arch + thumb_lobe;
      }

      const r = 0.20 + (R_peak * r_out - 0.20) * Math.pow(v, 0.88);
      const clockAng = ridge_ang + p * (0.64 + 0.34 * Math.pow(v, 0.85));
      const back_z = -0.22 * (0.25 + 0.75 * v);
      const z = back_z + (ridge_z - back_z) * Math.pow(1 - p, 1.35) + 0.05 * Math.sin(p * Math.PI) * Math.pow(v, 1.4);

      pPos.push(r * Math.sin(clockAng), r * Math.cos(clockAng), z);
      pNorm.push(0, 0, 1);
      pUv.push(p, v);
    }
  }

  for (let iv = 0; iv < segV; iv++) {
    for (let iu = 0; iu < segU; iu++) {
      const a = iv * (segU + 1) + iu;
      const b = (iv + 1) * (segU + 1) + iu;
      const c = (iv + 1) * (segU + 1) + (iu + 1);
      const d = iv * (segU + 1) + (iu + 1);
      pIdx.push(a, d, b);
      pIdx.push(b, d, c);
    }
  }

  petalGeom.setIndex(pIdx);
  petalGeom.setAttribute('position', new THREE.Float32BufferAttribute(pPos, 3));
  petalGeom.setAttribute('normal', new THREE.Float32BufferAttribute(pNorm, 3));
  petalGeom.setAttribute('uv', new THREE.Float32BufferAttribute(pUv, 2));
  petalGeom.computeVertexNormals();

  const coneGeom = trackGeo(new THREE.BufferGeometry());
  const segU_c = 14;
  const cPos = [];
  const cNorm = [];
  const cUv = [];
  const cIdx = [];

  for (let iv = 0; iv <= segV; iv++) {
    const v = iv / segV;
    const maxR_ridge = R_peak * 0.63;
    const r_ridge = 0.20 + (maxR_ridge - 0.20) * Math.pow(v, 0.88);
    const ridge_ang = -0.34 - 0.10 * Math.sin(v * Math.PI * 0.8) + 0.06 * Math.pow(v, 1.2);
    const ridge_z = 0.18 * Math.sin(v * Math.PI * 0.85);

    for (let iu = 0; iu <= segU_c; iu++) {
      const t_flap = iu / segU_c;
      const r_cut = 0.22 + (maxR_ridge - 0.22) * Math.pow(v, 1.08);
      const r = r_ridge * (1 - t_flap) + r_cut * t_flap;

      const taper_top = 1 - Math.pow(v, 2.1) * 0.94;
      const roll_curve = Math.pow(t_flap, 1.15) * (0.56 + 0.14 * Math.sin(v * Math.PI * 0.8));
      const clockAng = ridge_ang + roll_curve * taper_top;

      const arch_z = 0.26 * Math.sin(t_flap * Math.PI * 0.72) * Math.sin(v * Math.PI * 0.92);
      const lift_z = 0.16 * t_flap * (1 - Math.pow(v, 1.8));
      const z = ridge_z + arch_z + lift_z;

      cPos.push(r * Math.sin(clockAng), r * Math.cos(clockAng), z);
      cNorm.push(0, 0, 1);
      cUv.push(t_flap, v);
    }
  }

  for (let iv = 0; iv < segV; iv++) {
    for (let iu = 0; iu < segU_c; iu++) {
      const a = iv * (segU_c + 1) + iu;
      const b = (iv + 1) * (segU_c + 1) + iu;
      const c = (iv + 1) * (segU_c + 1) + (iu + 1);
      const d = iv * (segU_c + 1) + (iu + 1);
      cIdx.push(a, d, b);
      cIdx.push(b, d, c);
    }
  }

  coneGeom.setIndex(cIdx);
  coneGeom.setAttribute('position', new THREE.Float32BufferAttribute(cPos, 3));
  coneGeom.setAttribute('normal', new THREE.Float32BufferAttribute(cNorm, 3));
  coneGeom.setAttribute('uv', new THREE.Float32BufferAttribute(cUv, 2));
  coneGeom.computeVertexNormals();

  return { petalGeom, coneGeom };
}

function createDarkGreenStemTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 64, 0);
    grad.addColorStop(0, '#1b3309');
    grad.addColorStop(0.38, '#385e16');
    grad.addColorStop(0.72, '#47721e');
    grad.addColorStop(1, '#223d0b');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 256);
  }
  const tex = trackTex(new THREE.CanvasTexture(c));
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function createHoneycombBudTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 256, 128);
    g.addColorStop(0, '#b5bcc4');
    g.addColorStop(0.45, '#f2f3ea');
    g.addColorStop(1, '#fcfaf0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 128);

    for (let row = 0; row < 14; row++) {
      const y = 4 + row * 9;
      const xOff = (row % 2) * 5;
      for (let col = 0; col < 26; col++) {
        const x = 4 + col * 10 + xOff;
        ctx.fillStyle = 'rgba(72, 68, 46, 0.72)';
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  const tex = trackTex(new THREE.CanvasTexture(c));
  tex.encoding = THREE.sRGBEncoding;
  return tex;
}

function createSmallOblateBudGeometry(THREE) {
  const geo = trackGeo(new THREE.SphereGeometry(0.18, 24, 18));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = pos.getY(i);
    let z = pos.getZ(i);

    x *= 1.44;
    y *= 0.84;
    z *= 1.25;

    if (y > 0) {
      const rHorizSq = (x * x) / 0.02 + (z * z) / 0.02;
      const dimple = 0.042 * Math.exp(-rHorizSq) * (y / 0.15);
      y -= dimple;
    }
    pos.setXYZ(i, x, y, z);
  }
  geo.computeVertexNormals();
  return geo;
}

function createFeatheryPappusTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext('2d');
  if (ctx) {
    const cx = 48, cy = 48;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 45);
    g.addColorStop(0, 'rgba(255, 255, 255, 0.82)');
    g.addColorStop(0.18, 'rgba(255, 255, 255, 0.36)');
    g.addColorStop(0.68, 'rgba(255, 255, 255, 0.14)');
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 96, 96);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.68)';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < 36; i++) {
      const ang = (i / 36) * Math.PI * 2;
      const rOut = 36 + (i % 3) * 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * 2, cy + Math.sin(ang) * 2);
      ctx.lineTo(cx + Math.cos(ang) * rOut, cy + Math.sin(ang) * rOut);
      ctx.stroke();
    }
  }
  return trackTex(new THREE.CanvasTexture(c));
}

/**
 * P0-2: 精簡每粒種子內部結構為單一高飽滿度 Sprite，大幅減少 Scene Graph 節點與 Draw Calls
 */
function createSeedUnitMesh(THREE, idx = 0) {
  const group = new THREE.Group();
  const achene = new THREE.Mesh(acheneGeoRef, acheneMatsRef[idx % 3]);
  const lines = new THREE.LineSegments(uniformSeedLinesGeoRef, seedLinesMatRef);

  const fluffOuter = new THREE.Sprite(pappusSpriteMatRef);
  fluffOuter.position.set(0, STALK_LEN + 0.05, 0);
  fluffOuter.scale.set(0.78, 0.78, 1);

  group.add(achene);
  group.add(lines);
  group.add(fluffOuter);
  return group;
}

// ============================================================================
// 3. UI 狀態同步與模式切換 (UI State Sync & Sub-Mode Switcher)
// ============================================================================
export function updateInteractiveUIForState() {
  const spinBtn = document.getElementById('spin-hold-btn');
  const btnMainText = document.getElementById('btn-main-text');
  const btnSubText = document.getElementById('btn-sub-text');
  const btnPulseRing = document.getElementById('btn-pulse-ring');
  const windIcon = document.getElementById('wind-icon');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const speedMeterWrap = document.getElementById('speed-meter-wrap');

  if (!spinBtn || !btnMainText || !btnSubText || !statusDot || !statusText) return;

  if (activeMode === INTERACTIVE_MODES.PINWHEEL) {
    if (currentState === INTERACTIVE_STATES.ACTIVE_HOLD) {
      spinBtn.classList.add('active-hold');
      if (btnPulseRing) btnPulseRing.classList.remove('hidden');
      if (windIcon) windIcon.classList.add('scale-110');
      btnMainText.textContent = '微風吹拂中 · 噘唇呼氣驅動均速旋轉';
      btnSubText.textContent = '保持噘唇慢呼 · 轉回吸氣階段時自動停止並慢慢減速';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = '風車均速旋轉中 (動作感測吹風)';
      if (speedMeterWrap) speedMeterWrap.classList.remove('opacity-0');
    } else if (currentState === INTERACTIVE_STATES.RELEASE_RECOVERY) {
      spinBtn.classList.remove('active-hold');
      if (btnPulseRing) btnPulseRing.classList.add('hidden');
      if (windIcon) windIcon.classList.remove('scale-110');
      btnMainText.textContent = '吸氣階段 · 風車正慢慢減速返回靜止';
      btnSubText.textContent = '請閉口由鼻吸氣並保持雙肩下沉，準備下一次噘唇吹氣';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-sky-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = '風車慢慢減速中';
      if (speedMeterWrap) speedMeterWrap.classList.remove('opacity-0');
    } else {
      spinBtn.classList.remove('active-hold');
      if (btnPulseRing) btnPulseRing.classList.add('hidden');
      if (windIcon) windIcon.classList.remove('scale-110');
      btnMainText.textContent = '動作感測吹風旋轉（免按鍵）';
      btnSubText.textContent = '合口鼻吸氣＋沉肩放鬆 → 噘唇呼氣即可自動吹動風車';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = '微風輕拂 · 靜止輕微晃動';
      if (speedMeterWrap) speedMeterWrap.classList.add('opacity-0');
    }
  } else {
    const isFullyDispersed = disperseElapsed >= DANDELION_DISPERSE_DURATION;
    if (currentState === INTERACTIVE_STATES.ACTIVE_HOLD) {
      spinBtn.classList.add('active-hold');
      if (btnPulseRing) btnPulseRing.classList.remove('hidden');
      if (windIcon) windIcon.classList.add('scale-110');
      btnMainText.textContent = isFullyDispersed ? '種子已全部隨風飄散' : '微風吹散蒲公英種子中...';
      btnSubText.textContent = '初段隨強風快速飄散 · 後段隨微風緩慢飄落';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = isFullyDispersed
        ? '種子已全部隨風飄散'
        : (disperseElapsed < 2.0 ? '蒲公英種子快速飄散中' : '蒲公英種子減速飄散中');
      if (speedMeterWrap) speedMeterWrap.classList.remove('opacity-0');
    } else if (currentState === INTERACTIVE_STATES.RELEASE_RECOVERY) {
      spinBtn.classList.remove('active-hold');
      if (btnPulseRing) btnPulseRing.classList.add('hidden');
      if (windIcon) windIcon.classList.remove('scale-110');
      btnMainText.textContent = '吸氣階段 · 種子正平滑重新長出';
      btnSubText.textContent = '請閉口由鼻吸氣並保持雙肩下沉，準備下一次噘唇吹散';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-sky-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = '蒲公英種子重新生長中';
      if (speedMeterWrap) speedMeterWrap.classList.remove('opacity-0');
    } else {
      spinBtn.classList.remove('active-hold');
      if (btnPulseRing) btnPulseRing.classList.add('hidden');
      if (windIcon) windIcon.classList.remove('scale-110');
      btnMainText.textContent = '動作感測吹散蒲公英（免按鍵）';
      btnSubText.textContent = '合口鼻吸氣＋沉肩放鬆 → 噘唇呼氣即可自動吹散絨毛種子';
      statusDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 transition-colors duration-300 shadow-sm';
      statusText.textContent = '蒲公英 · 靜止輕微晃動';
      if (speedMeterWrap) speedMeterWrap.classList.add('opacity-0');
    }
  }
}

function resetSeedToHome(s) {
  s.isDetached = false;
  s.isFlying = false;
  s.flyAge = 0;
  s.currentScale = 1.0;
  if (s.mesh) {
    s.mesh.visible = true;
    s.mesh.position.set(s.homeX, s.homeY, s.homeZ);
    if (s.homeQuat && s.mesh.quaternion && typeof s.mesh.quaternion.copy === 'function') {
      s.mesh.quaternion.copy(s.homeQuat);
    }
    s.mesh.scale.setScalar(s.baseScale);
  }
}

export function switchInteractiveObjectMode(newSubMode) {
  const normalized = (newSubMode === 'dandelion' || newSubMode === INTERACTIVE_MODES.DANDELION)
    ? INTERACTIVE_MODES.DANDELION
    : INTERACTIVE_MODES.PINWHEEL;

  AppState.interactiveObject = normalized === INTERACTIVE_MODES.DANDELION ? 'dandelion' : 'pinwheel';

  const stageEl = document.getElementById('interactive-3d-stage');
  const bgDofCanvas = document.getElementById('bg-dof-canvas');
  const sunGlowOverlay = document.getElementById('sun-glow-overlay');
  const modePinwheelBtn = document.getElementById('mode-pinwheel-btn');
  const modeDandelionBtn = document.getElementById('mode-dandelion-btn');

  isButtonHeld = false;
  activeMode = normalized;
  currentState = INTERACTIVE_STATES.IDLE;

  if (activeMode === INTERACTIVE_MODES.PINWHEEL) {
    if (modePinwheelBtn) modePinwheelBtn.classList.add('active');
    if (modeDandelionBtn) modeDandelionBtn.classList.remove('active');
    if (stageEl) {
      stageEl.classList.remove('bg-dandelion');
      stageEl.classList.add('bg-pinwheel');
    }
    if (bgDofCanvas) bgDofCanvas.style.opacity = '0';
    if (sunGlowOverlay) sunGlowOverlay.style.opacity = '1';
    if (windmillRoot) windmillRoot.visible = true;
    if (dandelionRoot) dandelionRoot.visible = false;
    angularVelocity = 0;
    idleBlendWeight = 1.0;
  } else {
    if (modeDandelionBtn) modeDandelionBtn.classList.add('active');
    if (modePinwheelBtn) modePinwheelBtn.classList.remove('active');
    if (stageEl) {
      stageEl.classList.remove('bg-pinwheel');
      stageEl.classList.add('bg-dandelion');
    }
    if (bgDofCanvas) bgDofCanvas.style.opacity = '1';
    if (sunGlowOverlay) sunGlowOverlay.style.opacity = '0.15';
    if (windmillRoot) windmillRoot.visible = false;
    if (dandelionRoot) dandelionRoot.visible = true;
    disperseElapsed = 0.0;
    headSeeds.forEach(resetSeedToHome);
  }
  updateInteractiveUIForState();
}

// ============================================================================
// 4. 動作分析觸發介面 (Motion-Analysis Trigger API: startInteractiveBlowing / stopInteractiveBlowing)
// ============================================================================
export function startInteractiveBlowing() {
  if (audioEngine) audioEngine.init();
  if (isButtonHeld) return;
  isButtonHeld = true;

  if (activeMode === INTERACTIVE_MODES.DANDELION) {
    for (let i = 0; i < headSeeds.length; i++) {
      const s = headSeeds[i];
      if (s.detachTime > disperseElapsed) {
        s.isDetached = false;
        s.isFlying = false;
        s.flyAge = 0;
      }
    }
  }

  currentState = INTERACTIVE_STATES.ACTIVE_HOLD;
  updateInteractiveUIForState();
}

export function stopInteractiveBlowing() {
  if (!isButtonHeld) return;
  isButtonHeld = false;

  if (activeMode === INTERACTIVE_MODES.PINWHEEL) {
    if (angularVelocity > 0.05) {
      currentState = INTERACTIVE_STATES.RELEASE_RECOVERY;
      releaseVelocity = angularVelocity;
      decelElapsed = 0;
      const speedFraction = Math.min(1, releaseVelocity / TARGET_SPIN_SPEED);
      decelTotalTime = 6.2 + 0.8 * speedFraction;
    } else {
      currentState = INTERACTIVE_STATES.IDLE;
      angularVelocity = 0;
    }
  } else {
    if (disperseElapsed > 0.005) {
      currentState = INTERACTIVE_STATES.RELEASE_RECOVERY;
      refillSpeedRate = Math.max(disperseElapsed / DANDELION_REFILL_DURATION, 2.2);
    } else {
      currentState = INTERACTIVE_STATES.IDLE;
      disperseElapsed = 0.0;
    }
  }
  updateInteractiveUIForState();
}

// ============================================================================
// 5. 物理推進與單一主迴圈渲染 (P0-1 & P0-2: Zero-Allocation Physics & Unified Render)
// ============================================================================
export function stepInteractivePhysics(dt, elapsed) {
  const speedMeterBar = document.getElementById('speed-meter-bar');

  if (activeMode === INTERACTIVE_MODES.PINWHEEL) {
    if (currentState === INTERACTIVE_STATES.ACTIVE_HOLD) {
      angularVelocity += (TARGET_SPIN_SPEED - angularVelocity) * Math.min(1, dt * 8.5);
      if (Math.abs(TARGET_SPIN_SPEED - angularVelocity) < 0.02) {
        angularVelocity = TARGET_SPIN_SPEED;
      }
      idleBlendWeight = Math.max(0, idleBlendWeight - dt * 4.0);
    } else if (currentState === INTERACTIVE_STATES.RELEASE_RECOVERY) {
      decelElapsed += dt;
      const u = Math.min(1, decelElapsed / decelTotalTime);

      const decayFactor = Math.pow(1 - u, 1.75);
      const endSettle = u > 0.82
        ? -0.08 * Math.sin(((u - 0.82) / 0.18) * Math.PI) * (1 - u)
        : 0;

      angularVelocity = Math.max(0, releaseVelocity * decayFactor) + endSettle;
      idleBlendWeight = u > 0.78 ? (u - 0.78) / 0.22 : 0;

      if (u >= 1) {
        angularVelocity = 0;
        idleBlendWeight = 1.0;
        currentState = INTERACTIVE_STATES.IDLE;
        updateInteractiveUIForState();
      }
    } else {
      angularVelocity = 0;
      idleBlendWeight = Math.min(1, idleBlendWeight + dt * 2.5);
    }

    accumulatedSpinAngle += angularVelocity * dt;

    const idleRockAngle =
      Math.sin(elapsed * 1.15) * 0.048 +
      Math.sin(elapsed * 2.05 + 1.2) * 0.021 +
      Math.cos(elapsed * 0.65) * 0.015;

    if (rotorGroup) {
      rotorGroup.rotation.z = accumulatedSpinAngle + idleRockAngle * idleBlendWeight;
    }

    const speedNorm = Math.min(1, Math.max(0, angularVelocity / TARGET_SPIN_SPEED));
    if (windmillRoot) {
      windmillRoot.rotation.x = -0.024 * speedNorm + Math.sin(elapsed * 1.4) * 0.012;
      windmillRoot.rotation.y = 0.030 * speedNorm + Math.cos(elapsed * 1.1) * 0.016;
      windmillRoot.rotation.z = Math.sin(elapsed * 0.9) * 0.008 * (1 + speedNorm * 0.5);
    }

    if (speedMeterBar) {
      const nextWidth = currentState !== INTERACTIVE_STATES.IDLE
        ? Math.min(100, Math.max(2, speedNorm * 100)).toFixed(0) + '%'
        : '0%';
      if (nextWidth !== lastSpeedMeterText) {
        lastSpeedMeterText = nextWidth;
        speedMeterBar.style.width = nextWidth;
      }
    }

    if (audioEngine) {
      audioEngine.updateSpinSound(Math.max(0, angularVelocity), TARGET_SPIN_SPEED, isButtonHeld, dt, false);
    }
  } else {
    // P0-2: DANDELION MODE — Zero-Allocation In-Place Flight & Regrowth
    if (currentState === INTERACTIVE_STATES.ACTIVE_HOLD) {
      const prevElapsed = disperseElapsed;
      disperseElapsed = Math.min(DANDELION_DISPERSE_DURATION, disperseElapsed + dt);

      let detachedCountThisFrame = 0;
      for (let i = 0; i < headSeeds.length; i++) {
        const s = headSeeds[i];
        if (!s.isDetached && s.detachTime <= disperseElapsed) {
          s.isDetached = true;
          s.isFlying = true;
          s.flyAge = 0;
          detachedCountThisFrame++;
        }
      }
      if (detachedCountThisFrame > 0 && audioEngine) {
        const soundIntensity = disperseElapsed <= 2.0 ? 0.80 : 0.42;
        audioEngine.triggerBladeFlutter(soundIntensity);
      }

      if ((prevElapsed < 2.0 && disperseElapsed >= 2.0) ||
          (prevElapsed < DANDELION_DISPERSE_DURATION && disperseElapsed >= DANDELION_DISPERSE_DURATION)) {
        updateInteractiveUIForState();
      }
    } else if (currentState === INTERACTIVE_STATES.RELEASE_RECOVERY) {
      disperseElapsed = Math.max(0.0, disperseElapsed - refillSpeedRate * dt);

      for (let i = 0; i < headSeeds.length; i++) {
        const s = headSeeds[i];
        if (s.isDetached && s.detachTime > disperseElapsed) {
          // 原位重設回花托表面並開始平滑長大，零 new 物件配置
          s.isDetached = false;
          s.isFlying = false;
          s.flyAge = 0;
          s.currentScale = 0.05;
          if (s.mesh) {
            s.mesh.visible = true;
            s.mesh.position.set(s.homeX, s.homeY, s.homeZ);
            if (s.homeQuat && s.mesh.quaternion && typeof s.mesh.quaternion.copy === 'function') {
              s.mesh.quaternion.copy(s.homeQuat);
            }
          }
        }
      }
    }

    const currentDisperseSpeedFactor = isButtonHeld
      ? (disperseElapsed < 2.0 ? 1.65 : 0.78)
      : 0.72;

    let activeSeedSum = 0;
    let allFullyRegrown = true;
    for (let i = 0; i < headSeeds.length; i++) {
      const s = headSeeds[i];

      if (s.isDetached) {
        // 原位飛行狀態 (In-Place Flight)：直接移動現有 s.mesh，無需額外建立/銷毀 Mesh
        if (s.isFlying) {
          s.flyAge += dt;
          const lifeRatio = s.flyAge / s.maxLife;
          if (lifeRatio >= 1.0) {
            s.isFlying = false;
            if (s.mesh) s.mesh.visible = false;
          } else if (s.mesh) {
            s.mesh.visible = true;
            s.mesh.position.x += s.vx * currentDisperseSpeedFactor * dt;
            s.mesh.position.y += (s.vy * currentDisperseSpeedFactor + Math.sin(elapsed * 3.2 + s.turbulencePhase) * 0.32) * dt;
            s.mesh.position.z += (s.vz * currentDisperseSpeedFactor + Math.cos(elapsed * 2.5 + s.turbulencePhase) * 0.22) * dt;
            s.mesh.rotation.x += s.rotSpeedX * dt;
            s.mesh.rotation.z += s.rotSpeedZ * dt;

            if (lifeRatio > 0.70) {
              const fade = 1 - (lifeRatio - 0.70) / 0.30;
              s.mesh.scale.setScalar(Math.max(0.001, s.baseScale * fade));
            }
          }
        }
      } else {
        // 附著於蒲公英頭或平滑重生中
        if (s.currentScale < 1.0) {
          s.currentScale += (1.0 - s.currentScale) * Math.min(1, dt * 10.0);
          if (s.currentScale > 0.985) {
            s.currentScale = 1.0;
          } else {
            allFullyRegrown = false;
          }
        }
        if (s.mesh) {
          s.mesh.visible = true;
          s.mesh.scale.setScalar(s.baseScale * s.currentScale);
        }
        activeSeedSum += s.currentScale;
      }
    }

    if (speedMeterBar && headSeeds.length > 0) {
      const nextWidth = ((activeSeedSum / headSeeds.length) * 100).toFixed(0) + '%';
      if (nextWidth !== lastSpeedMeterText) {
        lastSpeedMeterText = nextWidth;
        speedMeterBar.style.width = nextWidth;
      }
    }

    if (currentState === INTERACTIVE_STATES.RELEASE_RECOVERY && disperseElapsed <= 0.001 && allFullyRegrown) {
      disperseElapsed = 0.0;
      currentState = INTERACTIVE_STATES.IDLE;
      updateInteractiveUIForState();
    }

    const targetWindPush = isButtonHeld ? (disperseElapsed < 2.0 ? 0.09 : 0.048) : 0;
    const windWave = isButtonHeld ? Math.sin(elapsed * 9.5) * 0.015 : 0;
    const desiredZ = -(targetWindPush + windWave) + Math.sin(elapsed * 1.25) * 0.024;
    if (dandelionRoot && dandelionHead) {
      dandelionRoot.rotation.z += (desiredZ - dandelionRoot.rotation.z) * Math.min(1, dt * 8.0);
      dandelionRoot.rotation.x = Math.cos(elapsed * 1.05) * 0.016;
      dandelionHead.rotation.z = dandelionRoot.rotation.z * 0.55 + Math.sin(elapsed * 1.8) * 0.018;
      dandelionHead.rotation.y = Math.sin(elapsed * 0.9) * 0.06;
    }

    if (audioEngine) {
      const windAudioSpeed = isButtonHeld ? (disperseElapsed < 2.0 ? 3.4 : 1.8) : 0.0;
      audioEngine.updateSpinSound(windAudioSpeed, TARGET_SPIN_SPEED, isButtonHeld, dt, true);
    }
  }

  // Update Background Floating Breeze Particles
  if (pGeo && pGeo.attributes && pGeo.attributes.position) {
    const posAttr = pGeo.attributes.position;
    const windBoost = isButtonHeld ? (activeMode === INTERACTIVE_MODES.DANDELION && disperseElapsed >= 2.0 ? 2.4 : 4.5) : 1.0;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let px = posAttr.getX(i);
      let py = posAttr.getY(i);
      const sp = pSpeeds[i];
      if (!sp) continue;

      px += sp.vx * windBoost * dt;
      py += (sp.vy + Math.sin(elapsed * 1.5 + sp.phase) * 0.08) * dt;

      if (px > 7.0) px = -7.0;
      if (py > 4.5) py = -4.5;
      if (py < -4.5) py = 4.5;

      posAttr.setXY(i, px, py);
    }
    posAttr.needsUpdate = true;
  }
}

/**
 * P0-1: 由 trainingInferenceLoop 單一主迴圈每幀直接呼叫，避免雙重 requestAnimationFrame 競爭
 */
export function renderInteractive3DFrame(externalDt = null) {
  if (!isInitialized || AppState.isPaused) return;

  const dt = typeof externalDt === 'number'
    ? Math.min(externalDt, 0.05)
    : (clock ? Math.min(clock.getDelta(), 0.05) : 0.016);
  const elapsed = clock ? clock.getElapsedTime() : (performance.now() / 1000);

  stepInteractivePhysics(dt, elapsed);

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ============================================================================
// 6. 初始化與銷毀 Three.js 互動場景 (initInteractive3D / disposeInteractive3D)
// ============================================================================
export function initInteractive3D(initialSubMode = AppState.interactiveObject || 'pinwheel') {
  const container = document.getElementById('interactive-canvas-container');
  if (!container) return false;

  if (isInitialized) {
    switchInteractiveObjectMode(initialSubMode);
    return true;
  }

  renderGrasslandDOFBackground();
  audioEngine = new PinwheelAudioEngine();

  isInitialized = true;
  isButtonHeld = false;
  angularVelocity = 0;
  accumulatedSpinAngle = 0;
  decelElapsed = 0;
  disperseElapsed = 0.0;
  lastSpeedMeterText = '';
  headSeeds = [];
  pSpeeds = [];

  const THREE = window.THREE;
  if (!THREE) {
    const goldenRatio = (1 + Math.sqrt(5)) / 2;
    const fastPhaseSeedCount = Math.round(TOTAL_SEEDS * 0.85);
    for (let i = 0; i < TOTAL_SEEDS; i++) {
      const t = i / (TOTAL_SEEDS - 1);
      const y = 1.0 - t * 1.88;
      const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = 2 * Math.PI * i / goldenRatio;
      const x = Math.cos(theta) * radiusAtY;
      const z = Math.sin(theta) * radiusAtY;
      headSeeds.push({
        mesh: null,
        dir: { x, y, z },
        homeX: x * 0.21,
        homeY: y * 0.14,
        homeZ: z * 0.18,
        homeQuat: null,
        baseScale: 1.0,
        currentScale: 1.0,
        windOrderScore: -x * 0.55 + y * 0.30 + Math.sin(i * 1.7) * 0.15,
        detachTime: (i < fastPhaseSeedCount) ? (0.02 + 1.98 * (i / fastPhaseSeedCount)) : (2.0 + 2.0 * ((i - fastPhaseSeedCount) / (TOTAL_SEEDS - fastPhaseSeedCount))),
        speedMultiplier: 1.0,
        isDetached: false,
        isFlying: false,
        flyAge: 0,
        maxLife: 3.2,
        vx: 2.5,
        vy: 0.8,
        vz: 0.2,
        rotSpeedX: 1.0,
        rotSpeedZ: 1.0,
        turbulencePhase: 0
      });
    }
    switchInteractiveObjectMode(initialSubMode);
    return true;
  }

  scene = new THREE.Scene();
  const rect = container.getBoundingClientRect();
  const w = Math.max(320, rect.width || container.clientWidth || 720);
  const h = Math.max(240, rect.height || container.clientHeight || 380);

  camera = new THREE.PerspectiveCamera(36, w / h, 0.1, 100);
  camera.position.set(0, 0.15, w < h ? Math.min(12.2, 7.8 / (w / h) * 0.65 + 4.5) : 9.2);
  camera.lookAt(0, 0.15, 0);

  try {
    // P2-1: 啟用 high-performance GPU 偏好並將 pixelRatio 上限設為 1.25，大幅減少 Fragment Shader 像素負載
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.02;
    container.innerHTML = '';
    container.appendChild(renderer.domElement);
  } catch (err) {
    console.warn('WebGLRenderer unavailable in current environment:', err);
    renderer = null;
  }

  const ambientLight = new THREE.AmbientLight(0xfff8ee, 0.68);
  scene.add(ambientLight);

  const hemiLight = new THREE.HemisphereLight(0xf2f7f5, 0x9c8870, 0.42);
  hemiLight.position.set(0, 6, 2);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight(0xffeacc, 0.95);
  sunLight.position.set(-4.8, 2.8, 6.8);
  scene.add(sunLight);

  const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.35);
  fillLight.position.set(5.0, -1.2, 5.0);
  scene.add(fillLight);

  const woodTex = createWoodTexture(THREE);

  // 2A. PINWHEEL 3D MODEL (P2-1: 改用高效能 MeshStandardMaterial)
  windmillRoot = new THREE.Group();
  windmillRoot.position.set(0, 0.22, 0);
  scene.add(windmillRoot);

  const stickGeo = trackGeo(new THREE.CylinderGeometry(0.068, 0.072, 5.2, 20));
  const stickMat = trackMat(new THREE.MeshStandardMaterial({
    map: woodTex,
    roughness: 0.58,
    metalness: 0.02
  }));
  const stickMesh = new THREE.Mesh(stickGeo, stickMat);
  stickMesh.position.set(0, -2.55, -0.35);
  windmillRoot.add(stickMesh);

  const axleGeo = trackGeo(new THREE.CylinderGeometry(0.09, 0.09, 0.45, 16));
  axleGeo.rotateX(Math.PI / 2);
  const axleMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x7d5836,
    roughness: 0.5,
    metalness: 0.1
  }));
  const axleMesh = new THREE.Mesh(axleGeo, axleMat);
  axleMesh.position.set(0, 0, -0.16);
  windmillRoot.add(axleMesh);

  rotorGroup = new THREE.Group();
  windmillRoot.add(rotorGroup);

  const { petalGeom, coneGeom } = createPhotoMatchedPinwheelGeometries(THREE);
  const bladePalette = [
    { petalHex: 0xa63a12, coneHex: 0xd48806 },
    { petalHex: 0x17521d, coneHex: 0x266e2c },
    { petalHex: 0x7c143a, coneHex: 0x942958 },
    { petalHex: 0x38124a, coneHex: 0x4b226b },
    { petalHex: 0x0c4766, coneHex: 0x125c82 },
    { petalHex: 0x144e75, coneHex: 0x0d3b5e },
    { petalHex: 0x82163b, coneHex: 0x6e0b22 },
    { petalHex: 0x9e3214, coneHex: 0x822209 }
  ];

  bladePalette.forEach((col, index) => {
    const petalMat = trackMat(new THREE.MeshStandardMaterial({
      color: col.petalHex,
      roughness: 0.52,
      metalness: 0.03,
      side: THREE.DoubleSide
    }));
    const coneMat = trackMat(new THREE.MeshStandardMaterial({
      color: col.coneHex,
      roughness: 0.46,
      metalness: 0.03,
      side: THREE.DoubleSide
    }));

    const singleBladeGroup = new THREE.Group();
    singleBladeGroup.add(new THREE.Mesh(petalGeom, petalMat));
    singleBladeGroup.add(new THREE.Mesh(coneGeom, coneMat));
    singleBladeGroup.rotation.z = THREE.MathUtils.degToRad(2) - index * (Math.PI / 4);
    rotorGroup.add(singleBladeGroup);
  });

  const hubGroup = new THREE.Group();
  rotorGroup.add(hubGroup);

  const outerCollarGeo = trackGeo(new THREE.CylinderGeometry(0.265, 0.275, 0.09, 28));
  outerCollarGeo.rotateX(Math.PI / 2);
  const outerCollarMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x24522c,
    roughness: 0.48,
    metalness: 0.08
  }));
  const outerCollarMesh = new THREE.Mesh(outerCollarGeo, outerCollarMat);
  outerCollarMesh.position.z = 0.22;
  hubGroup.add(outerCollarMesh);

  const midCollarGeo = trackGeo(new THREE.CylinderGeometry(0.195, 0.205, 0.09, 28));
  midCollarGeo.rotateX(Math.PI / 2);
  const midCollarMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xc98812,
    roughness: 0.40,
    metalness: 0.1
  }));
  const midCollarMesh = new THREE.Mesh(midCollarGeo, midCollarMat);
  midCollarMesh.position.z = 0.245;
  hubGroup.add(midCollarMesh);

  const beadGeo = trackGeo(new THREE.SphereGeometry(0.145, 24, 16));
  beadGeo.scale(1, 1, 0.72);
  const beadMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0xc9a070,
    map: woodTex,
    roughness: 0.42,
    metalness: 0.05
  }));
  const beadMesh = new THREE.Mesh(beadGeo, beadMat);
  beadMesh.position.z = 0.27;
  hubGroup.add(beadMesh);

  // 2B. DANDELION 3D MODEL (P0-2: 128 In-Place Seeds, Zero Dynamic Allocation)
  dandelionRoot = new THREE.Group();
  dandelionRoot.position.set(0, 0.18, 0);
  dandelionRoot.visible = false;
  scene.add(dandelionRoot);

  const dStemGeo = trackGeo(new THREE.CylinderGeometry(0.068, 0.088, 5.2, 20));
  const dStemMat = trackMat(new THREE.MeshStandardMaterial({
    color: 0x3b6318,
    map: createDarkGreenStemTexture(THREE),
    emissive: 0x112104,
    emissiveIntensity: 0.22,
    roughness: 0.55,
    metalness: 0.02
  }));
  const dStemMesh = new THREE.Mesh(dStemGeo, dStemMat);
  dStemMesh.position.set(0, -2.62, 0);
  dandelionRoot.add(dStemMesh);

  const fuzzVerts = [];
  for (let i = 0; i < 64; i++) {
    const y = -0.35 - (i / 64) * 4.0;
    const side = (i % 2 === 0 ? 1 : -1);
    const ang = (side * Math.PI * 0.5) + (Math.random() - 0.5) * 0.6;
    const r0 = 0.072;
    const r1 = 0.115 + Math.random() * 0.028;
    fuzzVerts.push(
      Math.cos(ang) * r0, y, Math.sin(ang) * r0,
      Math.cos(ang) * r1, y + (Math.random() - 0.3) * 0.03, Math.sin(ang) * r1
    );
  }
  const fuzzGeo = trackGeo(new THREE.BufferGeometry());
  fuzzGeo.setAttribute('position', new THREE.Float32BufferAttribute(fuzzVerts, 3));
  const fuzzMat = trackMat(new THREE.LineBasicMaterial({ color: 0xc8dca8, transparent: true, opacity: 0.42 }));
  dandelionRoot.add(new THREE.LineSegments(fuzzGeo, fuzzMat));

  dandelionHead = new THREE.Group();
  dandelionRoot.add(dandelionHead);

  const recepMesh = new THREE.Mesh(
    createSmallOblateBudGeometry(THREE),
    trackMat(new THREE.MeshStandardMaterial({
      map: createHoneycombBudTexture(THREE),
      roughness: 0.58,
      metalness: 0.02
    }))
  );
  recepMesh.rotation.z = THREE.MathUtils.degToRad(-8);
  recepMesh.position.set(0, 0, 0);
  dandelionHead.add(recepMesh);

  const pappusTex = createFeatheryPappusTexture(THREE);
  acheneGeoRef = trackGeo(new THREE.CylinderGeometry(0.022, 0.011, 0.24, 6));
  acheneGeoRef.translate(0, 0.12, 0);
  acheneMatsRef = [
    trackMat(new THREE.MeshStandardMaterial({ color: 0xb87b14, roughness: 0.55 })),
    trackMat(new THREE.MeshStandardMaterial({ color: 0x85520a, roughness: 0.60 })),
    trackMat(new THREE.MeshStandardMaterial({ color: 0x4f2c05, roughness: 0.65 }))
  ];

  seedLinesMatRef = trackMat(new THREE.LineBasicMaterial({
    color: 0xf7faf7,
    transparent: true,
    opacity: 0.68
  }));

  pappusSpriteMatRef = trackMat(new THREE.SpriteMaterial({
    map: pappusTex,
    color: 0xffffff,
    transparent: true,
    opacity: 0.76,
    depthWrite: false
  }));

  uniformSeedLinesGeoRef = trackGeo(new THREE.BufferGeometry());
  const sVerts = [0, 0.22, 0, 0, STALK_LEN, 0];
  for (let wIdx = 0; wIdx < 6; wIdx++) {
    const wa = (wIdx / 6) * Math.PI * 2;
    sVerts.push(0, 0.26, 0, Math.cos(wa) * 0.16, 0.62, Math.sin(wa) * 0.16);
  }
  const numRays = 12;
  for (let r = 0; r < numRays; r++) {
    const a = (r / numRays) * Math.PI * 2;
    const spread = 0.36 + (r % 2) * 0.07;
    const hVal = STALK_LEN + 0.15 + (r % 3) * 0.04;
    sVerts.push(0, STALK_LEN - 0.02, 0, Math.cos(a) * spread, hVal, Math.sin(a) * spread);
  }
  uniformSeedLinesGeoRef.setAttribute('position', new THREE.Float32BufferAttribute(sVerts, 3));

  const goldenRatio = (1 + Math.sqrt(5)) / 2;
  const upVec = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < TOTAL_SEEDS; i++) {
    const t = i / (TOTAL_SEEDS - 1);
    const y = 1.0 - t * 1.88;
    const radiusAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = 2 * Math.PI * i / goldenRatio;
    const x = Math.cos(theta) * radiusAtY;
    const z = Math.sin(theta) * radiusAtY;

    const dir = new THREE.Vector3(x, y, z).normalize();
    const mesh = createSeedUnitMesh(THREE, i);

    const homeX = dir.x * 0.21;
    const homeY = dir.y * 0.14;
    const homeZ = dir.z * 0.18;
    mesh.position.set(homeX, homeY, homeZ);
    mesh.quaternion.setFromUnitVectors(upVec, dir);
    const homeQuat = new THREE.Quaternion().copy(mesh.quaternion);

    const baseScale = 0.985 + (i % 3) * 0.015;
    mesh.scale.setScalar(baseScale);
    dandelionHead.add(mesh);

    const windOrderScore = -dir.x * 0.55 + dir.y * 0.30 + Math.sin(i * 1.7) * 0.15;
    headSeeds.push({
      mesh,
      dir,
      homeX,
      homeY,
      homeZ,
      homeQuat,
      baseScale,
      currentScale: 1.0,
      windOrderScore,
      detachTime: 0,
      speedMultiplier: 1,
      isDetached: false,
      isFlying: false,
      flyAge: 0,
      maxLife: 3.2 + Math.random() * 1.1,
      vx: 0,
      vy: 0,
      vz: 0,
      rotSpeedX: 0,
      rotSpeedZ: 0,
      turbulencePhase: Math.random() * Math.PI * 2
    });
  }

  const sortedIndices = headSeeds
    .map((s, idx) => ({ idx, score: s.windOrderScore }))
    .sort((a, b) => b.score - a.score);

  const fastPhaseSeedCount = Math.round(TOTAL_SEEDS * 0.85);
  sortedIndices.forEach((item, rank) => {
    let tSec, spdMult;
    if (rank < fastPhaseSeedCount) {
      const uFast = rank / Math.max(1, fastPhaseSeedCount - 1);
      tSec = 0.02 + 1.98 * Math.pow(uFast, 0.78);
      spdMult = 1.85 - 0.35 * uFast;
    } else {
      const uSlow = (rank - fastPhaseSeedCount) / Math.max(1, TOTAL_SEEDS - 1 - fastPhaseSeedCount);
      tSec = 2.00 + 2.00 * Math.pow(uSlow, 1.25);
      spdMult = 0.85 - 0.20 * uSlow;
    }
    const seed = headSeeds[item.idx];
    seed.detachTime = tSec;
    seed.speedMultiplier = spdMult;
    seed.vx = (2.3 + Math.random() * 1.6 + Math.max(0, seed.dir.x) * 0.8) * spdMult;
    seed.vy = (0.45 + Math.random() * 1.10 + seed.dir.y * 0.65) * spdMult;
    seed.vz = seed.dir.z * 0.8 + (Math.random() - 0.5) * 0.8;
    seed.rotSpeedX = (Math.random() - 0.5) * 2.2 * spdMult;
    seed.rotSpeedZ = (Math.random() - 0.5) * 2.2 * spdMult;
  });

  pGeo = trackGeo(new THREE.BufferGeometry());
  const pPositions = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    pPositions[i * 3]     = (Math.random() - 0.5) * 14;
    pPositions[i * 3 + 1] = (Math.random() - 0.5) * 9;
    pPositions[i * 3 + 2] = (Math.random() - 0.5) * 3 - 0.8;
    pSpeeds.push({
      vx: 0.15 + Math.random() * 0.25,
      vy: (Math.random() - 0.5) * 0.12,
      phase: Math.random() * Math.PI * 2
    });
  }
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPositions, 3));

  const spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = 48;
  spriteCanvas.height = 48;
  const sCtx = spriteCanvas.getContext('2d');
  if (sCtx) {
    const sGrad = sCtx.createRadialGradient(24, 24, 0, 24, 24, 24);
    sGrad.addColorStop(0, 'rgba(255, 250, 235, 0.75)');
    sGrad.addColorStop(0.4, 'rgba(255, 245, 215, 0.28)');
    sGrad.addColorStop(1, 'rgba(255, 245, 215, 0)');
    sCtx.fillStyle = sGrad;
    sCtx.fillRect(0, 0, 48, 48);
  }

  const pMat = trackMat(new THREE.PointsMaterial({
    size: 0.15,
    map: trackTex(new THREE.CanvasTexture(spriteCanvas)),
    transparent: true,
    opacity: 0.50,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  }));
  const particleSystem = new THREE.Points(pGeo, pMat);
  scene.add(particleSystem);

  clock = new THREE.Clock();

  resizeListener = () => {
    if (!container || !camera) return;
    const r = container.getBoundingClientRect();
    const cw = Math.max(300, r.width || container.clientWidth || 640);
    const ch = Math.max(220, r.height || container.clientHeight || 360);
    camera.aspect = cw / ch;
    const isPortrait = cw < ch;
    camera.position.z = isPortrait ? Math.min(12.2, 7.8 / (cw / ch) * 0.65 + 4.5) : 9.2;
    camera.updateProjectionMatrix();
    if (renderer) renderer.setSize(cw, ch);
  };
  window.addEventListener('resize', resizeListener);

  switchInteractiveObjectMode(initialSubMode);
  // 首幀立即渲染一次，後續幀由 trainingInferenceLoop 統一呼叫 renderInteractive3DFrame(dt)
  renderInteractive3DFrame(0.016);
  return true;
}

export function toggleInteractiveAudioMute() {
  if (!audioEngine) return false;
  const isPlaying = audioEngine.toggleMute();
  const iconSoundOn = document.getElementById('icon-sound-on');
  const iconSoundOff = document.getElementById('icon-sound-off');
  const audioLabel = document.getElementById('audio-label');
  if (isPlaying) {
    if (iconSoundOn) iconSoundOn.classList.remove('hidden');
    if (iconSoundOff) iconSoundOff.classList.add('hidden');
    if (audioLabel) audioLabel.textContent = '柔和音樂：開啟';
  } else {
    if (iconSoundOn) iconSoundOn.classList.add('hidden');
    if (iconSoundOff) iconSoundOff.classList.remove('hidden');
    if (audioLabel) audioLabel.textContent = '柔和音樂：靜音';
  }
  return isPlaying;
}

/**
 * 切換離開「互動模式」或離開訓練頁面時呼叫：
 * 自動釋放所有 Three.js 幾何、材質、貼圖、WebGL Context 及 Web Audio 資源，防止 Memory Leak
 */
export function disposeInteractive3D() {
  if (!isInitialized) return false;

  isInitialized = false;
  isButtonHeld = false;
  disposedCount++;

  if (animFrameId) {
    cancelAnimationFrame(animFrameId);
    animFrameId = null;
  }

  if (resizeListener) {
    window.removeEventListener('resize', resizeListener);
    resizeListener = null;
  }

  if (audioEngine) {
    audioEngine.dispose();
    audioEngine = null;
  }

  if (scene) {
    scene.traverse((obj) => {
      if (obj.geometry && typeof obj.geometry.dispose === 'function') {
        obj.geometry.dispose();
      }
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach(m => {
          if (!m) return;
          ['map', 'lightMap', 'bumpMap', 'normalMap', 'specularMap', 'envMap'].forEach(k => {
            if (m[k] && typeof m[k].dispose === 'function') {
              m[k].dispose();
            }
          });
          if (typeof m.dispose === 'function') m.dispose();
        });
      }
    });
    while (scene.children.length > 0) {
      scene.remove(scene.children[0]);
    }
  }

  trackedGeometries.forEach(g => {
    try { if (g && typeof g.dispose === 'function') g.dispose(); } catch (e) {}
  });
  trackedMaterials.forEach(m => {
    try { if (m && typeof m.dispose === 'function') m.dispose(); } catch (e) {}
  });
  trackedTextures.forEach(t => {
    try { if (t && typeof t.dispose === 'function') t.dispose(); } catch (e) {}
  });
  trackedGeometries = [];
  trackedMaterials = [];
  trackedTextures = [];

  if (renderer) {
    try {
      if (renderer.renderLists && typeof renderer.renderLists.dispose === 'function') {
        renderer.renderLists.dispose();
      }
      renderer.dispose();
      if (typeof renderer.forceContextLoss === 'function') {
        renderer.forceContextLoss();
      }
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    } catch (e) {}
    renderer = null;
  }

  const container = document.getElementById('interactive-canvas-container');
  if (container) {
    container.innerHTML = '';
  }

  scene = null;
  camera = null;
  clock = null;
  windmillRoot = null;
  rotorGroup = null;
  dandelionRoot = null;
  dandelionHead = null;
  pGeo = null;
  acheneGeoRef = null;
  acheneMatsRef = [];
  uniformSeedLinesGeoRef = null;
  seedLinesMatRef = null;
  pappusSpriteMatRef = null;
  headSeeds = [];
  pSpeeds = [];
  angularVelocity = 0;
  disperseElapsed = 0;
  lastSpeedMeterText = '';
  currentState = INTERACTIVE_STATES.IDLE;

  return true;
}

export function getInteractive3DStats() {
  return {
    isInitialized,
    disposedCount,
    isBlowing: isButtonHeld,
    activeMode,
    currentState,
    angularVelocity,
    disperseElapsed,
    totalSeedsCount: headSeeds.length,
    trackedGeometriesCount: trackedGeometries.length,
    trackedMaterialsCount: trackedMaterials.length,
    trackedTexturesCount: trackedTextures.length
  };
}
