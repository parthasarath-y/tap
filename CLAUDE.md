# CLAUDE.md — TakeAprinT
> Full project context for AI-assisted development.
> Last updated: 2026-04-26

---

## What this project is

**TakeAprinT** is a self-hosted Linux print-as-a-service web app.
Customers upload files on a browser frontend, pay online, and the backend automatically converts and sends the job to a physical printer via CUPS/lpr.

Built for a small print shop running Linux.

---

## File structure

```
TakeAprinT/
├── index.html           ← Frontend UI
├── style.css            ← Frontend styles (existing, not modified)
├── script.js            ← Frontend logic (fully rewritten)
├── print_server.py      ← Flask backend (main server)
├── print_worker.py      ← Standalone poll worker (optional)
├── admin.py             ← CLI admin tool
├── requirements.txt     ← Python deps
├── CLAUDE.md            ← This file
│
├── print_jobs.json      ← Auto-created. Job persistence/recovery log
├── paper_counter.json   ← Auto-created. Tracks remaining paper sheets
├── server.log           ← Auto-created
├── worker.log           ← Auto-created
│
├── uploads/             ← Auto-created. Temp storage for uploaded files
├── temp_print/          ← Auto-created. Cleaned after each job
└── testfiles/           ← Auto-created in TEST_MODE. PDFs saved here instead of printer
```

---

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Vanilla HTML/CSS/JS |
| Backend | Python 3, Flask 3.x |
| PDF page count | pdf.js (frontend), pypdf (backend) |
| Office conversion | LibreOffice headless |
| PDF splitting | pdftk (primary), ghostscript (fallback) |
| Printing | CUPS / lpr |
| File parsing (frontend) | pdf.js, JSZip, SheetJS (XLSX) |

---

## Python dependencies

```
flask>=3.0.0
flask-cors>=4.0.0
werkzeug>=3.0.0
pypdf>=4.0.0
```

Install:
```bash
pip3 install flask flask-cors werkzeug pypdf --break-system-packages
```

System packages:
```bash
sudo apt install libreoffice cups cups-client pdftk ghostscript
```

---

## How to run

```bash
# Development (test mode on by default)
python3 print_server.py

# Production (real CUPS printing)
TAP_TEST_MODE=0 COLOR_PRINTER="HP_Color" MONO_PRINTER="HP_BW" python3 print_server.py
```

Server runs on `http://localhost:3000`.
Frontend served via VS Code Live Server on `http://localhost:5500`.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `TAP_TEST_MODE` | `1` | `1` = save to `testfiles/` instead of lpr |
| `COLOR_PRINTER` | `Printer_Color` | CUPS color printer name |
| `MONO_PRINTER` | `Printer_BW` | CUPS B&W printer name |
| `WEBHOOK_SECRET` | `changeme_secret` | Shared secret for payment webhook HMAC |

---

## Full workflow

```
1. User uploads files on frontend (index.html)
2. User selects print type (B&W / Color), copies, page range per file
3. Order summary modal shows grand total
4. User clicks "Proceed to Pay"
5. Files POST to /api/upload → job created with status "pending_payment"
6. Frontend shows full-screen status overlay (uploading → awaiting payment)
7. Payment gateway calls POST /api/webhook/payment with job_id + payment_id
8. Server marks job "queued", spawns background thread
9. Background thread:
   a. Converts file to PDF via LibreOffice (if not already PDF)
   b. Splits PDF into color-range + BW-range using pdftk/ghostscript
   c. Sends color PDF → COLOR_PRINTER via lpr
   d. Sends BW PDF → MONO_PRINTER via lpr
   e. Decrements paper_counter.json
   f. Cleans up temp files and uploads
   g. Updates job status → "completed"
10. Frontend polls /api/job/<id> every 3s
11. Status overlay updates: queued → printing → done (or error )
12. Done screen shows "Back to Home" button
```

---

## Pricing

Defined in `print_server.py` and `script.js` (both must match):

