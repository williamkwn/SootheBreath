/**
 * 舒呼(SootheBreath) v8.0 ES6 Module — feedback.js
 * 連續失敗警示排程 (Alert Schedule) 優先順序與底部橫幅/語音回饋引擎
 */

import { STATES, INITIAL_GRACE_SECONDS, AppState } from './state.js';
import { dom } from './dom.js';
import { speakText } from './tts.js';
import { getHighestPriorityAlert } from './scoring.js';

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
      if (priority <= 3 && (ttsMessage || bannerMessage)) {
        speakText(ttsMessage || bannerMessage);
      }
    }
  } else {
    fb.pendingMessage = '';
    if (priority <= 3 && (ttsMessage || bannerMessage)) {
      speakText(ttsMessage || bannerMessage, false);
    }
  }
}

export function renderBottomBanner(message, priority) {
  if (AppState.currentState !== STATES.TRAINING) return;
  if (!message) {
    dom.bottomBanner.classList.add('hidden');
    return;
  }

  dom.bottomBanner.textContent = message;
  dom.bottomBanner.classList.remove('hidden');

  if (priority === 1) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-rose-500 bg-rose-600 text-white shadow-lg";
  } else if (priority <= 3) {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-orange-400 bg-gradient-to-r from-rose-600 to-orange-500 text-white shadow-lg";
  } else {
    dom.bottomBanner.className = "shrink-0 w-full py-3.5 px-6 text-center z-30 font-extrabold text-xl md:text-2xl leading-snug border-t-2 border-emerald-300 bg-emerald-50/95 text-[#2E7D32] shadow-md";
  }
}

export function evaluateStickyPriorityFeedback(hasFaceAndPose) {
  const train = AppState.training;
  const fb = AppState.feedback;

  if (!hasFaceAndPose) {
    updateFeedbackBannerAndSpeech(
      1,
      "請調整坐姿，確保面部及雙肩喺鏡頭框內",
      "請調整坐姿，確保面部同雙肩喺鏡頭框入面"
    );
    return;
  }

  // 開局前 10 秒緩衝期：保持百分比計算開啟，但不觸發任何警示，亦不顯示「✅ 做得非常好，繼續保持！」
  if (train.elapsedSeconds < INITIAL_GRACE_SECONDS || train.isWarmingUp) {
    fb.latchedModule = null;
    fb.currentPMessage = '';
    fb.pendingMessage = '';
    if (dom.bottomBanner) {
      dom.bottomBanner.classList.add('hidden');
    }
    return;
  }

  // 取得「需要改善排程」中最高優先級之指標 (1. consecutiveFails 最高優先; 2. 累計 % 最低優先)
  const topAlert = getHighestPriorityAlert();

  if (topAlert) {
    const alertMessages = {
      inhale: {
        bannerMsg: `⚠️【合口吸氣 · 連續 ${topAlert.consecutiveFails} 次未達標 (${topAlert.pct}%)】請閉上嘴巴，用鼻慢慢吸氣`,
        ttsMsg: '請閉上嘴巴，用鼻慢慢吸氣'
      },
      exhale: {
        bannerMsg: `⚠️【噘唇呼氣 · 連續 ${topAlert.consecutiveFails} 次未達標 (${topAlert.pct}%)】請將嘴唇噘起成吹蠟燭狀，慢慢吹氣出嚟`,
        ttsMsg: '請將嘴唇噘起成吹口哨狀，慢慢吹氣出嚟'
      },
      shoulder: {
        bannerMsg: `⚠️【沉肩放鬆 · 連續 ${topAlert.consecutiveFails} 次未達標 (${topAlert.pct}%)】偵測到聳肩代償，請保持雙肩下沉放鬆`,
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
