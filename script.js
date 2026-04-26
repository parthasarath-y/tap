// script.js — TakeAprinT (with full status overlay)

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
}

const fileInput = document.getElementById('fileInput');
const uploadBtn = document.getElementById('uploadBtn');
const preview   = document.getElementById('preview');
const queueList = document.getElementById('queueList');
const payBtn    = document.getElementById('payBtn');
const dropZone  = document.getElementById('dropZone');

let uploadedFilesData = [];
let activePoller      = null;

// ── Drag & drop ───────────────────────────────────────────────────────────────
uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => handleFiles(fileInput.files));

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); }, false);
});
['dragenter', 'dragover'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.add('dragover'));
});
['dragleave', 'drop'].forEach(evt => {
  dropZone.addEventListener(evt, () => dropZone.classList.remove('dragover'));
});
dropZone.addEventListener('drop', e => handleFiles(e.dataTransfer.files));

// ── Page counter ──────────────────────────────────────────────────────────────
async function getPageCount(file) {
  const ext = file.name.toLowerCase().split('.').pop();
  try {
    if (ext === 'pdf') {
      const pdf = await pdfjsLib.getDocument(await file.arrayBuffer()).promise;
      return pdf.numPages;
    }
    if (ext === 'docx' || ext === 'doc') {
      if (typeof JSZip === 'undefined') return 1;
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      if (!zip.file('word/document.xml')) return 1;
      const xml = await zip.file('word/document.xml').async('string');
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      const NS  = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
      const breaks = Array.from(doc.getElementsByTagNameNS(NS, 'br'))
        .filter(br => br.getAttributeNS(NS, 'type') === 'page').length;
      if (breaks > 0) return breaks + 1;
      return Math.max(1, Math.ceil(doc.getElementsByTagNameNS(NS, 'p').length / 35));
    }
    if (ext === 'pptx' || ext === 'ppt') {
      if (typeof JSZip === 'undefined') return 1;
      const zip = await JSZip.loadAsync(await file.arrayBuffer());
      return Object.keys(zip.files)
        .filter(f => f.startsWith('ppt/slides/slide') && f.endsWith('.xml')).length || 1;
    }
    if (ext === 'xlsx' || ext === 'xls') {
      if (typeof XLSX === 'undefined') return 1;
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      return wb.SheetNames.length || 1;
    }
    return 1;
  } catch (err) {
    console.error('Page count error:', err);
    return 1;
  }
}

