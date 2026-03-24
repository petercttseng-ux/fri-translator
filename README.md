# 🐟 水試所多國語音轉譯小幫手

**農業部水產試驗所 · Fisheries Research Institute**
Multilingual Speech Translation Assistant

---

## 功能特色

| 功能 | 說明 |
|------|------|
| 🎤 即時錄音轉譯 | 麥克風即時擷取，分段送至 Groq Whisper 轉譯 |
| 📁 上傳音訊檔案 | 支援 MP3/WAV/M4A/OGG/FLAC/WebM/MP4 |
| 🌏 多語翻譯 | 繁體中文、English、日本語 |
| 🤖 AI 重點摘要 | Groq LLaMA 自動摘錄重點與關鍵詞 |
| 💾 匯出儲存 | 複製或下載為 .txt 文字檔 |
| 👤 使用者管理 | 帳號註冊、登入、歷史記錄 |
| 📱 響應式設計 | 支援 PC 及手機瀏覽器 |

---

## 快速啟動

### 1. 安裝相依套件

```bash
pip install -r requirements.txt
```

### 2. 啟動伺服器

```bash
python app.py
```

瀏覽器開啟：`http://localhost:5000`

### 3. 取得 Groq API Key

前往 [console.groq.com](https://console.groq.com) 申請免費 API Key（以 `gsk_` 開頭）。
每次登入系統後，於主畫面輸入 API Key 即可使用。

---

## 部署至 GitHub

```bash
chmod +x setup_github.sh
./setup_github.sh https://github.com/YOUR_USERNAME/fri-translator.git
```

## 雲端部署（Render / Railway）

1. 連接 GitHub 倉庫
2. 設定環境變數：`SECRET_KEY=your-random-secret`
3. 啟動指令（已設定於 `Procfile`）：
   ```
   gunicorn --worker-class eventlet -w 1 app:app
   ```

---

## 技術架構

- **後端**：Python Flask + Flask-SocketIO
- **語音轉譯**：Groq Whisper (`whisper-large-v3`)
- **AI 翻譯/摘要**：Groq LLaMA (`llama-3.3-70b-versatile`)
- **即時通訊**：Socket.IO WebSocket
- **資料庫**：SQLite
- **前端**：Bootstrap 5 + 原生 JavaScript

---

*農業部水產試驗所 © 2025*
