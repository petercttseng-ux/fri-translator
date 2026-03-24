"""
水試所多國語音轉譯小幫手
農業部水產試驗所 - Fisheries Research Institute
Multilingual Speech Translation Assistant
"""

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

app = Flask(__name__)
app.secret_key = os.environ.get('SECRET_KEY', secrets.token_hex(32))
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

DATABASE = 'instance/users.db'


# ─────────────────────────────────────────────
# Database helpers
# ─────────────────────────────────────────────

def get_db():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    os.makedirs('instance', exist_ok=True)
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


def do_transcribe(client: Groq, file_path: str, fast: bool = False) -> str:
    model = WHISPER_TURBO if fast else WHISPER_MODEL
    with open(file_path, 'rb') as f:
        result = client.audio.transcriptions.create(
            model=model,
            file=f,
            response_format='text',
        )
    return result if isinstance(result, str) else result.text


def do_translate(client: Groq, text: str, target_lang: str) -> str:
    if not text.strip():
        return ''
    lang_name = LANG_NAMES.get(target_lang, target_lang)
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


def do_summarize(client: Groq, text: str) -> str:
    if not text.strip():
        return ''
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
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not username or not password:
            return render_template('login.html', error='請填寫所有欄位')

        conn = get_db()
        user = conn.execute(
            'SELECT * FROM users WHERE username = ?', (username,)
        ).fetchone()
        conn.close()

        if user and user['password'] == hash_password(password):
            session.clear()
            session['user_id'] = user['id']
            session['username'] = user['username']
            return redirect(url_for('dashboard'))

        return render_template('login.html', error='帳號或密碼錯誤')

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
    with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
        f.save(tmp.name)
        tmp_path = tmp.name

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
        with tempfile.NamedTemporaryFile(delete=False, suffix='.webm') as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        try:
            client = Groq(api_key=api_key)
            orig = do_transcribe(client, tmp_path, fast=True)

            translations = {}
            for lang in langs:
                if lang in LANG_NAMES:
                    translations[lang] = do_translate(client, orig, lang)

            emit('transcription_result', {
                'text': orig,
                'translations': translations,
                'timestamp': datetime.now().strftime('%H:%M:%S'),
            })
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

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
