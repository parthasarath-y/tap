# TakeAprinT — Backend Setup Guide

## Architecture

```
Browser (index.html + script.js)
        │  POST /api/upload  (files + options)
        ▼
print_server.py  ──── saves to /uploads/
        │               writes pending job to print_jobs.json
        │  returns { job_id, grand_total }
        ▼
Payment Gateway (Razorpay / Stripe)
        │  POST /api/webhook/payment  { job_id, payment_id, status:"paid" }
        ▼
print_server.py  ──── marks job "queued"
        │               spawns background thread
        ▼
process_print_job()
    1. LibreOffice → PDF conversion
    2. pdftk / ghostscript → page split (color range vs BW range)
    3. lpr -P Printer_Color  (color pages)
    4. lpr -P Printer_BW     (bw pages)
    5. decrement paper_counter.json
    6. rm temp files + uploads
    7. update print_jobs.json → "completed"
```

---

## 1. System Prerequisites

```bash
sudo apt update
sudo apt install -y \
    python3 python3-pip \
    libreoffice \
    cups cups-client \
    pdftk \
    ghostscript
```

---

## 2. Python Setup

```bash
cd /path/to/TakeAprinT
pip3 install -r requirements.txt
```

---

## 3. CUPS Printer Setup

```bash
# Start CUPS
sudo systemctl enable cups && sudo systemctl start cups

# List detected printers
lpstat -a

# If printers don't appear, add them via CUPS web UI:
# http://localhost:631
```

Update printer names in `print_server.py`:
```python
COLOR_PRINTER = "Your_Color_Printer_Name"   # from lpstat -a
MONO_PRINTER  = "Your_BW_Printer_Name"
```

Or use environment variables:
```bash
export COLOR_PRINTER="HP_Color_LaserJet"
export MONO_PRINTER="HP_LaserJet_BW"
```

---

## 4. Running the Server

```bash
# Development
python3 print_server.py

# Production (gunicorn)
pip3 install gunicorn
gunicorn -w 4 -b 0.0.0.0:3000 print_server:app

# systemd service (recommended)
sudo cp takeaprint.service /etc/systemd/system/
sudo systemctl enable takeaprint
sudo systemctl start takeaprint
```

### systemd service file (`takeaprint.service`):
```ini
[Unit]
Description=TakeAprinT Print Server
After=network.target cups.service

[Service]
WorkingDirectory=/path/to/TakeAprinT
ExecStart=/usr/bin/python3 /path/to/TakeAprinT/print_server.py
Restart=always
RestartSec=5
Environment=COLOR_PRINTER=Printer_Color
Environment=MONO_PRINTER=Printer_BW
Environment=WEBHOOK_SECRET=your_secret_here

[Install]
WantedBy=multi-user.target
```

---

## 5. Payment Gateway Integration

### Razorpay (recommended for India)

**Frontend — after upload, create Razorpay order:**
```javascript
// After /api/upload returns job_id and grand_total:
const options = {
  key: "rzp_live_xxxx",
  amount: Math.round(grandTotal * 100),  // paise
  currency: "INR",
  name: "TakeAprinT",
  description: `Print Job ${jobId}`,
  handler: function (response) {
    // Payment successful — backend webhook fires automatically
    // Poll /api/job/{jobId} to track print status
    pollJobStatus(jobId);
  },
  notes: { job_id: jobId },
};
const rzp = new Razorpay(options);
rzp.open();
```

**Backend webhook** — Razorpay calls `POST /api/webhook/payment`:
```python
# In print_server.py, replace the signature check with Razorpay's HMAC:
import hmac, hashlib

razorpay_secret = "your_razorpay_webhook_secret"
received_sig    = request.headers.get("X-Razorpay-Signature", "")
body            = request.get_data()
expected        = hmac.new(razorpay_secret.encode(),
                            body, hashlib.sha256).hexdigest()
if not hmac.compare_digest(received_sig, expected):
    return jsonify(success=False, message="Invalid signature"), 403
```

Razorpay sends:
```json
{
  "event": "payment.captured",
  "payload": {
    "payment": { "entity": { "notes": { "job_id": "..." }, "id": "pay_xxx" } }
  }
}
```

Adapt `payment_webhook()` to parse Razorpay's payload format.

---

## 6. Standalone Print Worker (alternative to server threads)

```bash
# Run as a daemon - polls print_jobs.json every 5 seconds
python3 print_worker.py

# One-shot (useful in cron)
python3 print_worker.py --once

# Cron every minute:
* * * * * cd /path/to/TakeAprinT && python3 print_worker.py --once >> worker_cron.log 2>&1
```

---

## 7. Admin CLI

```bash
# List all jobs
python3 admin.py jobs

# Inspect a job
python3 admin.py job <uuid>

# Re-queue a failed job
python3 admin.py retry <uuid>

# Check / refill paper
python3 admin.py paper
python3 admin.py paper --set --color 500 --bw 1000

# Check CUPS printer status
python3 admin.py printers

# Simulate payment for testing (requires server running)
python3 admin.py simulate <uuid>
```

---

## 8. API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/upload` | Upload files, create pending job |
| POST | `/api/webhook/payment` | Payment gateway callback |
| GET  | `/api/job/<id>` | Poll job status |
| GET  | `/api/jobs` | List all jobs (admin) |
| GET  | `/api/paper` | Paper count (admin) |
| POST | `/api/paper` | Update paper count (admin) |
| GET  | `/api/printers` | CUPS printer status |
| GET  | `/api/health` | Health check |

### Upload request (multipart/form-data):
```
files[]  : binary file(s)
options  : JSON string — [{ name, printType, copies, pages, pageCount }]
```

### Webhook body:
```json
{ "job_id": "uuid", "payment_id": "pay_xxx", "status": "paid", "signature": "hex" }
```

### Job status response:
```json
{
  "success": true,
  "job": {
    "job_id": "...",
    "status": "completed",
    "grand_total": 52.5,
    "total_color_pages": 3,
    "total_bw_pages": 12,
    "paper_after": { "color": 497, "bw": 488 }
  }
}
```

---

## 9. File Structure

```
TakeAprinT/
├── index.html
├── style.css
├── script.js
├── print_server.py      ← Flask API server
├── print_worker.py      ← Standalone poll worker
├── admin.py             ← CLI admin tool
├── requirements.txt
├── README.md
├── print_jobs.json      ← auto-created, job persistence
├── paper_counter.json   ← auto-created, paper tracking
├── server.log           ← auto-created
├── worker.log           ← auto-created
├── uploads/             ← auto-created, temp file storage
└── temp_print/          ← auto-created, cleaned after each job
```

---

## 10. Power-Cut Recovery

On startup, `print_server.py` calls `recover_interrupted_jobs()` which:
- Finds any job with status `"queued"` or `"processing"`
- Re-queues them automatically
- Staggers restarts 1 second apart to avoid CUPS flooding

The same recovery is available in `print_worker.py` — it simply picks up
any `"queued"` job on each poll cycle.

---

## Pricing (edit in print_server.py)

```python
COLOR_PRICE = 10.50   # ₹ per color page
BW_PRICE    =  1.50   # ₹ per B&W page
```
# tap
