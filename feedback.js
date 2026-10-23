/**
 * 舒呼(SootheBreath) v10.1 ES6 Module — feedback.js
 * 三層優先警示排程與常駐底部橫幅/語音回饋引擎 (Persistent Bottom Banner & White-Background Orange-Text Alert)
 *
 * v10.1 更新重點：
 * 1. 底部橫幅於訓練開始時即常駐顯示為「分析中...」，消除 10 秒緩衝期結束後彈出造成之訓練頁模組走位問題。
 * 2. 簡化警示字眼：不顯示「連續錯幾多次 (xx%)」或「需要改善 (xx%)」，直接清楚指出需要改善之動作指示。
 * 3. 溫和化警示配色：警示啟動時改用白底配橙字 (bg-white text-[#FF7043])，降低視覺壓迫感。
 */

import { STATES, INITIAL_GRACE_SECONDS, AppState } from './state.js';
import { dom } from './dom.js';
import { speakText } from './tts.js';
import { getHighestPriorityAlert } from './scoring.js';

export const ANALYZING_BANNER_TEXT = "分析中...";
export const SUCCESS_BANNER_TEXT = "✅ 做得非常好，繼續保持！";

export function updateFeedbackBannerAndSpeech(priority, bannerMessage, ttsMessage = '') {
  const now = performance.now();
  const fb = AppState.feedback;

  if (priority === 1 && fb.currentPriority !== 1) {
    fb.currentPriority = 1;
    fb.currentPMessage = bannerMessage;
    renderBottomBanner(bannerMessage, 1);
    speakText(ttsMessage || bannerMessage);
    return;
  }

  if (bannerMessage !== fb.currentPMessage) {
    if (fb.pendingMessage !== bannerMessage) {
      fb.pendingMessage = bannerMessage;
      fb.pendingPriority = priority;
      fb.pendingTimestamp = now;
    } else if (now - fb.pendingTimestamp >= fb.debounceMs) {
      fb.currentPriority = priority;
      fb.currentPMessage = bannerMessage;
      renderBottomBanner(bannerMessage, priority);
      if (priority >= 1 && priority <= 3 && (ttsMessage || bannerMessage)) {
        speakText(ttsMessage || bannerMessage);
      }
    }
  } else {
    fb.pendingMessage = '';
    if (priority >= 1 && priority <= 3 && (ttsMessage || bannerMessage)) {
      speakText(ttsMessage || bannerMessage, false);
    }
  }
}

export function renderBottomBanner(message, priority) {
  if (AppState.currentState !== STATES.TRAINING) return;
  if (!dom.bottomBanner) return;

  const textToShow = message || ANALYZING_BANNER_TEXT;
  if (dom.bottomBanner.textContent !== textToShow) {
    dom.bottomBanner.textContent = textToShow;
  }
  dom.bottomBanner.classList.remove('hidden');

  let nextCls;
  if (priority === 0) {
    // 開局分析中狀態：白底柔和灰藍字，保持固定高度防止版面走位
    nextCls = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-slate-200 bg-white text-slate-500 shadow-sm";
  } else if (priority >= 1 && priority <= 3) {
    // 動作改善警示狀態：白底配橙色文字 (White background and orange words)
    nextCls = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-orange-300 bg-white text-[#FF7043] shadow-md";
  } else {
    // 全部合格達標狀態
    nextCls = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-emerald-300 bg-emerald-50/95 text-[#2E7D32] shadow-md";
  }

  if (dom.bottomBanner.className !== nextCls) {
    dom.bottomBanner.className = nextCls;
  }
}

export function evaluateStickyPriorityFeedback(hasFaceAndPose) {
  const train = AppState.training;
  const fb = AppState.feedback;

  if (!hasFaceAndPose) {
    updateFeedbackBannerAndSpeech(
      1,
      "⚠️ 請調整坐姿，確保面部及雙肩喺鏡頭框內",
      "請調整坐姿，確保面部同雙肩喺鏡頭框入面"
    );
    return;
  }

  // 開局前 10 秒緩衝期（尚未有分析結果時）：常駐顯示「分析中...」，防止橫幅彈出導致版面模組走位
  if (train.elapsedSeconds < INITIAL_GRACE_SECONDS || train.isWarmingUp) {
    fb.latchedModule = null;
    fb.currentPriority = 0;
    fb.currentPMessage = ANALYZING_BANNER_TEXT;
    fb.pendingMessage = '';
    renderBottomBanner(ANALYZING_BANNER_TEXT, 0);
    return;
  }

  // 取得三層優先級警示 (1. 連續失敗排程; 2. 當前階段實時連續錯誤 >=0.9s; 3. 累計百分比 <80% 未解鎖)
  const topAlert = getHighestPriorityAlert();

  if (topAlert) {
    // v10.1: 不顯示「連續錯幾多次 (xx%)」，直接指出需要改善的動作
    const alertMessages = {
      inhale: {
        bannerMsg: '⚠️ 請閉上嘴巴，用鼻慢慢吸氣',
        ttsMsg: '請閉上嘴巴，用鼻慢慢吸氣'
      },
      exhale: {
        bannerMsg: '⚠️ 請將嘴唇噘起成吹蠟燭狀，慢慢吹氣出嚟',
        ttsMsg: '請將嘴唇噘起成吹口哨狀，慢慢吹氣出嚟'
      },
      shoulder: {
        bannerMsg: '⚠️ 請保持雙肩下沉放鬆，避免聳肩',
        ttsMsg: '偵測到聳肩用力，請沉肩放鬆'
      }
    };
    const msgCfg = alertMessages[topAlert.key];
    updateFeedbackBannerAndSpeech(2, msgCfg.bannerMsg, msgCfg.ttsMsg);
  } else {
    fb.currentPriority = 5;
    fb.currentPMessage = SUCCESS_BANNER_TEXT;
    fb.pendingMessage = '';
    renderBottomBanner(SUCCESS_BANNER_TEXT, 5);
  }
}