// ── File handler ──────────────────────────────────────────────────────────────
async function handleFiles(files) {
  if (!files?.length) return;
  if (preview.querySelector('.empty')) preview.innerHTML = '';

  for (const file of Array.from(files)) {
    const fileId    = Date.now() + Math.random();
    const pageCount = await getPageCount(file);
    console.log(`  ${file.name} — ${pageCount} page(s)`);

    const fileData = { id: fileId, file, name: file.name, pageCount };
    uploadedFilesData.push(fileData);

    const queueItem = document.createElement('div');
    queueItem.className      = 'queue-file-item';
    queueItem.dataset.fileId = fileId;
    queueItem.innerHTML = `
      <div class="queue-file-header">
        <div class="queue-file-name">${escapeHtml(file.name)}</div>
        <div class="copies-control">
          <button type="button" class="decr-btn"><i class="fa-solid fa-minus"></i></button>
          <span class="copies-count">1</span>
          <button type="button" class="incr-btn"><i class="fa-solid fa-plus"></i></button>
        </div>
        <button type="button" class="delete-file-btn" title="Remove"><i class="fa-solid fa-trash"></i></button>
      </div>
      <label>Print Type:
        <select class="print-type-select">
          <option value="bw" selected>Black &amp; White</option>
          <option value="color">Color</option>
        </select>
      </label>
      <div class="queue-page-range hidden">
        <label>From: <input type="number" class="from-input" min="1" value="1" max="${pageCount}"></label>
        <label>To:   <input type="number" class="to-input" min="1" value="${pageCount}" max="${pageCount}"></label>
        <div style="margin-top:0.5rem;font-size:0.85rem;color:#64748b;">
          Color: <span class="color-count">${pageCount}</span> pages |
          B&amp;W: <span class="bw-count">0</span> pages
        </div>
      </div>
    `;
    queueList.insertBefore(queueItem, queueList.firstChild);

    const fileDiv = document.createElement('div');
    fileDiv.className      = 'file-box';
    fileDiv.dataset.fileId = fileId;
    fileDiv.innerHTML = `
      <p><strong>${escapeHtml(file.name)}</strong></p>
      <p style="color:#64748b;font-size:0.9rem;">${pageCount} page${pageCount !== 1 ? 's' : ''}</p>
    `;
    preview.insertBefore(fileDiv, preview.firstChild);

    fileData.queueElement   = queueItem;
    fileData.previewElement = fileDiv;

    const copiesCount = queueItem.querySelector('.copies-count');
    queueItem.querySelector('.incr-btn').addEventListener('click', () => {
      copiesCount.textContent = parseInt(copiesCount.textContent) + 1;
    });
    queueItem.querySelector('.decr-btn').addEventListener('click', () => {
      const c = parseInt(copiesCount.textContent);
      if (c > 1) copiesCount.textContent = c - 1;
    });

    const select         = queueItem.querySelector('.print-type-select');
    const rangeDiv       = queueItem.querySelector('.queue-page-range');
    const fromIn         = queueItem.querySelector('.from-input');
    const toIn           = queueItem.querySelector('.to-input');
    const colorCountSpan = queueItem.querySelector('.color-count');
    const bwCountSpan    = queueItem.querySelector('.bw-count');

    function updatePageCounts() {
      const from = parseInt(fromIn.value) || 1;
      const to   = parseInt(toIn.value)   || pageCount;
      colorCountSpan.textContent = Math.max(0, to - from + 1);
      bwCountSpan.textContent    = Math.max(0, (from - 1) + (pageCount - to));
    }

    select.addEventListener('change', () => {
      const isColor = select.value === 'color';
      rangeDiv.classList.toggle('hidden', !isColor);
      if (isColor) { fromIn.value = 1; toIn.value = pageCount; updatePageCounts(); }
    });

    function validateRange() {
      let from = Math.max(1, Math.min(parseInt(fromIn.value) || 1, pageCount));
      let to   = Math.max(1, Math.min(parseInt(toIn.value)   || pageCount, pageCount));
      if (from > to) { if (document.activeElement === fromIn) from = to; else to = from; }
      fromIn.value = from; toIn.value = to;
      updatePageCounts();
    }
    fromIn.addEventListener('change', validateRange);
    toIn.addEventListener('change',   validateRange);
    fromIn.addEventListener('blur',   validateRange);
    toIn.addEventListener('blur',     validateRange);

    queueItem.querySelector('.delete-file-btn').addEventListener('click', () => {
      uploadedFilesData = uploadedFilesData.filter(f => f.id !== fileId);
      queueItem.style.opacity = '0';
      fileDiv.style.opacity   = '0';
      setTimeout(() => {
        queueItem.remove(); fileDiv.remove();
        if (!uploadedFilesData.length)
          preview.innerHTML = '<p class="empty">No files uploaded yet...</p>';
        updatePayButton();
      }, 300);
    });
  }

  updatePayButton();
  fileInput.value = '';
}

function updatePayButton() {
  payBtn.disabled = uploadedFilesData.length === 0 || activePoller !== null;
  if (!activePoller && uploadedFilesData.length > 0) payBtn.textContent = 'Continue & Pay';
}

