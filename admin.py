#!/usr/bin/env python3
"""
TakeAprinT - Admin CLI
Manage jobs, paper counts, and printer status from the terminal.

Usage:
    python3 admin.py jobs              # list all jobs
    python3 admin.py job <id>          # show job detail
    python3 admin.py retry <id>        # re-queue a failed job
    python3 admin.py paper             # show paper counts
    python3 admin.py paper set --color 500 --bw 500
    python3 admin.py printers          # check CUPS status
    python3 admin.py simulate <id>     # simulate payment for testing
"""

import sys
import json
import hashlib
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

BASE_DIR    = Path(__file__).parent
LOG_FILE    = BASE_DIR / "print_jobs.json"
PAPER_STATE = BASE_DIR / "paper_counter.json"
WEBHOOK_SECRET = "changeme_secret"   # match print_server.py

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

def save_jobs(jobs):
    save_json(LOG_FILE, jobs)

def color(code, text):
    codes = {"red": 31, "green": 32, "yellow": 33, "cyan": 36, "bold": 1}
    return f"\033[{codes.get(code, 0)}m{text}\033[0m"

STATUS_COLOR = {
    "pending_payment":    "yellow",
    "queued":             "cyan",
    "processing":         "cyan",
    "completed":          "green",
    "completed_with_errors": "yellow",
    "failed":             "red",
}

def fmt_status(s):
    return color(STATUS_COLOR.get(s, "bold"), s)

#   Commands

def cmd_jobs(args):
    jobs = load_jobs()
    if not jobs:
        print("No jobs found.")
        return
    rows = sorted(jobs.values(), key=lambda j: j.get("created_at",""), reverse=True)
    print(f"\n{'JOB ID':<38} {'STATUS':<30} {'FILES':>5} {'TOTAL':>8}  CREATED")
    print("─" * 95)
    for j in rows:
        created = j.get("created_at","")[:16].replace("T"," ")
        print(f"{j['job_id']:<38} {fmt_status(j['status']):<39} "
              f"{len(j.get('files',[])): >5} "
              f"{'₹'+str(j.get('grand_total','?')):>8}  {created}")
    print()

def cmd_job(args):
    jobs = load_jobs()
    job  = jobs.get(args.id)
    if not job:
        print(color("red", f"Job {args.id} not found"))
        sys.exit(1)
    print(f"\n{'─'*60}")
    print(f"  Job ID    : {job['job_id']}")
    print(f"  Status    : {fmt_status(job['status'])}")
    print(f"  Created   : {job.get('created_at','')}")
    print(f"  Updated   : {job.get('updated_at','')}")
    print(f"  Total     : ₹{job.get('grand_total','?')}")
    print(f"  Payment   : {job.get('payment_id','—')}")
    print(f"\n  Files ({len(job.get('files',[]))}):")
    for f in job.get("files", []):
        print(f"    • {f['original_name']}  [{f['printType'].upper()}]  "
              f"copies={f['copies']}  pages={f['pages']}  ₹{f['fileTotal']}")
    if job.get("errors"):
        print(f"\n  {color('red','Errors')}:")
        for e in job["errors"]:
            print(f"    ✗ {e}")
    print(f"{'─'*60}\n")

def cmd_retry(args):
    jobs = load_jobs()
    job  = jobs.get(args.id)
    if not job:
        print(color("red", f"Job {args.id} not found"))
        sys.exit(1)
    if job["status"] == "pending_payment":
        print(color("yellow", "Job still awaiting payment — cannot retry"))
        sys.exit(1)
    jobs[args.id]["status"] = "queued"
    jobs[args.id]["updated_at"] = datetime.utcnow().isoformat()
    jobs[args.id]["retry_note"] = f"Manual retry at {datetime.utcnow().isoformat()}"
    save_jobs(jobs)
    print(color("green", f"  Job {args.id} re-queued. Run print_worker.py to process."))

def cmd_paper(args):
    state = load_json(PAPER_STATE, {"color": 500, "bw": 500})
    if args.set:
        if args.color is not None:
            state["color"] = args.color
        if args.bw is not None:
            state["bw"] = args.bw
        save_json(PAPER_STATE, state)
        print(color("green", "  Paper counts updated"))
    print(f"\n  Color paper : {color('cyan', str(state['color']))} sheets")
    print(f"  B&W paper   : {color('cyan', str(state['bw']))} sheets\n")

def cmd_printers(args):
    for name, label in [("Printer_Color", "Color"), ("Printer_BW", "B&W")]:
        try:
            r = subprocess.run(["lpstat", "-p", name],
                               capture_output=True, text=True, timeout=5)
            status = r.stdout.strip() or r.stderr.strip() or "No output"
        except FileNotFoundError:
            status = color("yellow", "lpstat not found (CUPS not installed?)")
        except Exception as e:
            status = color("red", str(e))
        print(f"  {label} ({name}): {status}")

def cmd_simulate(args):
    """Simulate a payment webhook for testing (calls the server directly)."""
    import urllib.request
    import urllib.error

    job_id     = args.id
    payment_id = f"test_pay_{int(datetime.utcnow().timestamp())}"
    signature  = hashlib.sha256(
        f"{job_id}:{payment_id}:{WEBHOOK_SECRET}".encode()
    ).hexdigest()

    payload = json.dumps({
        "job_id":     job_id,
        "payment_id": payment_id,
        "status":     "paid",
        "signature":  signature,
    }).encode()

    url = f"http://localhost:3000/api/webhook/payment"
    req = urllib.request.Request(url, data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            body = json.loads(resp.read())
            print(color("green", f" Webhook sent: {body}"))
    except urllib.error.URLError as e:
        print(color("red", f"Server unreachable: {e}"))
        print("  Make sure print_server.py is running on port 3000.")

#   Arg parser 

def main():
    parser = argparse.ArgumentParser(description="TakeAprinT Admin CLI")
    sub    = parser.add_subparsers(dest="cmd")

    sub.add_parser("jobs",     help="List all jobs")

    p_job = sub.add_parser("job", help="Show job detail")
    p_job.add_argument("id", help="Job UUID")

    p_retry = sub.add_parser("retry", help="Re-queue a failed job")
    p_retry.add_argument("id", help="Job UUID")

    p_paper = sub.add_parser("paper", help="Show/set paper counts")
    p_paper.add_argument("--set",   action="store_true")
    p_paper.add_argument("--color", type=int)
    p_paper.add_argument("--bw",    type=int)

    sub.add_parser("printers", help="Check CUPS printer status")

    p_sim = sub.add_parser("simulate", help="Simulate payment webhook (test)")
    p_sim.add_argument("id", help="Job UUID to mark as paid")

    args = parser.parse_args()

    dispatch = {
        "jobs":     cmd_jobs,
        "job":      cmd_job,
        "retry":    cmd_retry,
        "paper":    cmd_paper,
        "printers": cmd_printers,
        "simulate": cmd_simulate,
    }

    fn = dispatch.get(args.cmd)
    if fn:
        fn(args)
    else:
        parser.print_help()

if __name__ == "__main__":
    main()
