/* ═══════════════════════════════════════════════════════════
   水試所多國語音轉譯小幫手 - Frontend Logic
   農業部水產試驗所 · Fisheries Research Institute
   ═══════════════════════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const STATE = {
  apiKey:          sessionStorage.getItem('fri_api_key') || '',
  currentTab:      'realtime',
  currentLang:     'orig',
  isRecording:     false,
  recInterval:     null,
  recSeconds:      0,
  segmentTimer:    null,
  accTranscript:   '',
  accTranslations: { zh: '', en: '', ja: '' },
  resultData:      null,
  currentRecId:    null,
  statCount:       0,
  // Audio pipeline
  stream:          null,
  audioCtx:        null,
  analyser:        null,
  scriptProc:      null,
  pcmBuffer:       [],   // Float32Array[] — 每段 PCM 資料
  animId:          null,
};

// ─────────────────────────────────────────────
// DOM refs
// ─────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ─────────────────────────────────────────────
// Socket.IO
// ─────────────────────────────────────────────
const socket = io({ transports: ['websocket', 'polling'] });

socket.on('connect',    () => console.log('WS connected:', socket.id));
socket.on('disconnect', () => console.warn('WS disconnected'));

socket.on('transcription_result', data => {
  STATE.accTranscript += (STATE.accTranscript ? '\n' : '') + data.text;
  for (const lang of ['zh', 'en', 'ja']) {
    if (data.translations?.[lang]) {
      STATE.accTranslations[lang] += (STATE.accTranslations[lang] ? '\n' : '') + data.translations[lang];
    }
  }
  // 同步更新全部四欄
  setColContent('rtColOrig', STATE.accTranscript);
  setColContent('rtColZh',   STATE.accTranslations.zh);
  setColContent('rtColEn',   STATE.accTranslations.en);
  setColContent('rtColJa',   STATE.accTranslations.ja);
  updateWordCount(STATE.accTranscript);
  showToast('收到新片段轉譯結果', 'info');
});

socket.on('summary_result', data => {
  renderSummary(data.summary);
  $('summarySpinner').classList.add('d-none');
});

socket.on('ws_error', data => {
  showToast('錯誤：' + data.message, 'danger');
  $('summarySpinner').classList.add('d-none');
});

// ─────────────────────────────────────────────
// Toast helper
// ─────────────────────────────────────────────
function showToast(msg, type = 'success') {
  const el = $('appToast');
  el.className = 'toast align-items-center border-0 bg-' + type;
  $('toastMsg').textContent = msg;
  const toast = bootstrap.Toast.getOrCreateInstance(el, { delay: 3500 });
  toast.show();
}

// ─────────────────────────────────────────────
// Loading overlay
// ─────────────────────────────────────────────
function showLoading(msg = '處理中，請稍候…') {
  $('loadingMsg').textContent = msg;
  $('loadingOverlay').classList.remove('d-none');
}
function hideLoading() {
  $('loadingOverlay').classList.add('d-none');
}

// ─────────────────────────────────────────────
// API Key modal
// ─────────────────────────────────────────────
function updateApiKeyBadge() {
  const badge   = $('apiKeyBadge');
  const statusEl = $('apiKeyStatus');
  if (STATE.apiKey) {
    badge.className = 'badge api-badge-set';
    statusEl.textContent = 'API Key 已設定';
  } else {
    badge.className = 'badge api-badge-missing';
    statusEl.textContent = '未設定 API Key';
  }
}

$('toggleApiKey').addEventListener('click', () => {
  const inp = $('apiKeyInput');
  const icon = $('toggleApiKey').querySelector('i');
  if (inp.type === 'password') {
    inp.type = 'text';
    icon.className = 'bi bi-eye-slash';
  } else {
    inp.type = 'password';
    icon.className = 'bi bi-eye';
  }
});

$('saveApiKey').addEventListener('click', () => {
  const key = $('apiKeyInput').value.trim();
  if (!key) {
    $('apiKeyError').textContent = '請輸入 API Key';
    $('apiKeyError').classList.remove('d-none');
    return;
  }
  if (!key.startsWith('gsk_') && !key.startsWith('gsk-')) {
    $('apiKeyError').textContent = '格式似乎不正確（應以 gsk_ 開頭）';
    $('apiKeyError').classList.remove('d-none');
    return;
  }
  STATE.apiKey = key;
  sessionStorage.setItem('fri_api_key', key);
  updateApiKeyBadge();
  bootstrap.Modal.getInstance($('apiKeyModal')).hide();
  showToast('API Key 已儲存', 'success');
});

$('cancelApiKey').addEventListener('click', () => {
  $('apiKeyError').classList.add('d-none');
});

// Pre-fill if saved
if (STATE.apiKey) {
  $('apiKeyInput').value = STATE.apiKey;
}
updateApiKeyBadge();

// Show modal on load if no key
window.addEventListener('load', () => {
  if (!STATE.apiKey) {
    new bootstrap.Modal($('apiKeyModal')).show();
  }
});

// ─────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────
$$('.main-tabs .nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.main-tabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    STATE.currentTab = tab;
    $$('.tab-pane-content').forEach(p => p.classList.add('d-none'));
    $('tab-' + tab).classList.remove('d-none');
    if (tab === 'history') loadHistory();
  });
});

$('showHistoryBtn').addEventListener('click', () => {
  $$('.main-tabs .nav-link').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === 'history');
  });
  $$('.tab-pane-content').forEach(p => p.classList.add('d-none'));
  $('tab-history').classList.remove('d-none');
  STATE.currentTab = 'history';
  loadHistory();
});

// ─────────────────────────────────────────────
// 多欄文字設定（含閃爍動畫）
// ─────────────────────────────────────────────
function setColContent(id, text) {
  const el = $(id);
  if (!el) return;
  if (text && text.trim()) {
    el.textContent = text;
    el.classList.remove('updating');
    void el.offsetWidth; // 重置動畫
    el.classList.add('updating');
  } else {
    el.innerHTML = '<span class="text-muted fst-italic">（無內容）</span>';
  }
}

// 單欄複製（供 HTML onclick 呼叫）
function copyColContent(id) {
  const el = $(id);
  if (!el) return;
  const text = el.textContent?.trim() || '';
  if (!text || text === '（無內容）' || text === '(No content yet)' || text.includes('將在此')) {
    showToast('尚無文字可複製', 'warning');
    return;
  }
  navigator.clipboard.writeText(text).then(() => {
    showToast('已複製到剪貼簿 ✓', 'success');
  }).catch(() => {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('已複製到剪貼簿 ✓', 'success');
  });
}

// 依語言選擇顯示/隱藏欄位
function syncLangColVisibility() {
  const langs = getSelectedLangs();
  // 即時錄音欄
  const rtZh = $('rtCardZh'); const rtEn = $('rtCardEn'); const rtJa = $('rtCardJa');
  if (rtZh) rtZh.style.display = langs.includes('zh') ? '' : 'none';
  if (rtEn) rtEn.style.display = langs.includes('en') ? '' : 'none';
  if (rtJa) rtJa.style.display = langs.includes('ja') ? '' : 'none';
  // 結果欄
  const rZh = $('resultCardZh'); const rEn = $('resultCardEn'); const rJa = $('resultCardJa');
  if (rZh) rZh.style.display = langs.includes('zh') ? '' : 'none';
  if (rEn) rEn.style.display = langs.includes('en') ? '' : 'none';
  if (rJa) rJa.style.display = langs.includes('ja') ? '' : 'none';
}

// 監聽語言勾選變化
$$('.lang-checks input').forEach(cb => {
  cb.addEventListener('change', syncLangColVisibility);
});
syncLangColVisibility(); // 初始化

function renderSummary(text) {
  const box = $('summaryContent');
  // Simple markdown-like rendering
  const html = text
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^## (.+)$/gm, '<h6 class="fw-bold text-warning mt-3 mb-1">$1</h6>')
    .replace(/^• (.+)$/gm, '<div class="d-flex gap-2 mb-1"><span class="text-success">●</span><span>$1</span></div>')
    .replace(/\n/g, '<br>');
  box.innerHTML = html;
}

function showResults(data) {
  STATE.resultData = data;

  const orig = data.original  || data.orig_text || '';
  const zh   = data.translations?.zh || data.zh_text || '';
  const en   = data.translations?.en || data.en_text || '';
  const ja   = data.translations?.ja || data.ja_text || '';

  // ── 強制所有欄都顯示（不受語言勾選影響），再填入內容 ──
  ['resultCardZh','resultCardEn','resultCardJa'].forEach(id => {
    const el = $(id);
    if (el) el.style.display = '';
  });

  setColContent('colOrig', orig);
  setColContent('colZh',   zh);
  setColContent('colEn',   en);
  setColContent('colJa',   ja);

  // 顯示結果面板（必須在 setColContent 之後）
  $('resultsPanel').classList.remove('d-none');

  if (data.summary) {
    renderSummary(data.summary);
  } else {
    $('summaryContent').innerHTML = `
      <div class="text-center text-muted py-3">
        <i class="bi bi-stars fs-2"></i>
        <p class="mt-2 mb-0">點擊「AI 重點摘要」按鈕自動生成摘要</p>
      </div>`;
  }

  updateWordCount(orig);
  STATE.statCount++;
  $('statCount').textContent = STATE.statCount;
  setTimeout(() => $('resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
}

// ─────────────────────────────────────────────
// Get selected languages
// ─────────────────────────────────────────────
function getSelectedLangs() {
  return [...$$('.lang-checks input:checked')].map(c => c.value);
}

// ─────────────────────────────────────────────
// Real-time recording
// ─────────────────────────────────────────────
$('btnStartRec').addEventListener('click', startRecording);
$('btnStopRec').addEventListener('click', stopRecording);
$('btnClearRt').addEventListener('click', () => {
  STATE.accTranscript   = '';
  STATE.accTranslations = { zh: '', en: '', ja: '' };
  // 清除全部即時欄
  const placeholders = {
    rtColOrig: '逐字稿將在此即時顯示…',
    rtColZh:   '中文譯文將在此顯示…',
    rtColEn:   'English translation will appear here…',
    rtColJa:   '日本語訳はここに表示されます…',
  };
  for (const [id, txt] of Object.entries(placeholders)) {
    const el = $(id);
    if (el) el.innerHTML = `<span class="text-muted fst-italic">${txt}</span>`;
  }
  $('resultsPanel').classList.add('d-none');
  updateWordCount('');
});

// ═══════════════════════════════════════════════
// WAV 編碼工具（純 JS，無需外部套件）
// ═══════════════════════════════════════════════
function _writeStr(view, offset, str) {
  for (let i = 0; i < str.length; i++)
    view.setUint8(offset + i, str.charCodeAt(i));
}
function _pcmToInt16(view, offset, pcm) {
  for (let i = 0; i < pcm.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}
/**
 * Float32Array PCM → WAV Blob（audio/wav）
 * Groq Whisper 100% 支援 WAV 格式
 */