// ── Local price calc ──────────────────────────────────────────────────────────
function calculateLocalPrices() {
  const COLOR_PRICE = 10.5, BW_PRICE = 1.5;
  const filesData = [];
  let grandTotal  = 0;
  uploadedFilesData.forEach(fd => {
    const q         = fd.queueElement;
    const copies    = parseInt(q.querySelector('.copies-count').textContent);
    const printType = q.querySelector('.print-type-select').value;
    let colorPages  = 0, bwPages = fd.pageCount;
    if (printType === 'color') {
      const from = parseInt(q.querySelector('.from-input').value);
      const to   = parseInt(q.querySelector('.to-input').value);
      colorPages = to - from + 1;
      bwPages    = (from - 1) + (fd.pageCount - to);
    }
    const fileTotal = (colorPages * copies * COLOR_PRICE) + (bwPages * copies * BW_PRICE);
    grandTotal += fileTotal;
    filesData.push({ original_name: fd.name, pageCount: fd.pageCount,
      colorPages, bwPages, copies, printType, fileTotal: fileTotal.toFixed(2) });
  });
  return { files: filesData, grandTotal: grandTotal.toFixed(2) };
}

// ── Order summary modal ───────────────────────────────────────────────────────
function showModal(data) {
  document.getElementById('confirmationModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'confirmationModal';
  modal.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.6);
    display:flex;align-items:center;justify-content:center;z-index:9999;`;

  let rows = '';
  data.files.forEach(f => {
    rows += `
      <div style="padding:1rem;background:#f8fafc;margin-bottom:0.8rem;
                  border-radius:8px;border-left:4px solid #667eea;">
        <div style="font-weight:600;color:#1a1d3a;">  ${escapeHtml(f.original_name)}</div>
        <div style="font-size:0.9rem;color:#64748b;margin-top:0.3rem;">
          ${f.printType === 'color'
            ? `Color: ${f.colorPages} pages &nbsp;|&nbsp; B&amp;W: ${f.bwPages} pages`
            : `B&amp;W: ${f.bwPages} pages`}
          &nbsp;·&nbsp; ${f.copies} cop${f.copies > 1 ? 'ies' : 'y'}
        </div>
        <div style="font-weight:600;color:#667eea;margin-top:0.4rem;">₹${f.fileTotal}</div>
      </div>`;
  });

  modal.innerHTML = `
    <div style="background:#fff;padding:2rem;border-radius:16px;max-width:480px;
                width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
      <h2 style="margin:0 0 1.2rem;color:#1a1d3a;">Order Summary</h2>
      <div style="max-height:280px;overflow-y:auto;margin-bottom:1.2rem;">${rows}</div>
      <div style="padding:1.2rem;background:#667eea;color:#fff;border-radius:12px;
                  text-align:center;margin-bottom:1.2rem;">
        <div style="font-size:0.85rem;opacity:0.85;">Grand Total</div>
        <div style="font-size:2rem;font-weight:700;">₹${data.grandTotal}</div>
      </div>
      <p style="text-align:center;color:#64748b;font-size:0.9rem;margin-bottom:1.2rem;">
        Proceed to payment?
      </p>
      <div style="display:flex;gap:1rem;">
        <button type="button" id="modalCancel"
          style="flex:1;padding:0.8rem;background:#e2e8f0;color:#475569;
                 border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;">
          Cancel
        </button>
        <button type="button" id="modalProceed"
          style="flex:1;padding:0.8rem;background:#667eea;color:#fff;
                 border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;">
          Proceed to Pay
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  return new Promise(resolve => {
    modal.querySelector('#modalCancel').onclick  = () => { modal.remove(); resolve(false); };
    modal.querySelector('#modalProceed').onclick = () => { modal.remove(); resolve(true);  };
    modal.onclick = e => { if (e.target === modal) { modal.remove(); resolve(false); } };
  });
}

// ── Status overlay ────────────────────────────────────────────────────────────
// Injects a full-screen overlay on top of everything showing current print state.
// States: 'uploading' | 'waiting' | 'queued' | 'processing' | 'done' | 'error'

