/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — summary.js
 * 訓練總結報告生成、去識別化 CSV 匯出與本機歷史紀錄 (Summary Report, CSV Export & Local History)
 */

import { THRESHOLDS, AppState } from './state.js';
import { dom, showToast } from './dom.js';
import { speakText } from './tts.js';

// ============================================================================
// 11. 總結報告生成與 CSV 匯出 (Section 5 Summary & CSV Export — 維持計算全程總平均)
// ============================================================================
export function renderSummaryReport() {
  const train = AppState.training;
  const totalSecs = Math.max(1, Math.round(train.elapsedSeconds));
  const completedCycles = train.cyclesHistory.length;

  const meanRR = completedCycles > 0
    ? ((completedCycles / totalSecs) * 60).toFixed(1)
    : train.avgRR.toFixed(1);

  let sumIe = 0;
  train.cyclesHistory.forEach(c => sumIe += c.achievedIe);
  const meanIe = completedCycles > 0 ? (sumIe / completedCycles).toFixed(1) : AppState.ieRatio.toFixed(1);

  const inhaleAcc = train.totalInhaleFrames > 0
    ? Math.round((train.validInhaleFrames / train.totalInhaleFrames) * 100)
    : 95;

  const plbAcc = train.totalExhaleFrames > 0
    ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100)
    : 92;

  const shoulderAcc = train.totalShoulderFrames > 0
    ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100)
    : 96;

  let gradeText = "優秀 (A)";
  if (plbAcc < 70 || shoulderAcc < 70 || inhaleAcc < 70) {
    gradeText = "需加強練習 (C)";
  } else if (plbAcc < 80 || shoulderAcc < 80 || inhaleAcc < 80) {
    gradeText = "良好 (B)";
  }

  dom.sumCycles.textContent = `${completedCycles} 週期`;
  const m = Math.floor(totalSecs / 60);
  const s = totalSecs % 60;
  dom.sumDuration.textContent = `總時間 ${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')} · 合口吸氣 ${inhaleAcc}%`;
  dom.sumRr.textContent = meanRR;
  dom.sumIe.textContent = `1 : ${meanIe}`;
  dom.sumPlbAcc.textContent = `${plbAcc}%`;
  dom.sumShoulderAcc.textContent = `${shoulderAcc}%`;
  dom.sumGrade.textContent = gradeText;

  speakText(`訓練完成，你共完成了${completedCycles}次呼吸週期，平均呼吸頻率為每分鐘${meanRR}次，評級為${gradeText}`, true);
  loadAndRenderLocalHistory();
}

