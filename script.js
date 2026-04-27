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

// ] Drag & drop 
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

//  Page counter 
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

//  File handler 
async function handleFiles(files) {
  if (!files?.length) return;
  if (preview.querySelector('.empty')) preview.innerHTML = '';

  for (const file of Array.from(files)) {
    const fileId    = Date.now() + Math.random();
    const pageCount = await getPageCount(file);
    console.log(`${file.name} — ${pageCount} page(s)`);

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
        <button type="button" class="delete-file-btn" title="Remove">del<i class="fa-solid fa-trash"></i></button>
      </div>
      <label>Print Type:

        <select class="print-type-select">
          <option value="bw" selected>Black &amp; White</option>
          <option value="color">Color</option>
      
          </select>
      </label>
      <div class="queue-page-range hidden">

        <label>From: <input type="number" class="from-input" min="1" value="1" max="${pageCount}"> </label>
        <label>To:   <input type="number" class="to-input" min="1" value="${pageCount}" max="${pageCount}"> </label>
      
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

//  Local price calc 
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

//  Order summary modal 
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
        <div style="font-weight:600;color:#1a1d3a;"> ${escapeHtml(f.original_name)}</div>
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

//  Status overlay 
function injectOverlayStyles() {
  if (document.getElementById('tap-overlay-styles')) return;
  const style = document.createElement('style');
  style.id = 'tap-overlay-styles';
  style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;600;700&display=swap');

    #tap-overlay {
      position: fixed;
      inset: 0;
      background: #6c7bee;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Roboto', sans-serif;
      animation: tapOverlayIn 0.3s ease;
    }
    @keyframes tapOverlayIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* ── Card ── */
    .tap-card {
      background: #fff;
      width: 360px;
      border-radius: 8px;
      padding: 80px 30px 25px;
      text-align: center;
      position: relative;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      animation: tapCardUp 0.4s cubic-bezier(0.34,1.4,0.64,1);
    }
    @keyframes tapCardUp {
      from { transform: translateY(40px); opacity: 0; }
      to   { transform: translateY(0);    opacity: 1; }
    }

    /* ── Top badge ── */
    .tap-badge {
      position: absolute;
      top: -44px;
      left: 50%;
      transform: translateX(-50%);
      width: 88px;
      height: 88px;
      border-radius: 50%;
      border: 5px solid #6c7bee;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 2.4rem;
    }
    .tap-badge--spin {
      background: #fff;
      border-color: rgba(255,255,255,0.4);
      border-top-color: #fff;
      animation: tapSpin 0.9s linear infinite;
    }
    @keyframes tapSpin { to { transform: translateX(-50%) rotate(360deg); } }

    .tap-badge--print {
      background: #fff;
      animation: tapPulse 1.2s ease-in-out infinite;
    }
    @keyframes tapPulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(108,123,238,0.4); }
      50%      { box-shadow: 0 0 0 10px rgba(108,123,238,0); }
    }

    .tap-badge--done  { background: #60c878; border-color: #fff; }
    .tap-badge--error { background: #ef4444; border-color: #fff; }

    /* paper slide on printer badge */
    .tap-paper {
      position: absolute;
      bottom: -2px;
      left: 50%;
      transform: translateX(-50%);
      width: 28px;
      height: 5px;
      background: #6c7bee;
      border-radius: 2px;
      animation: tapPaper 1.3s ease-in-out infinite;
    }
    @keyframes tapPaper {
      0%   { height: 3px;  opacity: 0; }
      20%  { opacity: 1; }
      80%  { height: 28px; opacity: 1; }
      100% { height: 28px; opacity: 0; transform: translateX(-50%) translateY(6px); }
    }

    /* ── Text ── */
    .tap-title {
      text-transform: uppercase;
      color: #55585b;
      font-size: 17px;
      font-weight: 600;
      letter-spacing: 0.04em;
      margin: 0 0 4px;
    }
    .tap-sub {
      color: #959a9e;
      font-size: 14px;
      font-weight: 400;
      margin: 0 0 20px;
    }

    /* ── Body panel ── */
    .tap-body {
      background: #f8f6f6;
      border-radius: 6px;
      padding: 20px;
      margin-bottom: 16px;
      text-align: left;
    }

    /* amount */
    .tap-amount {
      text-align: center;
      font-size: 58px;
      font-weight: 700;
      color: #232528;
      margin: 8px 0 16px;
      line-height: 1;
    }
    .tap-amount span { font-size: 55%; }

    /* detail rows */
    .tap-detail-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 10px;
    }
    .tap-detail-icon {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #667eea22;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #667eea;
      font-size: 0.9rem;
      flex-shrink: 0;
    }
    .tap-detail-label {
      font-size: 11px;
      text-transform: uppercase;
      color: #b0b4b8;
      margin-bottom: 2px;
    }
    .tap-detail-value {
      font-size: 13px;
      font-weight: 600;
      color: #232528;
    }

    /* ── Tags ── */
    .tap-tags {
      display: flex;
      gap: 6px;
      justify-content: center;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .tap-tag {
      text-transform: uppercase;
      background: #f8f6f6;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      color: #b0b4b8;
      letter-spacing: 0.05em;
    }
    .tap-tag--green { background: #dcfce7; color: #16a34a; }

    /* ── Buttons ── */
    .tap-btn {
      width: 100%;
      padding: 0.85rem;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.2s, transform 0.15s;
      font-family: 'Roboto', sans-serif;
    }
    .tap-btn:hover { filter: brightness(1.08); transform: scale(1.01); }
    .tap-btn--green { background: #60c878; color: #fff; }
    .tap-btn--red   { background: transparent; color: #ef4444;
                      border: 2px solid #ef4444; }
    .tap-btn--red:hover { background: #ef4444; color: #fff; filter: none; }

    /* ── Spinner sub-state ── */
    .tap-dots::after {
      content: '';
      animation: tapDots 1.4s steps(4,end) infinite;
    }
    @keyframes tapDots {
      0%  { content:''; }  25% { content:'.'; }
      50% { content:'..'; } 75% { content:'...'; }
    }
  `;
  document.head.appendChild(style);
}

function removeOverlay() {
  document.getElementById('tap-overlay')?.remove();
}

function showStatusOverlay(state, info = {}) {
  injectOverlayStyles();
  removeOverlay();

  const overlay = document.createElement('div');
  overlay.id = 'tap-overlay';

  //  Shared "in-progress" card builder 
  function progressCard(badgeClass, badgeIcon, title, sub) {
    return `
      <div class="tap-card">
        <div class="tap-badge ${badgeClass}">${badgeIcon}</div>
        <h1 class="tap-title">${title}</h1>
        <h2 class="tap-sub">${sub}</h2>
      </div>`;
  }

  const configs = {

    uploading: () => progressCard(
      'tap-badge--spin', '',
      'Uploading', '<span class="tap-dots">Sending your files</span>'
    ),

    waiting: () => progressCard(
      'tap-badge--spin', '',
      'Awaiting Payment',
      `Job <strong style="color:#667eea">${(info.jobId||'').slice(0,8)}…</strong>`
    ),

    queued: () => progressCard(
      'tap-badge--spin', '',
      'In Queue', '<span class="tap-dots">Waiting to print</span>'
    ),

    processing: () => progressCard(
      'tap-badge--print',
      `<span style="position:relative;display:inline-block;">
         <i class="fa-solid fa-print" style="color:#667eea;font-size:1.8rem;"></i>
         <span class="tap-paper"></span>
       </span>`,
      'Printing', '<span class="tap-dots">Your document is printing</span>'
    ),

    done: () => {
      const total   = info.grandTotal || '0.00';
      const [whole, dec] = total.split('.');
      const jobShort = (info.jobId||'').slice(0,8).toUpperCase();
      const pages    = [
        info.colorPages ? `${info.colorPages} color` : '',
        info.bwPages    ? `${info.bwPages} b&w`      : '',
      ].filter(Boolean).join(' · ') || '—';

      return `
        <div class="tap-card">
          <div class="tap-badge tap-badge--done">
            <i class="fa-solid fa-check" style="color:#fff;font-size:2rem;"></i>
          </div>

          <h1 class="tap-title">Payment Complete</h1>
          <h2 class="tap-sub">Your print job is on its way</h2>

          <div class="tap-body">
            <div class="tap-amount"><span>₹</span>${whole}<span>.${dec||'00'}</span></div>

            <div class="tap-detail-row">
              <div class="tap-detail-icon"><i class="fa-solid fa-file-lines"></i></div>
              <div>
                <div class="tap-detail-label">Pages printed</div>
                <div class="tap-detail-value">${pages}</div>
              </div>
            </div>

            <div class="tap-detail-row">
              <div class="tap-detail-icon"><i class="fa-solid fa-print"></i></div>
              <div>
                <div class="tap-detail-label">Print shop</div>
                <div class="tap-detail-value">TakeAprinT</div>
              </div>
            </div>
          </div>

          <div class="tap-tags">
            <span class="tap-tag tap-tag--green">completed</span>
            <span class="tap-tag">#${jobShort}</span>
          </div>

          <button type="button" class="tap-btn tap-btn--green" id="tapDoneBtn">
            <i class="fa-solid fa-house" style="margin-right:0.4rem;"></i>Back to Home
          </button>
        </div>`;
    },

    error: () => `
      <div class="tap-card">
        <div class="tap-badge tap-badge--error">
          <i class="fa-solid fa-xmark" style="color:#fff;font-size:2rem;"></i>
        </div>
        <h1 class="tap-title">Something went wrong</h1>
        <h2 class="tap-sub">${info.message || 'The print job encountered an error.'}</h2>
        <button type="button" class="tap-btn tap-btn--red" id="tapRetryBtn">
          <i class="fa-solid fa-rotate-right" style="margin-right:0.4rem;"></i>Try Again
        </button>
      </div>`,
  };

  overlay.innerHTML = (configs[state] || configs.waiting)();
  document.body.appendChild(overlay);

  overlay.querySelector('#tapDoneBtn')?.addEventListener('click', () => {
    removeOverlay(); resetUI();
    window.location.href = '/';
  });
  overlay.querySelector('#tapRetryBtn')?.addEventListener('click', () => {
    removeOverlay(); resetUI();
  });
}

//  Job poller 
function startPolling(jobId, grandTotal) {
  if (activePoller) clearInterval(activePoller);
  const map = { pending_payment:'waiting', queued:'queued', processing:'processing' };

  activePoller = setInterval(async () => {
    try {
      const res    = await fetch(`http://localhost:3000/api/job/${jobId}`);
      const data   = await res.json();
      const status = data.job?.status;
      console.log(` ${status}`);

      if (map[status]) {
        showStatusOverlay(map[status], { jobId });
      } else if (status === 'completed') {
        clearInterval(activePoller); activePoller = null;
        showStatusOverlay('done', {
          jobId,
          grandTotal,
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
    } catch (err) { console.error('Poll error:', err); }
  }, 3000);
}

function resetUI() {
  uploadedFilesData   = [];
  queueList.innerHTML = '';
  preview.innerHTML   = '<p class="empty">No files uploaded yet...</p>';
  activePoller        = null;
  updatePayButton();
}

//  Pay button 
payBtn.addEventListener('click', async function (e) {
  e.preventDefault();
  e.stopPropagation();
  if (uploadedFilesData.length === 0 || activePoller) return;

  const priceData = calculateLocalPrices();
  const confirmed = await showModal(priceData);
  if (!confirmed) return;

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
    const res    = await fetch('http://localhost:3000/api/upload', { method:'POST', body:formData });
    const result = await res.json();

    if (result.success) {
      console.log('job:', result.job_id);
      console.log(` Test: python3 admin.py simulate ${result.job_id}`);
      activePoller = true;
      showStatusOverlay('waiting', { jobId: result.job_id });
      startPolling(result.job_id, priceData.grandTotal);
    } else {
      showStatusOverlay('error', { message: result.message || 'Upload failed.' });
    }
  } catch (err) {
    console.error(err);
    showStatusOverlay('error', { message: 'Cannot reach server. Is print_server.py running?' });
  }
});

//  Escape helper 
function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

window.addEventListener('DOMContentLoaded', () => {
  const missing = ['pdfjsLib','JSZip','XLSX'].filter(l => typeof window[l] === 'undefined');
  if (missing.length) console.warn(' Missing:', missing.join(', '));
  else console.log(' All libraries loaded successfully');
});