function injectOverlayStyles() {
  if (document.getElementById('tap-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'tap-overlay-styles';
  style.textContent = `
    #tap-status-overlay {
      position: fixed;
      inset: 0;
      background: #0f1124;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0;
      animation: tapFadeIn 0.35s ease;
    }
    @keyframes tapFadeIn {
      from { opacity: 0; transform: scale(0.97); }
      to   { opacity: 1; transform: scale(1); }
    }

    /* Printer SVG animation */
    .tap-printer-wrap {
      position: relative;
      width: 120px;
      height: 120px;
      margin-bottom: 2rem;
    }
    .tap-printer-icon {
      font-size: 5rem;
      color: #667eea;
      line-height: 1;
      display: block;
      text-align: center;
    }
    .tap-paper-out {
      position: absolute;
      bottom: -4px;
      left: 50%;
      transform: translateX(-50%);
      width: 44px;
      height: 6px;
      background: #fff;
      border-radius: 2px;
      transform-origin: top center;
      animation: tapPaperSlide 1.4s ease-in-out infinite;
    }
    @keyframes tapPaperSlide {
      0%   { height: 4px;  opacity: 0; transform: translateX(-50%) translateY(0); }
      20%  { opacity: 1; }
      80%  { height: 36px; opacity: 1; }
      100% { height: 36px; opacity: 0; transform: translateX(-50%) translateY(8px); }
    }

    /* Spinner for uploading/waiting */
    .tap-spinner {
      width: 64px;
      height: 64px;
      border: 4px solid rgba(102,126,234,0.2);
      border-top-color: #667eea;
      border-radius: 50%;
      animation: tapSpin 0.85s linear infinite;
      margin-bottom: 2rem;
    }
    @keyframes tapSpin {
      to { transform: rotate(360deg); }
    }

    /* Success checkmark */
    .tap-check-wrap {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      background: #22c55e;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
      animation: tapCheckPop 0.5s cubic-bezier(0.34,1.56,0.64,1);
    }
    @keyframes tapCheckPop {
      from { transform: scale(0); opacity: 0; }
      to   { transform: scale(1); opacity: 1; }
    }
    .tap-check-wrap i { font-size: 2.5rem; color: #fff; }

    /* Error icon */
    .tap-error-wrap {
      width: 90px;
      height: 90px;
      border-radius: 50%;
      background: #ef4444;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 2rem;
      animation: tapCheckPop 0.5s cubic-bezier(0.34,1.56,0.64,1);
    }
    .tap-error-wrap i { font-size: 2.5rem; color: #fff; }

    .tap-status-title {
      font-size: 1.8rem;
      font-weight: 700;
      color: #fff;
      margin: 0 0 0.6rem;
      text-align: center;
    }
    .tap-status-sub {
      font-size: 1rem;
      color: #94a3b8;
      margin: 0 0 2.5rem;
      text-align: center;
      max-width: 320px;
      line-height: 1.6;
    }

    /* Dots for animated sub */
    .tap-dots::after {
      content: '';
      animation: tapDots 1.5s steps(4, end) infinite;
    }
    @keyframes tapDots {
      0%   { content: ''; }
      25%  { content: '.'; }
      50%  { content: '..'; }
      75%  { content: '...'; }
      100% { content: ''; }
    }

    /* Steps row */
    .tap-steps {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      margin-bottom: 3rem;
    }
    .tap-step {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      font-size: 0.85rem;
      color: #475569;
      transition: color 0.3s;
    }
    .tap-step.active  { color: #667eea; font-weight: 600; }
    .tap-step.done    { color: #22c55e; }
    .tap-step-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #334155;
      transition: background 0.3s;
    }
    .tap-step.active .tap-step-dot  { background: #667eea; }
    .tap-step.done   .tap-step-dot  { background: #22c55e; }
    .tap-step-sep {
      width: 24px; height: 2px;
      background: #334155;
      border-radius: 1px;
    }

    /* Buttons */
    .tap-btn-done {
      padding: 0.9rem 3rem;
      background: #22c55e;
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 1.1rem;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.2s, transform 0.15s;
      animation: tapCheckPop 0.6s 0.2s cubic-bezier(0.34,1.56,0.64,1) both;
    }
    .tap-btn-done:hover { background: #16a34a; transform: scale(1.03); }

    .tap-btn-retry {
      padding: 0.9rem 3rem;
      background: transparent;
      color: #ef4444;
      border: 2px solid #ef4444;
      border-radius: 12px;
      font-size: 1.1rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s;
    }
    .tap-btn-retry:hover { background: #ef4444; color: #fff; }

    .tap-job-id {
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: #334155;
      font-family: monospace;
      letter-spacing: 0.05em;
    }
  `;
  document.head.appendChild(style);
}

function removeOverlay() {
  document.getElementById('tap-status-overlay')?.remove();
}

function showStatusOverlay(state, info = {}) {
  injectOverlayStyles();
  removeOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'tap-status-overlay';

  const stepDefs = ['Upload', 'Payment', 'Printing'];
  const stepIndex = { uploading: 0, waiting: 1, queued: 1, processing: 2 };

  function stepsHTML(activeIdx) {
    return stepDefs.map((label, i) => {
      const cls = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
      const sep = i < stepDefs.length - 1
        ? `<div class="tap-step-sep"></div>` : '';
      return `
        <div class="tap-step ${cls}">
          <div class="tap-step-dot"></div>
          ${label}
        </div>${sep}`;
    }).join('');
  }

  const configs = {
    uploading: {
      icon: `<div class="tap-spinner"></div>`,
      title: 'Uploading files',
      sub: `<span class="tap-dots">Sending your files to the server</span>`,
      steps: stepsHTML(0),
      actions: '',
    },
    waiting: {
      icon: `<div class="tap-spinner"></div>`,
      title: 'Awaiting payment',
      sub: `Job <code style="color:#667eea">${(info.jobId||'').slice(0,8)}…</code> is ready.<br>Complete your payment to begin printing.`,
      steps: stepsHTML(1),
      actions: '',
    },
    queued: {
      icon: `<div class="tap-spinner"></div>`,
      title: 'In the queue',
      sub: `<span class="tap-dots">Your job is waiting to print</span>`,
      steps: stepsHTML(1),
      actions: '',
    },
    processing: {
      icon: `
        <div class="tap-printer-wrap">
          <span class="tap-printer-icon"><i class="fa-solid fa-print"></i></span>
          <div class="tap-paper-out"></div>
        </div>`,
      title: 'Printing',
      sub: `<span class="tap-dots">Your document is being printed</span>`,
      steps: stepsHTML(2),
      actions: '',
    },
    done: {
      icon: `<div class="tap-check-wrap"><i class="fa-solid fa-check"></i></div>`,
      title: 'All done!',
      sub: `Your document has been sent to the printer.<br>
            ${info.colorPages ? `<span style="color:#667eea">Color: ${info.colorPages} page(s)</span> &nbsp;·&nbsp; ` : ''}
            <span style="color:#94a3b8">B&amp;W: ${info.bwPages||0} page(s)</span>`,
      steps: '',
      actions: `<button type="button" class="tap-btn-done" id="tapDoneBtn">
                  <i class="fa-solid fa-house" style="margin-right:0.5rem"></i>Back to Home
                </button>`,
    },
    error: {
      icon: `<div class="tap-error-wrap"><i class="fa-solid fa-xmark"></i></div>`,
      title: 'Something went wrong',
      sub: info.message || 'The print job encountered an error. Please try again.',
      steps: '',
      actions: `<button type="button" class="tap-btn-retry" id="tapRetryBtn">
                  <i class="fa-solid fa-rotate-right" style="margin-right:0.5rem"></i>Try Again
                </button>`,
    },
  };

  const cfg = configs[state] || configs.waiting;

  overlay.innerHTML = `
    ${cfg.icon}
    <h1 class="tap-status-title">${cfg.title}</h1>
    <p class="tap-status-sub">${cfg.sub}</p>
    ${cfg.steps ? `<div class="tap-steps">${cfg.steps}</div>` : ''}
    ${cfg.actions}
    ${info.jobId ? `<div class="tap-job-id">Job ID: ${info.jobId}</div>` : ''}
  `;

  document.body.appendChild(overlay);

  // Wire buttons
  overlay.querySelector('#tapDoneBtn')?.addEventListener('click', () => {
    removeOverlay();
    resetUI();
    // Redirect to homepage — change '/' if your homepage is different
    window.location.href = '/';
  });



  overlay.querySelector('#tapRetryBtn')?.addEventListener('click', () => {
    removeOverlay();
    resetUI();
  });
}

// ── Job poller ────────────────────────────────────────────────────────────────
function startPolling(jobId) {
  if (activePoller) clearInterval(activePoller);

  const stateMap = {
    pending_payment: 'waiting',
    queued:          'queued',
    processing:      'processing',
  };

  activePoller = setInterval(async () => {
    try {
      const res    = await fetch(`http://localhost:3000/api/job/${jobId}`);
      const data   = await res.json();
      const status = data.job?.status;
      console.log(`  Job status: ${status}`);

      if (stateMap[status]) {
        showStatusOverlay(stateMap[status], { jobId });
      } else if (status === 'completed') {
        clearInterval(activePoller); activePoller = null;
        showStatusOverlay('done', {
          jobId,
          colorPages: data.job.total_color_pages || 0,
          bwPages:    data.job.total_bw_pages    || 0,
        });
      } else if (status === 'completed_with_errors') {
        clearInterval(activePoller); activePoller = null;
        showStatusOverlay('error', {
          jobId,
          message: `Finished with errors:<br><small>${(data.job.errors||[]).join('<br>')}</small>`,
        });
      } else if (status === 'failed') {
        clearInterval(activePoller); activePoller = null;
        showStatusOverlay('error', { jobId, message: 'Print job failed. Check server logs.' });
      }
    } catch (err) {
      console.error('Poll error:', err);
    }
  }, 3000);
}

function resetUI() {
  uploadedFilesData   = [];
  queueList.innerHTML = '';
  preview.innerHTML   = '<p class="empty">No files uploaded yet...</p>';
  activePoller        = null;
  updatePayButton();
}

// ── Pay button ────────────────────────────────────────────────────────────────
payBtn.addEventListener('click', async function (e) {
  e.preventDefault();
  e.stopPropagation();

  if (uploadedFilesData.length === 0 || activePoller) return;

  const confirmed = await showModal(calculateLocalPrices());
  if (!confirmed) return;

  // Show uploading state immediately
  showStatusOverlay('uploading');

  const formData = new FormData();
  const options  = [];
  uploadedFilesData.forEach(fd => {
    const q         = fd.queueElement;
    const copies    = parseInt(q.querySelector('.copies-count').textContent);
    const printType = q.querySelector('.print-type-select').value;
    let pages       = 'all';
    if (printType === 'color') {
      pages = `${q.querySelector('.from-input').value}-${q.querySelector('.to-input').value}`;
    }
    formData.append('files', fd.file);
    options.push({ name: fd.name, printType, copies, pages, pageCount: fd.pageCount });
  });
  formData.append('options', JSON.stringify(options));

  try {
    const res    = await fetch('http://localhost:3000/api/upload', { method: 'POST', body: formData });
    const result = await res.json();

    if (result.success) {
      console.log('  Uploaded — job:', result.job_id);
      console.log(`  Test: python3 admin.py simulate ${result.job_id}`);

      // Show waiting-for-payment screen
      showStatusOverlay('waiting', { jobId: result.job_id });
      activePoller = true; // block pay button while polling
      startPolling(result.job_id);

      // ── Drop your payment gateway call here ──────────────────────────
      // e.g. Razorpay:
      // const rzp = new Razorpay({ key:'rzp_live_xxx',
      //   amount: Math.round(result.grand_total * 100), currency:'INR',
      //   notes:{ job_id: result.job_id }, handler: ()=>{} });
      // rzp.open();
      // ─────────────────────────────────────────────────────────────────

    } else {
      showStatusOverlay('error', { message: result.message || 'Upload failed.' });
    }
  } catch (err) {
    console.error('Upload failed:', err);
    showStatusOverlay('error', { message: 'Cannot reach server. Is print_server.py running on port 3000?' });
  }
});

// ── Escape helper ─────────────────────────────────────────────────────────────
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

// ── Library check ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  const missing = ['pdfjsLib','JSZip','XLSX'].filter(lib => typeof window[lib] === 'undefined');
  if (missing.length) console.warn('  Missing:', missing.join(', '));
  else console.log('  All libraries loaded successfully');
});
