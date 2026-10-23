/**
 * 舒呼(SootheBreath) v10.1 ES6 Module — tts.js
 * 廣東話 (zh-HK) Web Speech API 語音導航引擎與人聲靜音切換 (Cantonese TTS Navigation & Voice Mute Control)
 */

import { AppState } from './state.js';
import { dom } from './dom.js';

// ============================================================================
// 6. 廣東話語音合成導航 (Section 4 Cantonese TTS — 預設背景開啟，支援訓練頁人聲靜音切換)
// ============================================================================
export function initTTS() {
  AppState.voiceEnabled = true; // 廣東話 (zh-HK) 語音導航口令預設開啟
  updateVoiceToggleUI();

  if (!('speechSynthesis' in window)) {
    console.warn("本瀏覽器不支援 Web Speech API");
    return;
  }

  const loadVoices = () => {
    const voices = window.speechSynthesis.getVoices();
    AppState.tts.speechSynthesisVoice =
      voices.find(v => v.lang === 'zh-HK' || v.lang === 'yue-Hant-HK') ||
      voices.find(v => v.lang.includes('HK') || v.lang.includes('yue')) ||
      voices.find(v => v.lang === 'zh-TW') ||
      voices.find(v => v.lang.startsWith('zh')) ||
      null;
  };

  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

export function updateVoiceToggleUI() {
  const isEnabled = Boolean(AppState.voiceEnabled);

  if (dom.btnToggleVoice) {
    dom.btnToggleVoice.className = isEnabled
      ? "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-teal-50 hover:bg-teal-100 text-teal-800 border border-teal-300 shadow-xs transition active:scale-95 cursor-pointer flex items-center gap-1"
      : "px-3 py-1.5 rounded-xl text-xs font-extrabold bg-slate-100 hover:bg-slate-200 text-slate-600 border border-slate-300 shadow-xs transition active:scale-95 cursor-pointer flex items-center gap-1";
  }
  if (dom.iconVoiceToggle) {
    dom.iconVoiceToggle.textContent = isEnabled ? "🔊" : "🔇";
  }
  if (dom.labelVoiceToggle) {
    dom.labelVoiceToggle.textContent = isEnabled ? "人聲：開啟" : "人聲：靜音";
  }

  if (dom.headerVoiceBadge) {
    dom.headerVoiceBadge.className = isEnabled
      ? "hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-teal-50 text-teal-800 border border-teal-200"
      : "hidden sm:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-slate-100 text-slate-500 border border-slate-200";
  }
  if (dom.headerVoiceIcon) {
    dom.headerVoiceIcon.textContent = isEnabled ? "🔊" : "🔇";
  }
  if (dom.headerVoiceText) {
    dom.headerVoiceText.textContent = isEnabled ? "廣東話 (zh-HK) 語音導航開啟" : "廣東話 (zh-HK) 語音導航已靜音";
  }
}

export function toggleVoiceMute() {
  AppState.voiceEnabled = !AppState.voiceEnabled;
  if (!AppState.voiceEnabled && ('speechSynthesis' in window)) {
    try {
      window.speechSynthesis.cancel();
    } catch (e) {}
  }
  updateVoiceToggleUI();
  return AppState.voiceEnabled;
}

export function speakText(text, isImmediate = false) {
  if (!AppState.voiceEnabled || !('speechSynthesis' in window)) return;

  const now = performance.now();
  if (!isImmediate && (now - AppState.tts.lastSpokenTime < AppState.tts.cooldownMs)) {
    return;
  }

  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-HK';
    utterance.rate = 0.95;
    if (AppState.tts.speechSynthesisVoice) {
      utterance.voice = AppState.tts.speechSynthesisVoice;
    }
    window.speechSynthesis.speak(utterance);
    AppState.tts.lastSpokenTime = now;
  } catch (err) {
    console.warn("語音合成播放失敗:", err);
  }
}