```python
COLOR_PRICE = 10.50   # ₹ per color page
BW_PRICE    =  1.50   # ₹ per B&W page
```

---

## API endpoints

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/upload` | Upload files, create pending job |
| `POST` | `/api/webhook/payment` | Payment gateway callback |
| `GET` | `/api/job/<id>` | Poll job status |
| `GET` | `/api/jobs` | List all jobs (admin) |
| `GET` | `/api/paper` | Paper remaining |
| `POST` | `/api/paper` | Refill paper count |
| `GET` | `/api/printers` | CUPS printer status |
| `GET` | `/api/health` | Health check |

### Upload request (multipart/form-data)
```
files[]  : binary files
options  : JSON string → [{ name, printType, copies, pages, pageCount }]
```

### Webhook body
```json
{
  "job_id": "uuid",
  "payment_id": "pay_xxx",
  "status": "paid",
  "signature": "sha256_hex"
}
```

### Job status values
```
pending_payment → queued → processing → completed
                                      → completed_with_errors
                                      → failed
```

---

## Admin CLI

```bash
python3 admin.py jobs                          # list all jobs
python3 admin.py job <uuid>                    # inspect a job
python3 admin.py retry <uuid>                  # re-queue failed job
python3 admin.py paper                         # check paper
python3 admin.py paper --set --color 500 --bw 1000
python3 admin.py printers                      # CUPS status
python3 admin.py simulate <uuid>               # fake payment webhook for testing
```

---

## Test mode

`TAP_TEST_MODE=1` (default) skips `lpr` entirely.
Instead, copies the final PDF(s) into `testfiles/` named like:

```
testfiles/
  143022_BW_copy1_<jobid>_document.pdf
  143022_COLOR_copy1_<jobid>_report.pdf
```

Switch off for production:
```bash
TAP_TEST_MODE=0 python3 print_server.py
```

---

## Frontend status overlay states

The full-screen overlay (`showStatusOverlay()` in `script.js`) has these states:

| State | Shown when |
|---|---|
| `uploading` | Files being POSTed to server |
| `waiting` | Upload done, awaiting payment webhook |
| `queued` | Payment received, job in queue |
| `processing` | Actively printing (animated printer icon) |
| `done` | Job completed — green checkmark + "Back to Home" |
| `error` | Any failure — red X + "Try Again" |

---

## Known issues / completed fixes

- **Page reload on modal Proceed** — Root cause was VS Code Live Server auto-reloading when `print_jobs.json` was written to the project folder. Fixed by adding `.vscode/settings.json`:
  ```json
  {
    "liveServer.settings.ignoreFiles": [
      "**/*.json", "**/*.log", "uploads/**", "temp_print/**"
    ]
  }
  ```
- **`flask-cors` missing** — Install with `pip3 install flask-cors --break-system-packages`
- **`lpr` printer not found** — Expected until CUPS printer is configured. Test mode handles this.
- **`datetime.utcnow()` deprecation warnings** — Harmless in Python 3.12, safe to ignore for now.

---

## What's left for production

1. **Razorpay integration** — add JS snippet in `script.js` where the comment block is inside `handlePayment()`:
   ```javascript
   // ── Drop your payment gateway call here ──
   ```
   And update webhook handler in `print_server.py` to parse Razorpay's payload format + verify with their HMAC.

2. **CUPS printer setup**
   ```bash
   sudo systemctl start cups
   # Add printer at http://localhost:631
   lpstat -a   # get exact printer name
   ```

3. **Switch off test mode**
   ```bash
   TAP_TEST_MODE=0 python3 print_server.py
   ```

4. **Homepage URL** — Update the "Back to Home" redirect in `script.js`:
   ```javascript
   window.location.href = '/';   // change if your homepage is different
   ```

5. **Production server** — Replace Flask dev server with gunicorn:
   ```bash
   pip3 install gunicorn
   gunicorn -w 4 -b 0.0.0.0:3000 print_server:app
   ```

6. **systemd service** — So the server survives reboots (template in README.md)