function encodeWAV(pcm, sampleRate) {
  const dataLen = pcm.length * 2;
  const buf     = new ArrayBuffer(44 + dataLen);
  const v       = new DataView(buf);
  _writeStr(v, 0,  'RIFF');
  v.setUint32 (4,  36 + dataLen, true);
  _writeStr(v, 8,  'WAVE');
  _writeStr(v, 12, 'fmt ');
  v.setUint32 (16, 16,         true);  // chunk size
  v.setUint16 (20, 1,          true);  // PCM
  v.setUint16 (22, 1,          true);  // mono
  v.setUint32 (24, sampleRate, true);
  v.setUint32 (28, sampleRate * 2, true);
  v.setUint16 (32, 2,          true);  // block align
  v.setUint16 (34, 16,         true);  // bits/sample
  _writeStr(v, 36, 'data');
  v.setUint32 (40, dataLen,    true);
  _pcmToInt16(v, 44, pcm);
  return new Blob([buf], { type: 'audio/wav' });
}

// ═══════════════════════════════════════════════
// 即時錄音（MediaRecorder → webm/ogg → HTTP POST）
// 每段由瀏覽器原生編碼，產生完整可解碼的音訊檔案
// ═══════════════════════════════════════════════
const SEGMENT_SECS = 12;   // 每 12 秒送出一段

