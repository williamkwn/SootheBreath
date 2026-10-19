/**
 * 舒呼(SootheBreath) v8.0 ES6 Module — tts.js
 * 廣東話 (zh-HK) Web Speech API 語音導航引擎 (Cantonese TTS Navigation)
 */

import { AppState } from './state.js';

// ============================================================================
// 6. 廣東話語音合成導航 (Section 4 Cantonese TTS — 預設背景開啟)
// ============================================================================
export function initTTS() {
  AppState.voiceEnabled = true; // 廣東話 (zh-HK) 語音導航口令預設開啟
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

