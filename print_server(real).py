#!/usr/bin/env python3
"""
TakeAprinT - Print Server Backend
Handles file uploads, payment webhooks, and print job queue.
"""

import os
import json
import time
import uuid
import shutil
import hashlib
import logging
import threading
import subprocess
from datetime import datetime
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
from werkzeug.utils import secure_filename

# ── Config  ──────
BASE_DIR        = Path(__file__).parent
UPLOAD_DIR      = BASE_DIR / "uploads"
TEMP_DIR        = BASE_DIR / "temp_print"
LOG_FILE        = BASE_DIR / "print_jobs.json"
PAPER_STATE     = BASE_DIR / "paper_counter.json"
ALLOWED_EXT     = {".pdf", ".doc", ".docx", ".xls", ".xlsx",
                   ".ppt", ".pptx", ".png", ".jpg", ".jpeg",
                   ".gif", ".bmp", ".txt", ".rtf", ".odt", ".ods", ".odp"}

COLOR_PRINTER   = os.getenv("COLOR_PRINTER",  "Printer_Color")   # lpr -P name
MONO_PRINTER    = os.getenv("MONO_PRINTER",   "Printer_BW")
WEBHOOK_SECRET  = os.getenv("WEBHOOK_SECRET", "changeme_secret")

# Pricing (paise → rupees kept as floats for display only)
COLOR_PRICE     = 10.50   # ₹ per page
BW_PRICE        =  1.50   # ₹ per page

for d in [UPLOAD_DIR, TEMP_DIR]:
    d.mkdir(parents=True, exist_ok=True)

#  Logging  
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(BASE_DIR / "server.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("TakeAprinT")

# ── Flask app  ───
app = Flask(__name__)
CORS(app, origins=["http://localhost:5500", "http://127.0.0.1:5500",
                   "http://localhost:3000", "null"])

# ── JSON persistence helpers 

def load_json(path: Path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception as e:
            log.error("Failed to load %s: %s", path, e)
    return default

def save_json(path: Path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str))
    tmp.replace(path)          # atomic on POSIX

# ── Paper counter  

def get_paper():
    return load_json(PAPER_STATE, {"color": 500, "bw": 500})

def decrement_paper(color_pages: int = 0, bw_pages: int = 0):
    state = get_paper()
    state["color"] = max(0, state["color"] - color_pages)
    state["bw"]    = max(0, state["bw"]    - bw_pages)
    save_json(PAPER_STATE, state)
    log.info("Paper remaining — Color: %d  B&W: %d", state["color"], state["bw"])
    return state

#  Job log helpers 

def load_jobs() -> dict:
    return load_json(LOG_FILE, {})

def save_job(job: dict):
    jobs = load_jobs()
    jobs[job["job_id"]] = job
    save_json(LOG_FILE, jobs)

def update_job(job_id: str, **kwargs):
    jobs = load_jobs()
    if job_id in jobs:
        jobs[job_id].update(kwargs)
        jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()
        save_json(LOG_FILE, jobs)

#  LibreOffice conversion 

def convert_to_pdf(src: Path, dest_dir: Path) -> Path:
    """Convert any supported Office/image format to PDF using LibreOffice."""
    ext = src.suffix.lower()
    if ext == ".pdf":
        dest = dest_dir / src.name
        shutil.copy2(src, dest)
        return dest

    log.info("Converting %s → PDF", src.name)
    result = subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf",
         "--outdir", str(dest_dir), str(src)],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"LibreOffice conversion failed: {result.stderr}")

    pdf_path = dest_dir / (src.stem + ".pdf")
    if not pdf_path.exists():
        raise FileNotFoundError(f"Converted PDF not found: {pdf_path}")
    return pdf_path

#  PDF page splitting 

def extract_page_range(pdf_path: Path, from_page: int, to_page: int,
                        out_path: Path) -> Path:
    """Extract a page range using pdftk (or gs as fallback)."""
    try:
        result = subprocess.run(
            ["pdftk", str(pdf_path),
             "cat", f"{from_page}-{to_page}",
             "output", str(out_path)],
            capture_output=True, text=True, timeout=60
        )
        if result.returncode == 0:
            return out_path
    except FileNotFoundError:
        pass  # pdftk not installed → try ghostscript

    result = subprocess.run(
        ["gs", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite",
         f"-dFirstPage={from_page}", f"-dLastPage={to_page}",
         f"-sOutputFile={out_path}", str(pdf_path)],
        capture_output=True, text=True, timeout=60
    )
    if result.returncode != 0:
        raise RuntimeError(f"Page extraction failed: {result.stderr}")
    return out_path

# ── lpr printing  ─