/** 選出瀏覽器支援的最佳 MIME type */
function getBestMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/ogg;codecs=opus',
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
  ];
  return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function startRecording() {
  if (!STATE.apiKey) {
    new bootstrap.Modal($('apiKeyModal')).show();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    });
    STATE.stream          = stream;
    STATE.isRecording     = true;
    STATE.accTranscript   = '';
    STATE.accTranslations = { zh: '', en: '', ja: '' };
    STATE.recSeconds      = 0;

    // 強制顯示所有即時欄位
    ['rtCardZh','rtCardEn','rtCardJa'].forEach(id => {
      const el = $(id); if (el) el.style.display = '';
    });
    // 清空四欄，顯示等待指示器
    ['rtColOrig','rtColZh','rtColEn','rtColJa'].forEach(id => {
      const el = $(id);
      if (el) el.innerHTML = '<span class="text-muted fst-italic streaming-placeholder">等待語音輸入…</span>';
    });

    $('rtLiveBadge').classList.remove('d-none');
    $('btnStartRec').classList.add('d-none');
    $('btnStopRec').classList.remove('d-none');
    $('rtStatus').textContent = '錄音中';
    $('rtStatus').className   = 'badge bg-danger';
    $('rtTimer').classList.remove('d-none');
    $('waveformIdle').style.display   = 'none';
    $('waveformCanvas').style.display = 'block';

    // 計時器
    STATE.recInterval = setInterval(() => {
      STATE.recSeconds++;
      const m = String(Math.floor(STATE.recSeconds / 60)).padStart(2,'0');
      const s = String(STATE.recSeconds % 60).padStart(2,'0');
      $('rtTimer').textContent = `${m}:${s}`;
    }, 1000);

    // ── AudioContext（僅用於波形視覺化）──
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    STATE.audioCtx  = new AudioCtx();
    await STATE.audioCtx.resume();
    const srcNode = STATE.audioCtx.createMediaStreamSource(stream);
    STATE.analyser = STATE.audioCtx.createAnalyser();
    STATE.analyser.fftSize = 256;
    srcNode.connect(STATE.analyser);
    drawWaveform();

    // ── MediaRecorder（錄音 + 原生編碼）──
    startMediaSegment(stream);

  } catch (err) {
    STATE.isRecording = false;
    showToast('無法存取麥克風：' + err.message, 'danger');
  }
}

