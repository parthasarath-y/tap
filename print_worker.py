#!/usr/bin/env python3
"""
TakeAprinT - Standalone Print Worker
Polls print_jobs.json for queued jobs and processes them.
Use this if you run the Flask server separately and want a
dedicated worker process (e.g. systemd service).

Usage:
    python3 print_worker.py [--once]
    --once : process queued jobs once and exit (useful for cron)
"""

import sys
import time
import json
import shutil
import logging
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

#  Shared config (mirrors print_server.py) 
BASE_DIR     = Path(__file__).parent
UPLOAD_DIR   = BASE_DIR / "uploads"
TEMP_DIR     = BASE_DIR / "temp_print"
LOG_FILE     = BASE_DIR / "print_jobs.json"
PAPER_STATE  = BASE_DIR / "paper_counter.json"

COLOR_PRINTER = "Printer_Color"
MONO_PRINTER  = "Printer_BW"
POLL_INTERVAL = 5   # seconds between polls

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [WORKER] %(message)s",
    handlers=[
        logging.FileHandler(BASE_DIR / "worker.log"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger("PrintWorker")

#  Helpers (duplicated to keep worker self-contained) 

def load_json(path, default):
    if path.exists():
        try:
            return json.loads(path.read_text())
        except Exception:
            pass
    return default

def save_json(path, data):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=2, default=str))
    tmp.replace(path)

def load_jobs():
    return load_json(LOG_FILE, {})

def update_job(job_id, **kwargs):
    jobs = load_jobs()
    if job_id in jobs:
        jobs[job_id].update(kwargs)
        jobs[job_id]["updated_at"] = datetime.utcnow().isoformat()
        save_json(LOG_FILE, jobs)

def get_paper():
    return load_json(PAPER_STATE, {"color": 500, "bw": 500})

def decrement_paper(color_pages=0, bw_pages=0):
    state = get_paper()
    state["color"] = max(0, state["color"] - color_pages)
    state["bw"]    = max(0, state["bw"]    - bw_pages)
    save_json(PAPER_STATE, state)
    return state

def convert_to_pdf(src: Path, dest_dir: Path) -> Path:
    if src.suffix.lower() == ".pdf":
        dest = dest_dir / src.name
        shutil.copy2(src, dest)
        return dest
    result = subprocess.run(
        ["libreoffice", "--headless", "--convert-to", "pdf",
         "--outdir", str(dest_dir), str(src)],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        raise RuntimeError(f"LibreOffice failed: {result.stderr}")
    pdf = dest_dir / (src.stem + ".pdf")
    if not pdf.exists():
        raise FileNotFoundError(f"Converted PDF missing: {pdf}")
    return pdf

def extract_pages(pdf: Path, from_p: int, to_p: int, out: Path) -> Path:
    try:
        r = subprocess.run(
            ["pdftk", str(pdf), "cat", f"{from_p}-{to_p}", "output", str(out)],
            capture_output=True, text=True, timeout=60
        )
        if r.returncode == 0:
            return out
    except FileNotFoundError:
        pass
    r = subprocess.run(
        ["gs", "-dBATCH", "-dNOPAUSE", "-sDEVICE=pdfwrite",
         f"-dFirstPage={from_p}", f"-dLastPage={to_p}",
         f"-sOutputFile={out}", str(pdf)],
        capture_output=True, text=True, timeout=60
    )
    if r.returncode != 0:
        raise RuntimeError(f"Page extraction failed: {r.stderr}")
    return out

def lpr_print(pdf: Path, printer: str, copies: int, color: bool):
    color_opt = "KGSInkType=Color" if color else "KGSInkType=Grayscale"
    cmd = ["lpr", "-P", printer, "-#", str(copies),
           "-o", "media=A4", "-o", color_opt, "-o", "fit-to-page", str(pdf)]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"lpr error: {r.stderr}")
    log.info("Sent to %s: %s (%d copies)", printer, pdf.name, copies)