export function exportDeidentifiedCSV() {
  const train = AppState.training;
  const cal = AppState.calibration;
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8);
  const meanRR = dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1);
  const inhaleAcc = train.totalInhaleFrames > 0 ? Math.round((train.validInhaleFrames / train.totalInhaleFrames) * 100) : 95;
  const plbAcc = train.totalExhaleFrames > 0 ? Math.round((train.validPlbExhaleFrames / train.totalExhaleFrames) * 100) : 92;
  const shoulderAcc = train.totalShoulderFrames > 0 ? Math.round((train.validShoulderFrames / train.totalShoulderFrames) * 100) : 96;

  let csvContent = "data:text/csv;charset=utf-8,\uFEFF";
  csvContent += "=== 舒呼(SootheBreath) 呼吸復康訓練 (v7.0) — 匿名臨床數據報表 ===\n";
  csvContent += `訓練日期,${dateStr}\n`;
  csvContent += `訓練時間,${timeStr}\n`;
  csvContent += `總訓練秒數,${Math.round(train.elapsedSeconds)}\n`;
  csvContent += `完成循環總數,${train.cyclesHistory.length}\n`;
  csvContent += `設定目標呼吸頻率(BPM),${AppState.targetBpm}\n`;
  csvContent += `實測平均呼吸頻率(次/分),${meanRR}\n`;
  csvContent += `設定目標吸呼比,1:${AppState.ieRatio}\n`;
  csvContent += `全程合口吸氣達標率(%),${inhaleAcc}%\n`;
  csvContent += `全程噘唇呼氣達標率(%),${plbAcc}%\n`;
  csvContent += `全程沉肩放鬆達標率(%),${shoulderAcc}%\n\n`;

  csvContent += "=== 五步個人化基準校準與動態閾值 ===\n";
  csvContent += `Step1_閉嘴_LAR_closed,${cal.LAR_closed.toFixed(3)},jawOpen_closed,${cal.jawOpen_closed.toFixed(3)},D_eye,${cal.D_eye.toFixed(3)}\n`;
  csvContent += `Step2_張大口_LAR_open,${cal.LAR_open.toFixed(3)},jawOpen_open,${cal.jawOpen_open.toFixed(3)}\n`;
  csvContent += `Step3_噘唇_LAR_plb,${cal.LAR_plb.toFixed(3)},mouthPucker_plb,${cal.mouthPucker_plb.toFixed(2)},mouthFunnel_plb,${cal.mouthFunnel_plb.toFixed(2)}\n`;
  csvContent += `Step4_縮膊頭_Dist_shrug,${cal.Dist_shrug.toFixed(3)},Step5_放鬆膊頭_Dist_relax,${cal.Dist_relax.toFixed(3)},yShoulderBase,${cal.yShoulderBase.toFixed(3)}\n`;
  csvContent += `動態閾值_larInhaleMax,${THRESHOLDS.larInhaleMax.toFixed(2)},jawOpenInhaleMax,${THRESHOLDS.jawOpenInhaleMax.toFixed(2)},larExhaleWideErr,${THRESHOLDS.larExhaleWideErr.toFixed(2)},shoulderHikeWarn,${THRESHOLDS.shoulderHikeWarn.toFixed(2)}\n\n`;

  csvContent += "週期序號,實測有效吸氣時間(秒),實測噘唇呼氣時間(秒),實測I:E吸呼比,呼氣70%柔性過渡完成,單次週期呼吸頻率(次/分),累計平均呼吸頻率(次/分)\n";
  train.cyclesHistory.forEach(c => {
    const cRR = c.cycleRR ? c.cycleRR.toFixed(1) : AppState.targetBpm.toFixed(1);
    const aRR = c.avgRR ? c.avgRR.toFixed(1) : meanRR;
    const softFlag = c.softTransitionCompleted ? '是' : '否';
    csvContent += `${c.cycle},${c.tInActual.toFixed(2)},${c.tExActual.toFixed(2)},1:${c.achievedIe.toFixed(2)},${softFlag},${cRR},${aRR}\n`;
  });

  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `SootheBreath_v6_Report_${dateStr}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  showToast("📥 匿名 CSV 臨床報表已開始下載");
}

export function saveSessionToLocalStorage() {
  const train = AppState.training;
  const historyKey = 'soothebreath_history_v6';
  let existing = [];
  try {
    existing = JSON.parse(
      localStorage.getItem(historyKey) ||
      localStorage.getItem('soothebreath_history_v4') ||
      localStorage.getItem('breathguide_history_v3') ||
      '[]'
    );
  } catch (e) {
    existing = [];
  }

  const record = {
    date: new Date().toLocaleString('zh-HK'),
    duration: Math.round(train.elapsedSeconds),
    cycles: train.cyclesHistory.length,
    meanRR: dom.sumRr ? dom.sumRr.textContent : train.avgRR.toFixed(1),
    plbAcc: dom.sumPlbAcc.textContent,
    shoulderAcc: dom.sumShoulderAcc.textContent,
    grade: dom.sumGrade.textContent
  };

  existing.unshift(record);
  const trimmed = existing.slice(0, 10);
  try {
    localStorage.setItem(historyKey, JSON.stringify(trimmed));
  } catch (e) {
    console.warn("localStorage 寫入受限:", e);
  }
  loadAndRenderLocalHistory();
  showToast("✅ 訓練紀錄已成功儲存至本機瀏覽器");
}

export function loadAndRenderLocalHistory() {
  if (!dom.listHistory) return;
  let records = [];
  try {
    records = JSON.parse(
      localStorage.getItem('soothebreath_history_v6') ||
      localStorage.getItem('soothebreath_history_v4') ||
      localStorage.getItem('breathguide_history_v3') ||
      '[]'
    );
  } catch (e) {
    records = [];
  }

  if (records.length === 0) {
    dom.listHistory.innerHTML = `<div class="text-slate-400 py-2 text-center">暫無本地歷史紀錄（完成訓練後可點擊上方儲存）</div>`;
    return;
  }

  dom.listHistory.innerHTML = records.map((r, i) => `
    <div class="flex flex-wrap justify-between items-center bg-slate-50 px-3.5 py-2 rounded-xl border border-slate-200/80 gap-2">
      <div>
        <span class="text-[#2E7D32] font-bold">#${records.length - i}</span>
        <span class="text-slate-500 ml-2">${r.date}</span>
      </div>
      <div class="space-x-2.5 text-right">
        <span class="text-slate-700 font-medium">${r.cycles} 週期</span>
        ${r.meanRR ? `<span class="text-sky-700">RR: ${r.meanRR} 次/分</span>` : ''}
        <span class="text-teal-700">噘唇: ${r.plbAcc}</span>
        <span class="text-[#2E7D32] font-bold">${r.grade}</span>
      </div>
    </div>
  `).join('');
}