/**
 * 開始一段錄音（stop 後自動開始下一段，形成連續分段）
 * 每段都是完整的 webm/ogg 檔案，Groq 可獨立解碼。
 */
function startMediaSegment(stream) {
  if (!STATE.isRecording) return;

  const mimeType = getBestMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (e) {
    recorder = new MediaRecorder(stream);
  }
  STATE.currentRecorder = recorder;
  const chunks = [];

  recorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.onstop = () => {
    if (chunks.length > 0) {
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      console.log(`[FRI] 片段: ${(blob.size/1024).toFixed(1)} KB, type=${blob.type}`);
      if (blob.size > 3000) {
        sendChunkHTTP(blob);
      } else {
        console.log('[FRI] 片段太小，跳過');
      }
    }
    // 若仍在錄音，自動開始下一段
    if (STATE.isRecording) startMediaSegment(stream);
  };

  recorder.start();
  console.log(`[FRI] MediaRecorder 啟動，mimeType=${recorder.mimeType}`);

  // N 秒後停止（觸發 onstop → 送出 → 開始下一段）
  STATE.segmentTimer = setTimeout(() => {
    if (recorder.state === 'recording') recorder.stop();
  }, SEGMENT_SECS * 1000);
}

function stopRecording() {
  if (!STATE.isRecording) return;
  STATE.isRecording = false;

  clearTimeout(STATE.segmentTimer); STATE.segmentTimer = null;
  clearInterval(STATE.recInterval);

  // 停止當前 MediaRecorder（onstop 會送出最後一段）
  if (STATE.currentRecorder && STATE.currentRecorder.state === 'recording') {
    STATE.currentRecorder.stop();
  }
  STATE.currentRecorder = null;

  // 關閉 AudioContext
  if (STATE.audioCtx)  { STATE.audioCtx.close(); STATE.audioCtx = null; }
  STATE.analyser = null;

  // 停止麥克風
  if (STATE.stream) { STATE.stream.getTracks().forEach(t => t.stop()); STATE.stream = null; }

  if (STATE.animId) { cancelAnimationFrame(STATE.animId); STATE.animId = null; }

  $('btnStartRec').classList.remove('d-none');
  $('btnStopRec').classList.add('d-none');
  $('rtStatus').textContent = '已停止';
  $('rtStatus').className   = 'badge bg-secondary';
  $('rtLiveBadge').classList.add('d-none');
  $('waveformIdle').style.display   = '';
  $('waveformCanvas').style.display = 'none';

  // 移除處理中動畫
  const rtGrid = $('rtMultiLang');
  if (rtGrid) rtGrid.classList.remove('rt-processing');

  // 等待最後一段 onstop 觸發後才彙整結果（delay 1.5s）
  setTimeout(() => {
    if (STATE.accTranscript) {
      ['rtCardZh','rtCardEn','rtCardJa'].forEach(id => {
        const el = $(id); if (el) el.style.display = '';
      });
      showResults({ original: STATE.accTranscript, translations: STATE.accTranslations });
    }
  }, 1500);
}

