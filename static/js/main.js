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
  mediaRecorder:   null,
  audioChunks:     [],
  recInterval:     null,
  recSeconds:      0,
  accTranscript:   '',   // accumulated real-time transcript
  accTranslations: { zh: '', en: '', ja: '' },
  resultData:      null,
  currentRecId:    null,
  statCount:       0,
  audioCtx:        null,
  analyser:        null,
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
  // Update live display
  $('rtTranscript').textContent = STATE.accTranscript || '…';
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
// Language tab (results)
// ─────────────────────────────────────────────
$$('.result-lang-tabs .nav-link').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.result-lang-tabs .nav-link').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.currentLang = btn.dataset.lang;
    renderLangContent();
  });
});

function renderLangContent() {
  if (!STATE.resultData) return;
  const d = STATE.resultData;
  const map = {
    orig: d.original || d.orig_text || '',
    zh:   d.translations?.zh || d.zh_text || '',
    en:   d.translations?.en || d.en_text || '',
    ja:   d.translations?.ja || d.ja_text || '',
  };
  $('langContent').textContent = map[STATE.currentLang] || '（無內容）';
}

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
  $('resultsPanel').classList.remove('d-none');

  // Reset lang tabs
  $$('.result-lang-tabs .nav-link').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === 'orig');
  });
  STATE.currentLang = 'orig';
  renderLangContent();

  if (data.summary) {
    renderSummary(data.summary);
  } else {
    $('summaryContent').innerHTML = `
      <div class="text-center text-muted py-3">
        <i class="bi bi-stars fs-2"></i>
        <p class="mt-2 mb-0">點擊「AI 重點摘要」按鈕自動生成摘要</p>
      </div>`;
  }

  updateWordCount(data.original || data.orig_text || '');
  STATE.statCount++;
  $('statCount').textContent = STATE.statCount;
  $('resultsPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  $('rtTranscript').innerHTML = '<span class="text-muted fst-italic">逐字稿將在此即時顯示…</span>';
  $('resultsPanel').classList.add('d-none');
  updateWordCount('');
});

async function startRecording() {
  if (!STATE.apiKey) {
    new bootstrap.Modal($('apiKeyModal')).show();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setupWaveform(stream);

    STATE.isRecording    = true;
    STATE.audioChunks    = [];
    STATE.accTranscript  = '';
    STATE.accTranslations = { zh: '', en: '', ja: '' };
    STATE.recSeconds     = 0;

    $('rtTranscript').textContent = '';
    $('rtLiveBadge').classList.remove('d-none');
    $('btnStartRec').classList.add('d-none');
    $('btnStopRec').classList.remove('d-none');
    $('rtStatus').textContent = '錄音中';
    $('rtStatus').className   = 'badge bg-danger';
    $('rtTimer').classList.remove('d-none');
    $('waveformIdle').style.display = 'none';
    $('waveformCanvas').style.display = 'block';

    // Timer
    STATE.recInterval = setInterval(() => {
      STATE.recSeconds++;
      const m = String(Math.floor(STATE.recSeconds / 60)).padStart(2, '0');
      const s = String(STATE.recSeconds % 60).padStart(2, '0');
      $('rtTimer').textContent = `${m}:${s}`;
    }, 1000);

    // MediaRecorder - send chunk every 8 seconds
    const mimeType = getSupportedMimeType();
    STATE.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});

    STATE.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        STATE.audioChunks.push(e.data);
        sendChunk(e.data);
      }
    };

    STATE.mediaRecorder.start(8000); // timeslice: 8s

  } catch (err) {
    showToast('無法存取麥克風：' + err.message, 'danger');
  }
}

function stopRecording() {
  if (!STATE.isRecording) return;
  STATE.isRecording = false;

  if (STATE.mediaRecorder && STATE.mediaRecorder.state !== 'inactive') {
    STATE.mediaRecorder.stop();
    STATE.mediaRecorder.stream.getTracks().forEach(t => t.stop());
  }

  clearInterval(STATE.recInterval);
  stopWaveform();

  $('btnStartRec').classList.remove('d-none');
  $('btnStopRec').classList.add('d-none');
  $('rtStatus').textContent = '已停止';
  $('rtStatus').className   = 'badge bg-secondary';
  $('rtLiveBadge').classList.add('d-none');
  $('waveformIdle').style.display = '';
  $('waveformCanvas').style.display = 'none';

  // Build result from accumulated data
  if (STATE.accTranscript) {
    const data = {
      original: STATE.accTranscript,
      translations: STATE.accTranslations,
    };
    showResults(data);
  }
}

function sendChunk(blob) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const b64 = reader.result.split(',')[1];
    socket.emit('audio_chunk', {
      api_key:   STATE.apiKey,
      audio:     b64,
      languages: getSelectedLangs(),
    });
  };
  reader.readAsDataURL(blob);
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

// Waveform visualizer
function setupWaveform(stream) {
  STATE.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  STATE.analyser  = STATE.audioCtx.createAnalyser();
  STATE.analyser.fftSize = 256;
  const source = STATE.audioCtx.createMediaStreamSource(stream);
  source.connect(STATE.analyser);
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
  if (STATE.animId)  { cancelAnimationFrame(STATE.animId); STATE.animId = null; }
  if (STATE.audioCtx) { STATE.audioCtx.close(); STATE.audioCtx = null; }
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
  const text = [
    '【原始逐字稿】\n' + (d.original || d.orig_text || ''),
    '【中文翻譯】\n'   + (d.translations?.zh || d.zh_text || ''),
    '【English】\n'    + (d.translations?.en || d.en_text || ''),
    '【日本語】\n'     + (d.translations?.ja || d.ja_text || ''),
  ].join('\n\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('已複製至剪貼簿', 'success'))
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
    $('rtTranscript').textContent = item.orig_text || '';
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