TEST_MODE  = os.getenv("TAP_TEST_MODE", "1") == "1"   # set to "0" in production
TESTFILES  = BASE_DIR / "testfiles"

def lpr_print(pdf_path: Path, printer: str, copies: int = 1,
              color: bool = True) -> str:
    """
    In TEST_MODE: copies the PDF into /testfiles/ instead of sending to CUPS.
    In production: sends to lpr as normal.
    """
    if TEST_MODE:
        TESTFILES.mkdir(exist_ok=True)
        mode_tag  = "COLOR" if color else "BW"
        timestamp = datetime.now().strftime("%H%M%S")
        for copy in range(1, copies + 1):
            dest_name = f"{timestamp}_{mode_tag}_copy{copy}_{pdf_path.name}"
            dest      = TESTFILES / dest_name
            shutil.copy2(pdf_path, dest)
            log.info("[TEST] Saved → testfiles/%s", dest_name)
        return "test_mode_ok"

    #  Real CUPS path 
    color_opt = "KGSInkType=Color" if color else "KGSInkType=Grayscale"
    cmd = [
        "lpr",
        "-P", printer,
        "-#", str(copies),
        "-o", "media=A4",
        "-o", color_opt,
        "-o", "fit-to-page",
        str(pdf_path)
    ]
    log.info("lpr cmd: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError(f"lpr failed: {result.stderr}")
    return result.stdout.strip()

def get_printer_status(printer: str) -> str:
    """Return CUPS printer status string."""
    try:
        r = subprocess.run(
            ["lpstat", "-p", printer],
            capture_output=True, text=True, timeout=10
        )
        return r.stdout.strip() or "unknown"
    except Exception:
        return "lpstat unavailable"

#core printer working or something
def process_print_job(job_id: str):
    """
    Called in a background thread after payment is confirmed.
    Steps:
      1. Convert each file to PDF (LibreOffice).
      2. Split into color-range PDF + BW-range PDF.
      3. Send color PDF → COLOR_PRINTER, BW PDF → MONO_PRINTER.
      4. Decrement paper counters.
      5. Clean up temp files.
      6. Update job log.
    """
    jobs  = load_jobs()
    job   = jobs.get(job_id)
    if not job:
        log.error("Job %s not found in log", job_id)
        return

    log.info("▶ Starting print job %s", job_id)
    update_job(job_id, status="processing", started_at=datetime.utcnow().isoformat())

    job_tmp = TEMP_DIR / job_id
    job_tmp.mkdir(parents=True, exist_ok=True)

    total_color = 0
    total_bw    = 0
    errors      = []

    try:
        for file_info in job["files"]:
            fname      = file_info["saved_name"]
            src        = UPLOAD_DIR / fname
            copies     = int(file_info.get("copies", 1))
            print_type = file_info.get("printType", "bw")
            pages_str  = file_info.get("pages", "all")

            if not src.exists():
                errors.append(f"File not found: {fname}")
                continue

            #  1. Convert to PDF 
            try:
                pdf = convert_to_pdf(src, job_tmp)
            except Exception as e:
                errors.append(f"Conversion failed for {fname}: {e}")
                log.error("Conversion error: %s", e)
                continue

            #  2. Get total pages 
            page_count = file_info.get("pageCount", 1)

            #  3. Build color + BW PDFs 
            if print_type == "color" and pages_str != "all":
                from_p, to_p = map(int, pages_str.split("-"))
            else:
                from_p, to_p = 1, page_count

            # Color section
            if print_type == "color" and from_p <= to_p:
                color_pdf = job_tmp / f"{src.stem}_color.pdf"
                try:
                    extract_page_range(pdf, from_p, to_p, color_pdf)
                    lpr_print(color_pdf, COLOR_PRINTER, copies=copies, color=True)
                    color_pages = (to_p - from_p + 1) * copies
                    total_color += color_pages
                    log.info("    Color printed: %s (%d pages × %d copies)",
                             fname, to_p - from_p + 1, copies)
                except Exception as e:
                    errors.append(f"Color print failed for {fname}: {e}")
                    log.error("Color print error: %s", e)

                # BW section (remaining pages)
                bw_pages_list = []
                if from_p > 1:
                    bw_pages_list.append((1, from_p - 1))
                if to_p < page_count:
                    bw_pages_list.append((to_p + 1, page_count))

                for bw_from, bw_to in bw_pages_list:
                    bw_pdf = job_tmp / f"{src.stem}_bw_{bw_from}_{bw_to}.pdf"
                    try:
                        extract_page_range(pdf, bw_from, bw_to, bw_pdf)
                        lpr_print(bw_pdf, MONO_PRINTER, copies=copies, color=False)
                        bw_pages = (bw_to - bw_from + 1) * copies
                        total_bw += bw_pages
                        log.info("    BW printed: %s pages %d-%d (%d copies)",
                                 fname, bw_from, bw_to, copies)
                    except Exception as e:
                        errors.append(f"BW print failed {fname} p{bw_from}-{bw_to}: {e}")
                        log.error("BW print error: %s", e)
            else:
                # Pure B&W — whole document
                try:
                    lpr_print(pdf, MONO_PRINTER, copies=copies, color=False)
                    total_bw += page_count * copies
                    log.info("    BW printed: %s (%d pages × %d copies)",
                             fname, page_count, copies)
                except Exception as e:
                    errors.append(f"BW print failed for {fname}: {e}")
                    log.error("BW print error: %s", e)

        #  4. Decrement paper 
        paper = decrement_paper(color_pages=total_color, bw_pages=total_bw)

        #  5. Cleanup temp files 
        shutil.rmtree(job_tmp, ignore_errors=True)
        log.info("Temp files cleaned for job %s", job_id)

        # Also remove originals from upload dir
        for file_info in job["files"]:
            f = UPLOAD_DIR / file_info["saved_name"]
            if f.exists():
                f.unlink()
                log.info("  Removed upload: %s", f.name)

        #  6. Update log 
        final_status = "completed" if not errors else "completed_with_errors"
        update_job(job_id,
                   status=final_status,
                   completed_at=datetime.utcnow().isoformat(),
                   total_color_pages=total_color,
                   total_bw_pages=total_bw,
                   paper_after=paper,
                   errors=errors)
        log.info("    Job %s done — color=%d bw=%d errors=%d",
                 job_id, total_color, total_bw, len(errors))

    except Exception as e:
        log.exception("Unexpected error in job %s: %s", job_id, e)
        update_job(job_id, status="failed", error=str(e))
        shutil.rmtree(job_tmp, ignore_errors=True)

#  API Routes  

@app.route("/api/upload", methods=["POST"])
def upload_files():
    """
    Receives multipart upload from frontend.
    Saves files, creates a pending job record, returns job_id.
    Payment must be confirmed separately via /api/webhook.
    """
    if "files" not in request.files:
        return jsonify(success=False, message="No files provided"), 400

    raw_options = request.form.get("options", "[]")
    try:
        options = json.loads(raw_options)
    except Exception:
        return jsonify(success=False, message="Invalid options JSON"), 400

    files        = request.files.getlist("files")
    job_id       = str(uuid.uuid4())
    saved_files  = []
    grand_total  = 0.0

    for i, f in enumerate(files):
        original = secure_filename(f.filename or "unknown")
        ext      = Path(original).suffix.lower()
        if ext not in ALLOWED_EXT:
            return jsonify(success=False,
                           message=f"File type {ext} not allowed"), 400

        # Save with unique name to avoid collisions
        saved_name = f"{job_id}_{i}_{original}"
        dest       = UPLOAD_DIR / saved_name
        f.save(str(dest))

        # Merge options
        opt         = options[i] if i < len(options) else {}
        pages       = opt.get("pages", "all")
        print_type  = opt.get("printType", "bw")
        copies      = int(opt.get("copies", 1))
        page_count  = int(opt.get("pageCount", 1))

        if print_type == "color" and pages != "all":
            fp, tp    = map(int, pages.split("-"))
            color_pgs = (tp - fp + 1) * copies
            bw_pgs    = ((fp - 1) + (page_count - tp)) * copies
        else:
            color_pgs = 0
            bw_pgs    = page_count * copies

        file_total  = (color_pgs * COLOR_PRICE) + (bw_pgs * BW_PRICE)
        grand_total += file_total

        saved_files.append({
            "original_name": original,
            "saved_name":    saved_name,
            "printType":     print_type,
            "copies":        copies,
            "pages":         pages,
            "pageCount":     page_count,
            "colorPages":    color_pgs,
            "bwPages":       bw_pgs,
            "fileTotal":     round(file_total, 2),
        })

    job = {
        "job_id":        job_id,
        "status":        "pending_payment",
        "created_at":    datetime.utcnow().isoformat(),
        "updated_at":    datetime.utcnow().isoformat(),
        "files":         saved_files,
        "grand_total":   round(grand_total, 2),
        "payment_id":    None,
    }
    save_job(job)
    log.info(" Job %s created — %d files — ₹%.2f", job_id, len(files), grand_total)

    return jsonify(
        success=True,
        job_id=job_id,
        grand_total=round(grand_total, 2),
        files=saved_files,
        message="Files uploaded. Awaiting payment."
    )


@app.route("/api/webhook/payment", methods=["POST"])
def payment_webhook():
    """
    Razorpay / Stripe / any gateway calls this after successful payment.
    Expected JSON body:
      { "job_id": "...", "payment_id": "...", "signature": "...", "status": "paid" }
    """
    #  Signature verification 
    data = request.get_json(force=True, silent=True) or {}
    log.info("  Webhook received: %s", json.dumps(data))

    job_id     = data.get("job_id")
    payment_id = data.get("payment_id", "")
    status     = data.get("status", "")
    signature  = data.get("signature", "")

    # Simple HMAC-style verification (replace with gateway SDK in production)
    expected = hashlib.sha256(
        f"{job_id}:{payment_id}:{WEBHOOK_SECRET}".encode()
    ).hexdigest()

    if signature and signature != expected:
        log.warning("  Invalid webhook signature for job %s", job_id)
        return jsonify(success=False, message="Invalid signature"), 403

    if status != "paid":
        log.info("Payment status not 'paid' (%s) for job %s", status, job_id)
        return jsonify(success=True, message="Non-payment event ignored")

    #  Find job 
    jobs = load_jobs()
    if job_id not in jobs:
        log.error("Webhook: job %s not found", job_id)
        return jsonify(success=False, message="Job not found"), 404

    job = jobs[job_id]
    if job["status"] != "pending_payment":
        log.warning("Job %s already in status: %s", job_id, job["status"])
        return jsonify(success=True, message="Already processed")

    #  Mark paid and queue 
    update_job(job_id,
               status="queued",
               payment_id=payment_id,
               paid_at=datetime.utcnow().isoformat())
    log.info("Payment confirmed for job %s — queuing print", job_id)

    # Start print worker in background thread
    t = threading.Thread(target=process_print_job, args=(job_id,), daemon=True)
    t.start()

    return jsonify(success=True, message="Job queued for printing")


@app.route("/api/job/<job_id>", methods=["GET"])
def get_job(job_id):
    """Poll job status from the frontend."""
    jobs = load_jobs()
    job  = jobs.get(job_id)
    if not job:
        return jsonify(success=False, message="Job not found"), 404
    # Strip internal saved_name for client
    safe = {k: v for k, v in job.items() if k != "files"}
    safe["file_count"] = len(job.get("files", []))
    return jsonify(success=True, job=safe)


@app.route("/api/jobs", methods=["GET"])
def list_jobs():
    """Admin: list all jobs."""
    jobs = load_jobs()
    summary = []
    for j in jobs.values():
        summary.append({
            "job_id":      j["job_id"],
            "status":      j["status"],
            "created_at":  j["created_at"],
            "grand_total": j.get("grand_total"),
            "file_count":  len(j.get("files", [])),
        })
    summary.sort(key=lambda x: x["created_at"], reverse=True)
    return jsonify(success=True, jobs=summary)


@app.route("/api/paper", methods=["GET"])
def paper_status():
    """Admin: check remaining paper."""
    return jsonify(success=True, paper=get_paper())


@app.route("/api/paper", methods=["POST"])
def set_paper():
    """Admin: refill paper counts."""
    data  = request.get_json(force=True, silent=True) or {}
    state = get_paper()
    if "color" in data:
        state["color"] = int(data["color"])
    if "bw" in data:
        state["bw"] = int(data["bw"])
    save_json(PAPER_STATE, state)
    log.info("📄 Paper refilled: %s", state)
    return jsonify(success=True, paper=state)


@app.route("/api/printers", methods=["GET"])
def printer_status():
    """Admin: check CUPS printer status."""
    return jsonify(success=True, printers={
        "color": get_printer_status(COLOR_PRINTER),
        "bw":    get_printer_status(MONO_PRINTER),
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify(status="ok", timestamp=datetime.utcnow().isoformat())


#  Recovery: re-queue jobs that were mid-processing at shutdown 

def recover_interrupted_jobs():
    jobs = load_jobs()
    for job_id, job in jobs.items():
        if job["status"] in ("queued", "processing"):
            log.warning("⚡ Recovering interrupted job %s (was: %s)",
                        job_id, job["status"])
            update_job(job_id, status="queued",
                       recovery_note="Re-queued after server restart")
            t = threading.Thread(target=process_print_job,
                                 args=(job_id,), daemon=True)
            t.start()
            time.sleep(1)  # stagger recovery jobs

# Entry point

if __name__ == "__main__":
    log.info("  TakeAprinT server starting…")
    recover_interrupted_jobs()
    app.run(host="0.0.0.0", port=3000, debug=False, threaded=True)

#yeah i used claude , piss off