/** HTTP POST 上傳音訊分段（webm / ogg / wav 皆可） */
async function sendChunkHTTP(blob) {
  // 增加活躍送出計數
  STATE._sendingCount = (STATE._sendingCount || 0) + 1;
  try {
    if (STATE.isRecording) {
      $('rtStatus').textContent = '轉譯中…';
      $('rtStatus').className   = 'badge bg-warning text-dark';
    }
    // 在即時欄顯示處理中指示
    const rtGrid = $('rtMultiLang');
    if (rtGrid) rtGrid.classList.add('rt-processing');

    // 根據 blob 的 MIME type 決定副檔名，讓後端正確識別格式
    const mimeToExt = {
      'audio/webm': 'webm', 'audio/ogg': 'ogg',
      'audio/mp4': 'mp4',   'audio/wav': 'wav',
      'audio/mpeg': 'mp3',
    };
    const baseMime = (blob.type || 'audio/webm').split(';')[0].trim();
    const ext = mimeToExt[baseMime] || 'webm';
    const filename = `chunk.${ext}`;

    const form = new FormData();
    form.append('file',      blob, filename);
    form.append('api_key',   STATE.apiKey);
    form.append('languages', getSelectedLangs().join(','));

    console.log(`[FRI] 送出 WAV: ${blob.size} bytes`);
    const res  = await fetch('/api/transcribe_rt', { method: 'POST', body: form });
    const data = await res.json();

    if (data.error && !data.skip) {
      showToast('轉譯錯誤：' + data.error, 'danger');
      console.error('[FRI] Groq error:', data.error);
      return;
    }
    if (data.skip) {
      console.log('[FRI] 片段被跳過:', data.error);
      return;
    }

    const text = (data.text || '').trim();
    if (text) {
      STATE.accTranscript += (STATE.accTranscript ? '\n' : '') + text;
      setColContent('rtColOrig', STATE.accTranscript);
      updateWordCount(STATE.accTranscript);
    }

    for (const [lang, val] of Object.entries(data.translations || {})) {
      if (val && val.trim()) {
        STATE.accTranslations[lang] = STATE.accTranslations[lang]
          ? STATE.accTranslations[lang] + '\n' + val : val;
        const colMap = { zh:'rtColZh', en:'rtColEn', ja:'rtColJa' };
        if (colMap[lang]) setColContent(colMap[lang], STATE.accTranslations[lang]);
      }
    }

    if (text) {
      const ts = data.timestamp || '';
      showToast(`[${ts}] 片段轉譯完成`, 'success');
    }

  } catch (err) {
    console.error('[FRI] sendChunkHTTP error:', err);
    showToast('傳送失敗：' + err.message, 'danger');
  } finally {
    STATE._sendingCount = Math.max(0, (STATE._sendingCount || 1) - 1);
    if (STATE._sendingCount === 0) {
      const rtGrid = $('rtMultiLang');
      if (rtGrid) rtGrid.classList.remove('rt-processing');
    }
    if (STATE.isRecording) {
      $('rtStatus').textContent = '錄音中';
      $('rtStatus').className   = 'badge bg-danger';
    }
  }
}