#  Core processor (same logic as server, self-contained) 

def process_job(job_id: str):
    jobs = load_jobs()
    job  = jobs.get(job_id)
    if not job:
        log.error("Job %s missing from log", job_id)
        return

    log.info("▶ Processing job %s", job_id)
    update_job(job_id, status="processing",
               started_at=datetime.utcnow().isoformat())

    job_tmp = TEMP_DIR / job_id
    job_tmp.mkdir(parents=True, exist_ok=True)

    total_color = total_bw = 0
    errors = []

    for file_info in job["files"]:
        src        = UPLOAD_DIR / file_info["saved_name"]
        copies     = int(file_info.get("copies", 1))
        print_type = file_info.get("printType", "bw")
        pages_str  = file_info.get("pages", "all")
        page_count = int(file_info.get("pageCount", 1))

        if not src.exists():
            errors.append(f"Missing: {src.name}")
            continue

        try:
            pdf = convert_to_pdf(src, job_tmp)
        except Exception as e:
            errors.append(f"Convert failed {src.name}: {e}")
            continue

        if print_type == "color" and pages_str != "all":
            fp, tp = map(int, pages_str.split("-"))
        else:
            fp, tp = 1, page_count

        if print_type == "color":
            # Color range
            cpdf = job_tmp / f"{src.stem}_color.pdf"
            try:
                extract_pages(pdf, fp, tp, cpdf)
                lpr_print(cpdf, COLOR_PRINTER, copies, color=True)
                total_color += (tp - fp + 1) * copies
            except Exception as e:
                errors.append(f"Color print {src.name}: {e}")

            # BW remainder
            for bf, bt in [(1, fp-1), (tp+1, page_count)]:
                if bf <= bt and bf >= 1:
                    bpdf = job_tmp / f"{src.stem}_bw_{bf}_{bt}.pdf"
                    try:
                        extract_pages(pdf, bf, bt, bpdf)
                        lpr_print(bpdf, MONO_PRINTER, copies, color=False)
                        total_bw += (bt - bf + 1) * copies
                    except Exception as e:
                        errors.append(f"BW print {src.name} p{bf}-{bt}: {e}")
        else:
            try:
                lpr_print(pdf, MONO_PRINTER, copies, color=False)
                total_bw += page_count * copies
            except Exception as e:
                errors.append(f"BW print {src.name}: {e}")

    paper = decrement_paper(total_color, total_bw)

    # Cleanup
    shutil.rmtree(job_tmp, ignore_errors=True)
    for fi in job["files"]:
        f = UPLOAD_DIR / fi["saved_name"]
        if f.exists():
            f.unlink()

    status = "completed" if not errors else "completed_with_errors"
    update_job(job_id, status=status,
               completed_at=datetime.utcnow().isoformat(),
               total_color_pages=total_color,
               total_bw_pages=total_bw,
               paper_after=paper,
               errors=errors)

    log.info("   Job %s done — color=%d bw=%d errors=%d",
             job_id, total_color, total_bw, len(errors))


def poll_once():
    jobs = load_jobs()
    queued = [j for j in jobs.values() if j["status"] == "queued"]
    if not queued:
        return 0
    log.info("Found %d queued job(s)", len(queued))
    for job in queued:
        process_job(job["job_id"])
    return len(queued)


def main():
    parser = argparse.ArgumentParser(description="TakeAprinT Print Worker")
    parser.add_argument("--once", action="store_true",
                        help="Process queued jobs once and exit")
    args = parser.parse_args()

    TEMP_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

    if args.once:
        n = poll_once()
        log.info("Processed %d job(s). Exiting.", n)
        sys.exit(0)

    log.info("     Print worker started. Polling every %ds…", POLL_INTERVAL)
    while True:
        try:
            poll_once()
        except Exception as e:
            log.exception("Poll error: %s", e)
        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
