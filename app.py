"""
水試所多國語音轉譯小幫手
農業部水產試驗所 - Fisheries Research Institute
Multilingual Speech Translation Assistant
"""

import logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s %(levelname)s %(name)s: %(message)s'
)

from flask import Flask, render_template, request, redirect, url_for, session, jsonify, make_response
from flask_socketio import SocketIO, emit
import sqlite3
import hashlib
import os
import re
import tempfile
from groq import Groq
from datetime import datetime
import secrets
import base64
import io
import struct
import threading
import wave

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATABASE = os.path.join(BASE_DIR, 'instance', 'users.db')

# ── 持久化 secret_key（寫入 instance/secret.key，重啟後不變）──
def _load_secret_key():
    key_file = os.path.join(BASE_DIR, 'instance', 'secret.key')
    os.makedirs(os.path.dirname(key_file), exist_ok=True)
    if os.path.exists(key_file):
        with open(key_file, 'r') as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(key_file, 'w') as f:
        f.write(key)
    return key

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY') or _load_secret_key()
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading',
                    logger=False, engineio_logger=False)


# ─────────────────────────────────────────────
# Database helpers
# ─────────────────────────────────────────────

def get_db():
    """每個請求使用獨立連線，WAL 模式支援多執行緒讀寫"""
    conn = sqlite3.connect(DATABASE, check_same_thread=False, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    os.makedirs(os.path.dirname(DATABASE), exist_ok=True)
    conn = get_db()
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        email    TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS transcriptions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL,
        filename    TEXT,
        orig_text   TEXT,
        zh_text     TEXT,
        en_text     TEXT,
        ja_text     TEXT,
        summary     TEXT,
        duration    REAL,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
    )''')
    conn.commit()
    conn.close()


# ─────────────────────────────────────────────
# App lifecycle
# ─────────────────────────────────────────────

_db_initialized = False

@app.before_request
def ensure_db_initialized():
    global _db_initialized
    if not _db_initialized:
        init_db()
        _db_initialized = True

@app.errorhandler(500)
def internal_error(e):
    logging.exception("Internal Server Error: %s", e)
    return render_template('error.html', error=str(e)), 500

@app.errorhandler(Exception)
def handle_exception(e):
    logging.exception("Unhandled Exception: %s", e)
    import traceback
    err_msg = traceback.format_exc()
    if app.debug:
        return f"<pre>ERROR:\n{err_msg}</pre>", 500
    return render_template('error.html', error=str(e)), 500


# ─────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────

def hash_password(pwd):
    return hashlib.sha256(pwd.encode('utf-8')).hexdigest()


def login_required(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        if 'user_id' not in session:
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return decorated


# ─────────────────────────────────────────────
# Groq helpers
# ─────────────────────────────────────────────

LANG_NAMES = {
    'zh': '繁體中文',
    'en': 'English',
    'ja': '日本語',
}

LLM_MODEL = 'llama-3.3-70b-versatile'
WHISPER_MODEL = 'whisper-large-v3'
WHISPER_TURBO = 'whisper-large-v3-turbo'


def _validate_wav(data: bytes) -> bool:
    """驗證 WAV 檔案標頭是否有效"""
    if len(data) < 44:
        return False
    if data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        return False
    if data[12:16] != b'fmt ':
        return False
    return True


def ensure_valid_wav(audio_bytes: bytes) -> bytes:
    """使用 Python wave 模組解析並重新編碼 WAV，確保格式 100% 合規"""
    buf = io.BytesIO(audio_bytes)
    try:
        with wave.open(buf, 'rb') as wf:
            nch   = wf.getnchannels()
            sw    = wf.getsampwidth()
            rate  = wf.getframerate()
            nfr   = wf.getnframes()
            frames = wf.readframes(nfr)
    except Exception as e:
        raise ValueError(f'WAV 解析失敗：{e}（header={audio_bytes[:12].hex()}）')

    if nfr < 800:   # 少於 ~0.05 秒 @ 16kHz
        raise ValueError(f'音訊片段太短（{nfr} frames @ {rate}Hz）')

    out = io.BytesIO()
    with wave.open(out, 'wb') as wf:
        wf.setnchannels(nch)
        wf.setsampwidth(sw)
        wf.setframerate(rate)
        wf.writeframes(frames)
    result = out.getvalue()
    logging.info(f'WAV re-encoded: {len(audio_bytes)}→{len(result)} bytes, '
                 f'{nch}ch {rate}Hz {sw*8}bit {nfr}frames '
                 f'({nfr/rate:.1f}s)')
    return result


def _wav_rms(data: bytes) -> float:
    """計算 WAV 音訊的 RMS 值（偵測是否靜音）"""
    try:
        pcm_start = 44  # 標準 WAV header
        if len(data) <= pcm_start + 100:
            return 0.0
        pcm = data[pcm_start:]
        n_samples = len(pcm) // 2
        if n_samples == 0:
            return 0.0
        total = 0.0
        for i in range(0, min(n_samples * 2, len(pcm)) - 1, 2):
            sample = struct.unpack_from('<h', pcm, i)[0]
            total += sample * sample
        return (total / n_samples) ** 0.5
    except Exception:
        return 1.0  # 無法計算時不阻擋


def do_transcribe_bytes(client: Groq, audio_bytes: bytes, filename: str = 'audio.wav',
                        mime: str = 'audio/wav', fast: bool = False) -> str:
    """直接從記憶體 bytes 送至 Groq Whisper（避免 Windows tempfile 鎖定問題）"""
    model = WHISPER_TURBO if fast else WHISPER_MODEL
    buf = io.BytesIO(audio_bytes)
    result = client.audio.transcriptions.create(
        model=model,
        file=(filename, buf, mime),
        response_format='text',
    )
    return result if isinstance(result, str) else result.text


def do_transcribe(client: Groq, file_path: str, fast: bool = False) -> str:
    model = WHISPER_TURBO if fast else WHISPER_MODEL

    # 檔案大小驗證
    file_size = os.path.getsize(file_path)
    if file_size < 200:
        raise ValueError(f'音訊檔案過小（{file_size} bytes），可能是空白或靜音錄音，請確認麥克風是否正常')
    if file_size > 25 * 1024 * 1024:
        raise ValueError('音訊檔案超過 Groq 25MB 上限，請分段錄音或上傳較短的檔案')

    # 依副檔名對應正確的 MIME type（Groq 必須明確指定）
    ext = os.path.splitext(file_path)[1].lower()
    MIME_MAP = {
        '.wav':  ('audio.wav',  'audio/wav'),
        '.mp3':  ('audio.mp3',  'audio/mpeg'),
        '.mp4':  ('audio.mp4',  'audio/mp4'),
        '.m4a':  ('audio.m4a',  'audio/m4a'),
        '.ogg':  ('audio.ogg',  'audio/ogg'),
        '.webm': ('audio.webm', 'audio/webm'),
        '.flac': ('audio.flac', 'audio/flac'),
        '.opus': ('audio.opus', 'audio/opus'),
        '.mpeg': ('audio.mpeg', 'audio/mpeg'),
        '.mpga': ('audio.mpga', 'audio/mpeg'),
    }
    fname, mime = MIME_MAP.get(ext, ('audio.wav', 'audio/wav'))

    # 讀入記憶體後送出（避免 Windows 檔案鎖定問題）
    with open(file_path, 'rb') as f:
        audio_bytes = f.read()

    return do_transcribe_bytes(client, audio_bytes, fname, mime, fast)


def do_translate(client: Groq, text: str, target_lang: str) -> str:
    if not text.strip():
        return ''
    lang_name = LANG_NAMES.get(target_lang, target_lang)
    try:
        resp = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {
                    'role': 'system',
                    'content': (
                        f'You are a professional translator. '
                        f'Translate the following text into {lang_name}. '
                        'Return only the translation, without any explanation or prefix.'
                    ),
                },
                {'role': 'user', 'content': text},
            ],
            max_tokens=4096,
            temperature=0.3,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        logging.warning(f'Translation to {target_lang} failed: {e}')
        return f'[翻譯失敗: {str(e)[:80]}]'


def do_summarize(client: Groq, text: str) -> str:
    if not text.strip():
        return ''
    try:
        resp = client.chat.completions.create(
            model=LLM_MODEL,
            messages=[
                {
                    'role': 'system',
                    'content': (
                        '你是專業的文件摘要助手，請對以下逐字稿進行重點摘要。\n'
                        '回覆格式：\n'
                        '## 📋 重點摘要\n'
                        '• [重點1]\n'
                        '• [重點2]\n'
                        '（依內容多寡調整，3-8點）\n\n'
                        '## 🔑 關鍵詞\n'
                        '[詞1]、[詞2]、[詞3]…\n\n'
                        '## 📊 主題分類\n'
                        '[分類]\n\n'
                        '請使用繁體中文回覆。'
                    ),
                },
                {'role': 'user', 'content': text},
            ],
            max_tokens=1024,
            temperature=0.5,
        )
        return resp.choices[0].message.content.strip()
    except Exception as e:
        logging.warning(f'Summarize failed: {e}')
        return f'[摘要生成失敗: {str(e)[:80]}]'


# ─────────────────────────────────────────────
# Routes – Auth
# ─────────────────────────────────────────────

@app.route('/')
def index():
    if 'user_id' in session:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))


@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        identifier = request.form.get('username', '').strip()  # 接受帳號或 Email
        password   = request.form.get('password', '')

        if not identifier or not password:
            return render_template('login.html', error='請填寫所有欄位')

        conn = get_db()
        # 同時支援帳號名稱 或 Email 登入
        user = conn.execute(
            'SELECT * FROM users WHERE username = ? OR email = ?',
            (identifier, identifier)
        ).fetchone()
        conn.close()

        if user and user['password'] == hash_password(password):
            session.clear()
            session['user_id']  = user['id']
            session['username'] = user['username']
            return redirect(url_for('dashboard'))

        return render_template('login.html', error='帳號／Email 或密碼錯誤，請確認後重試')

    return render_template('login.html', success=request.args.get('success'))


@app.route('/register', methods=['GET', 'POST'])
def register():
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        email    = request.form.get('email', '').strip()
        password = request.form.get('password', '')
        confirm  = request.form.get('confirm_password', '')

        if not all([username, email, password, confirm]):
            return render_template('register.html', error='請填寫所有欄位')
        if password != confirm:
            return render_template('register.html', error='兩次密碼輸入不一致')
        if len(password) < 6:
            return render_template('register.html', error='密碼至少需要 6 個字元')
        if not re.match(r'^[^@]+@[^@]+\.[^@]+$', email):
            return render_template('register.html', error='電子郵件格式不正確')

        conn = get_db()
        try:
            conn.execute(
                'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
                (username, email, hash_password(password)),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            conn.close()
            return render_template('register.html', error='帳號或電子郵件已被使用')
        conn.close()
        return redirect(url_for('login', success='註冊成功，請登入'))

    return render_template('register.html')


@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login'))


# ─────────────────────────────────────────────
# Routes – Dashboard
# ─────────────────────────────────────────────

@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html', username=session.get('username'))


# ─────────────────────────────────────────────
# Routes – API
# ─────────────────────────────────────────────

@app.route('/api/transcribe', methods=['POST'])
@login_required
def api_transcribe():
    api_key = request.form.get('api_key', '').strip()
    if not api_key:
        return jsonify({'error': '請輸入 Groq API Key'}), 400

    if 'file' not in request.files or request.files['file'].filename == '':
        return jsonify({'error': '請選擇音訊檔案'}), 400

    f = request.files['file']
    langs = [l.strip() for l in request.form.get('languages', 'zh,en,ja').split(',') if l.strip()]

    ext = os.path.splitext(f.filename)[1].lower() or '.wav'
    # Windows: 先關閉 tempfile 再寫入，避免檔案鎖定
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
    tmp_path = tmp.name
    tmp.close()
    f.save(tmp_path)

    try:
        client = Groq(api_key=api_key)
        orig = do_transcribe(client, tmp_path)

        translations = {}
        for lang in langs:
            if lang in LANG_NAMES:
                translations[lang] = do_translate(client, orig, lang)

        summary = do_summarize(client, translations.get('zh', orig) or orig)

        conn = get_db()
        conn.execute(
            '''INSERT INTO transcriptions
               (user_id, filename, orig_text, zh_text, en_text, ja_text, summary)
               VALUES (?, ?, ?, ?, ?, ?, ?)''',
            (
                session['user_id'], f.filename, orig,
                translations.get('zh', ''),
                translations.get('en', ''),
                translations.get('ja', ''),
                summary,
            ),
        )
        conn.commit()
        rec_id = conn.execute('SELECT last_insert_rowid()').fetchone()[0]
        conn.close()

        return jsonify({
            'success': True,
            'id': rec_id,
            'original': orig,
            'translations': translations,
            'summary': summary,
        })

    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


@app.route('/api/transcribe_rt', methods=['POST'])
@login_required
def api_transcribe_rt():
    """即時錄音分段轉譯端點 — 支援 webm/ogg（MediaRecorder）與 wav"""
    api_key = request.form.get('api_key', '').strip()
    if not api_key:
        return jsonify({'error': '請輸入 Groq API Key'}), 400

    if 'file' not in request.files:
        return jsonify({'error': '未收到音訊檔案'}), 400

    f = request.files['file']
    audio_bytes = f.read()
    if not audio_bytes or len(audio_bytes) < 500:
        return jsonify({'error': '音訊檔案為空', 'skip': True}), 200

    langs = [l.strip() for l in request.form.get('languages', 'zh,en,ja').split(',') if l.strip()]
    file_size = len(audio_bytes)
    magic = audio_bytes[:4]
    logging.info(f"RT chunk: {file_size} bytes, magic={magic!r}, "
                 f"filename={f.filename!r}, langs={langs}")

    # ── 格式偵測（依 magic bytes）──
    if magic == b'RIFF':
        # WAV：用 Python wave 模組重新編碼，確保格式合規
        try:
            audio_bytes = ensure_valid_wav(audio_bytes)
        except ValueError as e:
            logging.warning(f"WAV invalid, skip: {e}")
            return jsonify({'error': str(e), 'skip': True}), 200
        # 靜音偵測
        rms = _wav_rms(audio_bytes)
        logging.info(f"WAV RMS={rms:.1f}")
        if rms < 30:
            return jsonify({'error': '偵測到靜音，跳過', 'skip': True}), 200
        fname, mime = 'audio.wav', 'audio/wav'

    elif magic == b'OggS':
        fname, mime = 'audio.ogg', 'audio/ogg'

    elif magic[:4] in (b'\x1aE\xdf\xa3', b'\x1aE\xdf\xa4'):   # EBML/WebM
        fname, mime = 'audio.webm', 'audio/webm'

    elif len(audio_bytes) > 8 and audio_bytes[4:8] == b'ftyp':
        fname, mime = 'audio.mp4', 'audio/mp4'

    else:
        # 依上傳檔名推測
        fn = (f.filename or 'chunk.webm').lower()
        if fn.endswith('.ogg'):
            fname, mime = 'audio.ogg', 'audio/ogg'
        elif fn.endswith('.mp4') or fn.endswith('.m4a'):
            fname, mime = 'audio.mp4', 'audio/mp4'
        elif fn.endswith('.wav'):
            fname, mime = 'audio.wav', 'audio/wav'
        else:
            fname, mime = 'audio.webm', 'audio/webm'

    logging.info(f"Sending to Groq: {fname} ({mime}), {len(audio_bytes)} bytes")

    try:
        client = Groq(api_key=api_key)
        orig = do_transcribe_bytes(client, audio_bytes, fname, mime, fast=True)

        if not orig or not orig.strip():
            return jsonify({'text': '', 'translations': {},
                            'timestamp': datetime.now().strftime('%H:%M:%S')})

        translations = {}
        for lang in langs:
            if lang in LANG_NAMES:
                translations[lang] = do_translate(client, orig, lang)

        return jsonify({
            'success': True,
            'text':    orig.strip(),
            'translations': translations,
            'timestamp': datetime.now().strftime('%H:%M:%S'),
        })

    except Exception as e:
        logging.exception("RT transcription error")
        err_msg = str(e)
        if '400' in err_msg and 'could not process' in err_msg:
            logging.error(f"Groq rejected: size={file_size}, magic={magic!r}, "
                          f"fname={fname}, header={audio_bytes[:16].hex()}")
            err_msg = (f'Groq 無法辨識音訊格式（{fname}, {file_size} bytes）。'
                       f'請確認麥克風正常後重新錄音。')
        return jsonify({'error': err_msg}), 500


@app.route('/api/summarize', methods=['POST'])
@login_required
def api_summarize():
    data = request.get_json(force=True)
    api_key = data.get('api_key', '').strip()
    text    = data.get('text', '').strip()

    if not api_key:
        return jsonify({'error': '請輸入 Groq API Key'}), 400
    if not text:
        return jsonify({'error': '請提供文字內容'}), 400

    try:
        client  = Groq(api_key=api_key)
        summary = do_summarize(client, text)
        return jsonify({'summary': summary})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/translate', methods=['POST'])
@login_required
def api_translate():
    data    = request.get_json(force=True)
    api_key = data.get('api_key', '').strip()
    text    = data.get('text', '').strip()
    langs   = data.get('languages', ['zh', 'en', 'ja'])

    if not api_key:
        return jsonify({'error': '請輸入 Groq API Key'}), 400
    if not text:
        return jsonify({'error': '請提供文字內容'}), 400

    try:
        client = Groq(api_key=api_key)
        translations = {}
        for lang in langs:
            if lang in LANG_NAMES:
                translations[lang] = do_translate(client, text, lang)
        return jsonify({'translations': translations})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/history')
@login_required
def api_history():
    conn = get_db()
    rows = conn.execute(
        '''SELECT id, filename, orig_text, zh_text, en_text, ja_text, summary, created_at
           FROM transcriptions
           WHERE user_id = ?
           ORDER BY created_at DESC
           LIMIT 30''',
        (session['user_id'],),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/history/<int:rec_id>', methods=['DELETE'])
@login_required
def api_delete(rec_id):
    conn = get_db()
    conn.execute(
        'DELETE FROM transcriptions WHERE id = ? AND user_id = ?',
        (rec_id, session['user_id']),
    )
    conn.commit()
    conn.close()
    return jsonify({'success': True})


@app.route('/api/export/<int:rec_id>')
@login_required
def api_export(rec_id):
    conn = get_db()
    row = conn.execute(
        'SELECT * FROM transcriptions WHERE id = ? AND user_id = ?',
        (rec_id, session['user_id']),
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({'error': '記錄不存在'}), 404

    content = f"""╔══════════════════════════════════════════════════════════════╗
║       水試所多國語音轉譯小幫手 - 轉譯報告                      ║
║       農業部水產試驗所 Fisheries Research Institute            ║
╚══════════════════════════════════════════════════════════════╝

建立時間：{row['created_at']}
檔案名稱：{row['filename'] or '即時麥克風錄音'}
記錄編號：#{row['id']}

━━━━━━━━━━━━━━━━━━━━ 原始逐字稿 ━━━━━━━━━━━━━━━━━━━━
{row['orig_text'] or '(無內容)'}

━━━━━━━━━━━━━━━━━━━━ 中文翻譯 ━━━━━━━━━━━━━━━━━━━━━━
{row['zh_text'] or '(未翻譯)'}

━━━━━━━━━━━━━━━━━━━━ English Translation ━━━━━━━━━━━━━━━━━━
{row['en_text'] or '(not translated)'}

━━━━━━━━━━━━━━━━━━━━ 日本語翻訳 ━━━━━━━━━━━━━━━━━━━━━━
{row['ja_text'] or '(未翻訳)'}

━━━━━━━━━━━━━━━━━━━━ AI 重點摘要 ━━━━━━━━━━━━━━━━━━━━
{row['summary'] or '(未生成摘要)'}
"""
    resp = make_response(content)
    resp.headers['Content-Type'] = 'text/plain; charset=utf-8'
    resp.headers['Content-Disposition'] = (
        f'attachment; filename="fri_transcript_{rec_id}.txt"'
    )
    return resp


# ─────────────────────────────────────────────
# WebSocket – Real-time transcription
# ─────────────────────────────────────────────

@socketio.on('audio_chunk')
def ws_audio_chunk(data):
    api_key    = data.get('api_key', '').strip()
    audio_b64  = data.get('audio', '')
    langs      = data.get('languages', ['zh', 'en', 'ja'])

    if not api_key:
        emit('ws_error', {'message': 'API Key 缺失'})
        return
    if not audio_b64:
        emit('ws_error', {'message': '音訊資料缺失'})
        return

    try:
        audio_bytes = base64.b64decode(audio_b64)

        if len(audio_bytes) < 200:
            emit('ws_error', {'message': '音訊資料太短'})
            return

        # 自動偵測格式（WebM magic bytes: 1A 45 DF A3）
        if audio_bytes[:4] in (b'RIFF', b'riff'):
            fname, mime = 'audio.wav', 'audio/wav'
        elif audio_bytes[:4] == b'OggS':
            fname, mime = 'audio.ogg', 'audio/ogg'
        elif audio_bytes[:3] == b'ID3' or audio_bytes[:2] == b'\xff\xfb':
            fname, mime = 'audio.mp3', 'audio/mpeg'
        else:
            fname, mime = 'audio.webm', 'audio/webm'

        client = Groq(api_key=api_key)
        orig = do_transcribe_bytes(client, audio_bytes, fname, mime, fast=True)

        translations = {}
        for lang in langs:
            if lang in LANG_NAMES:
                translations[lang] = do_translate(client, orig, lang)

        emit('transcription_result', {
            'text': orig,
            'translations': translations,
            'timestamp': datetime.now().strftime('%H:%M:%S'),
        })

    except Exception as e:
        emit('ws_error', {'message': str(e)})


@socketio.on('ws_summarize')
def ws_summarize(data):
    api_key = data.get('api_key', '').strip()
    text    = data.get('text', '').strip()

    if not api_key:
        emit('ws_error', {'message': 'API Key 缺失'})
        return

    try:
        client  = Groq(api_key=api_key)
        summary = do_summarize(client, text)
        emit('summary_result', {'summary': summary})
    except Exception as e:
        emit('ws_error', {'message': str(e)})


# ─────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────

if __name__ == '__main__':
    init_db()
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, debug=False, host='0.0.0.0', port=port, allow_unsafe_werkzeug=True)