// ─────────────────────────────────────────────
// 波形視覺化（共用同一個 audioCtx）
// ─────────────────────────────────────────────
function setupWaveform(stream) {
  // 已在 startRecording 建立 audioCtx 與 analyser，這裡僅啟動繪製
  drawWaveform();
}

function drawWaveform() {
  const canvas  = $('waveformCanvas');
  const ctx     = canvas.getContext('2d');
  const analyser = STATE.analyser;
  if (!analyser) return;

  canvas.width  = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  const bufLen  = analyser.frequencyBinCount;
  const dataArr = new Uint8Array(bufLen);

  function draw() {
    STATE.animId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArr);

    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const barW  = (canvas.width / bufLen) * 2.5;
    let   x     = 0;
    for (let i = 0; i < bufLen; i++) {
      const barH = (dataArr[i] / 255) * canvas.height * 0.85;
      const hue  = 160 + (i / bufLen) * 40;
      ctx.fillStyle = `hsl(${hue}, 80%, 55%)`;
      ctx.fillRect(x, canvas.height - barH, barW, barH);
      x += barW + 1;
    }
  }
  draw();
}

function stopWaveform() {
  // audioCtx 由 stopRecording 負責關閉，這裡僅停止動畫
  if (STATE.animId) { cancelAnimationFrame(STATE.animId); STATE.animId = null; }
}

// ─────────────────────────────────────────────
// File upload
// ─────────────────────────────────────────────
const dropZone = $('dropZone');
const fileInput = $('audioFile');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setSelectedFile(fileInput.files[0]);
});

function setSelectedFile(file) {
  $('fileName').textContent = file.name;
  $('fileSize').textContent = formatBytes(file.size);
  $('fileInfo').classList.remove('d-none');
  $('btnTranscribe').disabled = false;
  $('btnTranscribe').dataset.file = file.name;
  // Store reference
  $('btnTranscribe')._file = file;
}

$('clearFile').addEventListener('click', () => {
  fileInput.value = '';
  $('fileInfo').classList.add('d-none');
  $('btnTranscribe').disabled = true;
  delete $('btnTranscribe')._file;
});

$('btnTranscribe').addEventListener('click', async () => {
  const file = $('btnTranscribe')._file;
  if (!file) return;
  if (!STATE.apiKey) {
    new bootstrap.Modal($('apiKeyModal')).show();
    return;
  }

  const langs = getSelectedLangs();
  if (!langs.length) {
    showToast('請至少選擇一種輸出語言', 'danger');
    return;
  }

  // Show progress
  $('uploadProgress').classList.remove('d-none');
  $('btnTranscribe').disabled = true;
  animateProgress(0, 30, 1500);

  const formData = new FormData();
  formData.append('api_key', STATE.apiKey);
  formData.append('file', file);
  formData.append('languages', langs.join(','));

  try {
    animateProgress(30, 80, 8000);
    $('progressLabel').textContent = '語音轉譯中（Groq Whisper）…';

    const resp = await fetch('/api/transcribe', { method: 'POST', body: formData });
    const data = await resp.json();

    animateProgress(80, 100, 500);

    if (!resp.ok || data.error) {
      throw new Error(data.error || '轉譯失敗');
    }

    STATE.currentRecId = data.id;
    showResults(data);
    showToast('轉譯完成！', 'success');

  } catch (err) {
    showToast('錯誤：' + err.message, 'danger');
  } finally {
    setTimeout(() => {
      $('uploadProgress').classList.add('d-none');
      $('btnTranscribe').disabled = false;
      $('progressBar').style.width = '0%';
    }, 800);
  }
});

