/**
 * 舒呼(SootheBreath) v7.0 ES6 Module — camera.js
 * WebRTC 相機串流管理與臨床權限/硬體診斷 (WebRTC Camera & Diagnostics)
 */

import { AppState } from './state.js';
import { dom } from './dom.js';

// ============================================================================
// 4. WebRTC 相機啟動與診斷規格 (Section 6 Camera Diagnostics)
// ============================================================================
export async function startCamera(videoElement) {
  if (AppState.isDemoMode) return true;

  const isSecure = window.isSecureContext || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (!isSecure) {
    showCameraDiagnosticError({ name: 'SecurityError' });
    return false;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCameraDiagnosticError({ name: 'SecurityError' });
    return false;
  }

  const constraints = {
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: "user"
    },
    audio: false
  };

  try {
    if (AppState.stream && AppState.stream.active) {
      videoElement.srcObject = AppState.stream;
      await videoElement.play().catch(() => {});
      return true;
    }

    if (AppState.stream) {
      AppState.stream.getTracks().forEach(track => track.stop());
    }

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    AppState.stream = stream;
    videoElement.srcObject = stream;

    await new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play().then(resolve).catch(resolve);
      };
    });

    return true;
  } catch (error) {
    console.error("相機啟動異常:", error);
    showCameraDiagnosticError(error);
    return false;
  }
}

export function stopCamera() {
  if (AppState.stream) {
    AppState.stream.getTracks().forEach(track => track.stop());
    AppState.stream = null;
  }
}

export function showCameraDiagnosticError(error) {
  let title = "相機啟動受阻";
  let desc = "瀏覽器無法正常存取視訊鏡頭硬體。";
  let stepsHtml = "";

  switch (error.name) {
    case 'SecurityError':
      title = "安全性限制 (Non-HTTPS / 本地檔案)";
      desc = "目前處於未加密的網絡環境或直接開啟本機 HTML 檔案。";
      stepsHtml = `
        <p>1. 瀏覽器安全策略規定，相機存取必須在 <b>HTTPS 加密協定</b> 或 <b>localhost</b> 下運行。</p>
        <p>2. 若在本地測試，請使用 VS Code Live Server 或在終端機執行 <code>npx serve</code>。</p>
        <p>3. 若已部署至 Vercel，請確認網址以 <code>https://</code> 開頭。</p>
      `;
      break;

    case 'NotAllowedError':
    case 'PermissionDeniedError':
      title = "鏡頭存取權限被拒 (Permission Denied)";
      desc = "你或瀏覽器設定拒絕了此網頁存取相機的權限。";
      stepsHtml = `
        <p>1. 點擊瀏覽器網址列最左側的 <b>🔒 鎖頭圖示</b> 或設定按鈕。</p>
        <p>2. 將「相機 (Camera)」設定由「封鎖」改為<b>「允許」</b>。</p>
        <p>3. <b>iPad / Mac 用家</b>：請檢查 系統設定 &gt; 私隱與安全性 &gt; 相機，確認 Safari / Chrome 已獲授權。</p>
        <p>4. <b>Windows 用家</b>：請檢查 Windows 設定 &gt; 私隱 &gt; 相機，開啟「允許桌面應用程式存取相機」。</p>
      `;
      break;

    case 'NotFoundError':
    case 'DevicesNotFoundError':
      title = "未偵測到鏡頭硬體 (Not Found)";
      desc = "系統找不到任何可用的視訊輸入裝置。";
      stepsHtml = `
        <p>1. 請檢查手提電腦 (Laptop) 鏡頭上方的<b>實體防窺撥片 (Privacy Shutter)</b> 是否已打開。</p>
        <p>2. 部分品牌電腦（如 Lenovo、ASUS、MSI）配有鍵盤相機開關快速鍵（例如 Fn + F8 或 F10）。</p>
        <p>3. 若目前裝置無鏡頭，你可點擊下方「<b>🧪 免鏡頭模擬訓練</b>」預覽完整功能。</p>
      `;
      break;

    case 'NotReadableError':
    case 'TrackStartError':
      title = "鏡頭被其他應用程式佔用 (Camera Occupied)";
      desc = "相機硬體正在被其他視訊通話或後台程式使用。";
      stepsHtml = `
        <p>1. 請檢查並先完全關閉 <b>Zoom、Microsoft Teams、Google Meet、FaceTime</b> 或其他相機軟件。</p>
        <p>2. 重新整理本網頁後再試一次，或先使用「<b>🧪 免鏡頭模擬訓練</b>」。</p>
      `;
      break;

    default:
      title = "未知相機存取錯誤 (" + (error.name || "Error") + ")";
      desc = error.message || "系統發生未預期的鏡頭存取問題。";
      stepsHtml = `<p>請嘗試重新整理瀏覽器，或點擊下方「🧪 免鏡頭模擬訓練」體驗完整呼吸節奏導引。</p>`;
      break;
  }

  dom.modalErrorTitle.textContent = title;
  dom.modalErrorDesc.textContent = desc;
  dom.modalErrorSteps.innerHTML = stepsHtml;
  dom.modalError.classList.remove('hidden');
}