function animateProgress(from, to, duration) {
  const bar = $('progressBar');
  const pct = $('progressPct');
  const step = (to - from) / (duration / 50);
  let current = from;
  const id = setInterval(() => {
    current = Math.min(current + step, to);
    bar.style.width  = current + '%';
    pct.textContent  = Math.round(current) + '%';
    if (current >= to) clearInterval(id);
  }, 50);
}

// ─────────────────────────────────────────────
// AI Summary
// ─────────────────────────────────────────────
$('btnAiSummary').addEventListener('click', async () => {
  if (!STATE.apiKey) {
    new bootstrap.Modal($('apiKeyModal')).show();
    return;
  }
  const text = STATE.resultData?.original || STATE.resultData?.orig_text || '';
  if (!text.trim()) {
    showToast('尚無逐字稿可供摘要', 'danger');
    return;
  }

  $('summaryContent').innerHTML = '';
  $('summarySpinner').classList.remove('d-none');

  try {
    const resp = await fetch('/api/summarize', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ api_key: STATE.apiKey, text }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) throw new Error(data.error);
    renderSummary(data.summary);
    if (STATE.resultData) STATE.resultData.summary = data.summary;
  } catch (err) {
    showToast('摘要失敗：' + err.message, 'danger');
    $('summaryContent').textContent = '摘要生成失敗，請再試一次。';
  } finally {
    $('summarySpinner').classList.add('d-none');
  }
});

// ─────────────────────────────────────────────
// Copy / Save
// ─────────────────────────────────────────────
$('btnCopyAll').addEventListener('click', () => {
  if (!STATE.resultData) return;
  const d = STATE.resultData;
  // 只輸出有內容的欄位
  const sections = [
    ['原始逐字稿',   d.original  || d.orig_text || ''],
    ['繁體中文翻譯', d.translations?.zh || d.zh_text || ''],
    ['English',      d.translations?.en || d.en_text || ''],
    ['日本語翻訳',   d.translations?.ja || d.ja_text || ''],
  ].filter(([, v]) => v.trim());
  const text = sections
    .map(([label, val]) => `【${label}】\n${val}`)
    .join('\n\n━━━━━━━━━━━━━━━━━━━━━━\n\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('已複製所有語言內容 ✓', 'success'))
    .catch(() => showToast('複製失敗', 'danger'));
});

$('btnCopySummary').addEventListener('click', () => {
  const text = $('summaryContent').innerText;
  if (!text.trim()) { showToast('尚無摘要可複製', 'danger'); return; }
  navigator.clipboard.writeText(text)
    .then(() => showToast('摘要已複製', 'success'))
    .catch(() => showToast('複製失敗', 'danger'));
});

$('btnSaveTxt').addEventListener('click', () => {
  if (STATE.currentRecId) {
    window.location.href = `/api/export/${STATE.currentRecId}`;
  } else if (STATE.resultData) {
    const d = STATE.resultData;
    const content = buildExportText(d);
    downloadText(content, 'fri_transcript.txt');
  } else {
    showToast('尚無資料可儲存', 'danger');
  }
});

function buildExportText(d) {
  return [
    '╔══════════════════════════════════════════════════╗',
    '║  水試所多國語音轉譯小幫手 - 轉譯報告              ║',
    '║  農業部水產試驗所 Fisheries Research Institute   ║',
    '╚══════════════════════════════════════════════════╝',
    '',
    '建立時間：' + new Date().toLocaleString('zh-TW'),
    '',
    '━━━ 原始逐字稿 ━━━',
    d.original || d.orig_text || '',
    '',
    '━━━ 中文翻譯 ━━━',
    d.translations?.zh || d.zh_text || '(未翻譯)',
    '',
    '━━━ English Translation ━━━',
    d.translations?.en || d.en_text || '(not translated)',
    '',
    '━━━ 日本語翻訳 ━━━',
    d.translations?.ja || d.ja_text || '(未翻訳)',
    '',
    '━━━ AI 重點摘要 ━━━',
    $('summaryContent').innerText || '(未生成)',
  ].join('\n');
}

function downloadText(content, filename) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────────────
// History
// ─────────────────────────────────────────────
$('refreshHistory').addEventListener('click', loadHistory);

async function loadHistory() {
  const container = $('historyList');
  container.innerHTML = '<div class="text-center py-3"><div class="spinner-border text-primary"></div></div>';

  try {
    const resp  = await fetch('/api/history');
    const items = await resp.json();

    if (!items.length) {
      container.innerHTML = `
        <div class="text-center text-muted py-4">
          <i class="bi bi-inbox fs-2"></i>
          <p class="mt-2">尚無歷史記錄</p>
        </div>`;
      return;
    }

    container.innerHTML = '';
    items.forEach(item => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML = `
        <div class="history-item-title">
          <i class="bi bi-file-earmark-music me-1 text-primary"></i>
          ${escHtml(item.filename || '即時錄音')}
        </div>
        <div class="history-item-meta">
          <i class="bi bi-clock me-1"></i>${item.created_at} &nbsp;
          <span class="badge bg-light text-dark border">ID #${item.id}</span>
        </div>
        <div class="history-item-preview">${escHtml((item.orig_text || '').slice(0, 100))}…</div>
        <div class="history-actions">
          <button class="btn btn-sm btn-outline-primary py-0" onclick="loadHistoryItem(${item.id})">
            <i class="bi bi-eye"></i>
          </button>
          <a href="/api/export/${item.id}" class="btn btn-sm btn-outline-success py-0">
            <i class="bi bi-download"></i>
          </a>
          <button class="btn btn-sm btn-outline-danger py-0" onclick="deleteHistoryItem(${item.id}, this)">
            <i class="bi bi-trash"></i>
          </button>
        </div>`;
      div.querySelector('.history-item-title').addEventListener('click', () => loadHistoryItem(item.id));
      container.appendChild(div);
    });

  } catch (err) {
    container.innerHTML = `<div class="text-danger">載入失敗：${err.message}</div>`;
  }
}

window.loadHistoryItem = async function(id) {
  try {
    const resp  = await fetch('/api/history');
    const items = await resp.json();
    const item  = items.find(i => i.id === id);
    if (!item) return;

    STATE.currentRecId = id;
    STATE.resultData   = {
      original:     item.orig_text,
      translations: { zh: item.zh_text, en: item.en_text, ja: item.ja_text },
      summary:      item.summary,
    };

    // Switch to realtime tab view to show results
    $$('.main-tabs .nav-link').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === 'realtime');
    });
    $$('.tab-pane-content').forEach(p => p.classList.add('d-none'));
    $('tab-realtime').classList.remove('d-none');
    setColContent('rtColOrig', item.orig_text || '');
    showResults(STATE.resultData);
    showToast('已載入歷史記錄 #' + id, 'info');
  } catch (err) {
    showToast('載入失敗：' + err.message, 'danger');
  }
};

window.deleteHistoryItem = async function(id, btn) {
  if (!confirm('確定要刪除此記錄？')) return;
  try {
    await fetch(`/api/history/${id}`, { method: 'DELETE' });
    btn.closest('.history-item').remove();
    showToast('記錄已刪除', 'success');
  } catch (err) {
    showToast('刪除失敗', 'danger');
  }
};

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
function updateWordCount(text) {
  $('statWords').textContent = text ? text.replace(/\s+/g, ' ').trim().split(' ').length : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024)       return bytes + ' B';
  if (bytes < 1048576)    return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
