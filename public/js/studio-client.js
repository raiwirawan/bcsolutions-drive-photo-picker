/* studio-client.js */
(function() {
  const { apiFetch, esc, openDialog, closeDialog, toast, confirmDialog } = window.StudioApp;

  let gallery = null, photos = [], resultPhotos = [], sel = new Set(), cur = 0;
  let statusData = { status: 'unstarted', selectedIds: [], note: '' };
  let isLocked = false, inResultView = false;
  let currentMediaTypeFilter = 'all'; // 'all' | 'photo' | 'video'

  // D2: Peta id -> elemen kartu agar toggle/pilih semua tidak membangun ulang DOM
  const cardMap = new Map();

  // D5: State autosave pintar
  let idSaveTimer = null, noteSaveTimer = null, retryTimer = null;
  let dirtyIds = false, dirtyNote = false, isSaving = false, retryCount = 0;

  const $ = id => document.getElementById(id);

  // Alphanumeric natural sort for photography filenames (e.g. IMG_1, IMG_2, IMG_10)
  const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortByName(list) {
    if (!Array.isArray(list)) return [];
    return list.slice().sort((a, b) => naturalCollator.compare(a.name || a.id || '', b.name || b.id || ''));
  }

  function formatDuration(ms) {
    if (!ms || ms <= 0) return 'VIDEO';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function getUrlToken() {
    const params = new URLSearchParams(window.location.search);
    const k = params.get('k');
    if (k) {
      sessionStorage.setItem('st_token', k);
      try { localStorage.setItem('st_token', k); } catch (e) {}
      params.delete('k');
      const qs = params.toString();
      const newUrl = window.location.pathname + (qs ? '?' + qs : '') + window.location.hash;
      window.history.replaceState({}, document.title, newUrl);
    }
    let token = sessionStorage.getItem('st_token');
    if (!token) {
      try {
        token = localStorage.getItem('st_token');
        if (token) sessionStorage.setItem('st_token', token);
      } catch (e) {}
    }
    return token;
  }

  function buildWaUrl(noteText) {
    if (!gallery || !gallery.editorWa) return '';
    const currentUrl = window.location.href;
    const teksWa = `Halo, saya *${gallery.title}* sudah selesai memilih *${sel.size}* berkas.\n\nLink Galeri: ${currentUrl}\nCatatan: ${noteText || '-'}`;
    return `https://wa.me/${gallery.editorWa}?text=${encodeURIComponent(teksWa)}`;
  }

  function saveLocalDraft() {
    const token = sessionStorage.getItem('st_token') || localStorage.getItem('st_token');
    if (!token || isLocked) return;
    try {
      localStorage.setItem('st_draft_' + token, JSON.stringify({
        ids: [...sel],
        note: statusData.note || '',
        updatedAt: Date.now()
      }));
    } catch (e) {}
  }

  async function init() {
    const token = getUrlToken();
    if (!token) return renderError('Link tidak valid. Pastikan Anda membuka link lengkap yang diberikan oleh editor.');

    try {
      gallery = await apiFetch('/client/gallery');
      statusData = {
        status: gallery.status || 'unstarted',
        note: gallery.note || '',
        selectedIds: Array.isArray(gallery.selectedIds) ? gallery.selectedIds : []
      };
      sel = new Set(statusData.selectedIds);
      isLocked = statusData.status === 'submitted';

      // Lapisan 3: LocalStorage Draft Auto-Recovery
      if (!isLocked && token) {
        try {
          const rawDraft = localStorage.getItem('st_draft_' + token);
          if (rawDraft) {
            const draft = JSON.parse(rawDraft);
            if (draft && Array.isArray(draft.ids) && draft.ids.length > 0 && sel.size === 0) {
              draft.ids.forEach(id => sel.add(id));
              if (draft.note && !statusData.note) {
                statusData.note = draft.note;
              }
              dirtyIds = true;
              if (draft.note) dirtyNote = true;
              setTimeout(() => flushAutoSave(false), 800);
              toast('Draft pilihan berhasil dipulihkan dari perangkat Anda.', 'info');
            }
          }
        } catch (e) {}
      }

      renderApp();
      const isWedding = gallery.category === 'wedding';
      document.title = (isWedding ? '💍 ' : '') + gallery.title + (isWedding ? ' | Wedding Gallery' : ' - Pilih Foto');
      await loadPhotos();
    } catch (err) {
      renderError(err.message || 'Gagal memuat galeri.');
    }
  }

  // B4 & D7: Muat daftar foto & video dengan penanganan khusus saat Drive tidak tersedia (503)
  async function loadPhotos() {
    const statusEl = $('st-status');
    if (statusEl) {
      statusEl.innerHTML = 'Memuat daftar berkas...';
    }
    try {
      photos = sortByName(await apiFetch('/client/photos'));
      const photoCount = photos.filter(p => p.mediaType !== 'video').length;
      const videoCount = photos.filter(p => p.mediaType === 'video').length;
      if (statusEl) {
        if (!photos.length) {
          statusEl.textContent = 'Belum ada foto atau video di folder ini.';
        } else if (videoCount > 0) {
          statusEl.textContent = `${photos.length} berkas ditemukan (${photoCount} foto, ${videoCount} video).`;
        } else {
          statusEl.textContent = `${photos.length} foto ditemukan.`;
        }
      }
      renderFilterTabs();
      renderSkeleton();
    } catch (err) {
      if (statusEl) {
        statusEl.innerHTML = `
          <div class="st-banner" style="justify-content: space-between; flex-wrap: wrap; border-color: #ff4d4f;">
            <span style="color: #ff4d4f;">⚠️ ${esc(err.message || 'Daftar berkas belum bisa dimuat. Coba lagi sebentar.')}</span>
            <button type="button" class="st-btn st-btn-outline" id="st-retryPhotosBtn" style="height: 36px; font-size: 14px; padding: 0 16px;">↻ Coba Lagi</button>
          </div>
        `;
        const retryBtn = $('st-retryPhotosBtn');
        if (retryBtn) retryBtn.onclick = () => loadPhotos();
      }
    }
  }

  function renderError(msg) {
    $('st-app').innerHTML = `
      <div class="st-container" style="padding: 64px 16px; text-align: center;">
        <div style="background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-lg); padding: 32px; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #ff4d4f; margin-bottom: 12px;">Akses Galeri Gagal</h2>
          <p class="st-text-muted" style="margin: 0 auto;">${esc(msg)}</p>
        </div>
      </div>
    `;
  }

  function renderFilterTabs() {
    const container = $('st-filterContainer');
    const tabs = $('st-filterTabs');
    if (!container || !tabs) return;

    const sourceList = inResultView ? resultPhotos : photos;
    const photoCount = sourceList.filter(p => p.mediaType !== 'video').length;
    const videoCount = sourceList.filter(p => p.mediaType === 'video').length;

    if (videoCount === 0) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'block';
    tabs.innerHTML = `
      <button type="button" class="st-filter-tab ${currentMediaTypeFilter === 'all' ? 'st-active' : ''}" data-filter="all">Semua (${sourceList.length})</button>
      <button type="button" class="st-filter-tab ${currentMediaTypeFilter === 'photo' ? 'st-active' : ''}" data-filter="photo">📷 Foto (${photoCount})</button>
      <button type="button" class="st-filter-tab ${currentMediaTypeFilter === 'video' ? 'st-active' : ''}" data-filter="video">🎬 Video (${videoCount})</button>
    `;

    tabs.querySelectorAll('.st-filter-tab').forEach(b => {
      b.onclick = () => {
        currentMediaTypeFilter = b.dataset.filter;
        renderFilterTabs();
        renderSkeleton(inResultView ? resultPhotos : null);
      };
    });
  }

  function renderApp() {
    const isWedding = gallery.category === 'wedding';
    const appEl = $('st-app');
    if (appEl) {
      if (isWedding) {
        appEl.classList.add('st-client--wedding');
      } else {
        appEl.classList.remove('st-client--wedding');
      }
    }

    const defaultSubtitle = isWedding
      ? 'Pilih foto & video kenangan pernikahan Anda (Tanpa batas kuota). Pilihan tersimpan otomatis.'
      : 'Ketuk foto yang ingin diedit. Pilihan tersimpan otomatis.';

    $('st-app').innerHTML = `
      <header class="st-header-section">
        <div class="st-container" style="display: flex; flex-direction: column; gap: var(--st-space-3);">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <h1 id="st-title" style="margin: 0;">${esc(gallery.title)}</h1>
            ${isWedding ? '<span class="st-badge-wedding-title">💍 Wedding Gallery</span>' : ''}
          </div>
          <p id="st-subtitle" class="st-text-muted" style="margin-bottom: 0;">${defaultSubtitle}</p>
        </div>
      </header>

      ${gallery.hasResult ? `
      <div class="st-container" id="st-resultBanner" style="margin-bottom: 16px;">
        <div style="background: rgba(37, 211, 102, 0.1); border: 1px solid rgba(37, 211, 102, 0.3); color: #4ade80; padding: 16px; border-radius: 12px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 15px;">
            <span style="font-size: 20px;">🎉</span> Berkas hasil edit sudah tersedia!
          </div>
          <button class="st-btn st-btn-primary" id="st-showResultBtn" style="background: #25D366; border-color: #25D366; color: #111; font-weight: 700;">Lihat Hasil Edit</button>
        </div>
      </div>
      ` : ''}

      <div class="st-container" id="st-bannerContainer" style="display: none;">
        <div class="st-banner" id="st-bannerContent"></div>
      </div>

      <div class="st-container" style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div id="st-status" class="st-text-muted st-mb-4" role="status">Memuat data berkas...</div>
      </div>

      <div class="st-container" id="st-filterContainer" style="display: none; padding-top: 0;">
        <div class="st-filter-tabs" id="st-filterTabs"></div>
      </div>

      <main class="st-container st-photo-grid" id="st-grid"></main>

      <div class="st-bottom-bar" id="st-bottomBar">
        <div class="st-bottom-bar-title">
          <span id="st-count" aria-live="polite">0 item dipilih</span>
          <div class="st-bottom-bar-progress" id="st-progressWrap" style="display: none;"><div class="st-bottom-bar-progress-fill" id="st-progressFill"></div></div>
          <span id="st-saveStatus" class="st-save-status" aria-live="polite"></span>
        </div>
        <div class="st-bottom-bar-actions">
          <button class="st-btn st-btn-outline" id="st-allBtn">Pilih semua</button>
          <button class="st-btn st-btn-outline" id="st-resetBtn">Hapus pilihan</button>
          <button class="st-btn st-btn-primary" id="st-sendBtn" disabled>Kirim ke editor</button>
        </div>
      </div>

      <!-- Lightbox -->
      <div id="st-lb" class="st-lightbox" role="dialog" aria-modal="true">
        <div class="st-lightbox-header">
          <button class="st-lightbox-nav" style="position: static; transform: none; background: transparent;" id="st-closeBtn" aria-label="Tutup">✕</button>
        </div>
        <div class="st-lightbox-content" id="st-lbContent">
          <button class="st-lightbox-nav st-lightbox-prev" id="st-prevBtn" aria-label="Sebelumnya">‹</button>
          <img id="st-lbimg" class="st-lightbox-img" alt="">
          <iframe id="st-lbvideo" class="st-lightbox-video" style="display: none;" allow="autoplay; fullscreen" allowfullscreen></iframe>
          <button class="st-lightbox-nav st-lightbox-next" id="st-nextBtn" aria-label="Berikutnya">›</button>
        </div>
        <div class="st-lightbox-footer">
          <span id="st-lbname" style="font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
          <div style="display: flex; gap: 8px; align-items: center;">
            <button class="st-btn st-btn-primary" id="st-lbselBtn"></button>
            <a id="st-lbDownloadBtn" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-outline" style="display: none;">Unduh</a>
          </div>
        </div>
      </div>

      <!-- Dialog Submit -->
      <div id="st-dlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-dlg" class="st-dialog">
        <div id="st-dlgForm">
          <h2>Kirim Pilihan ke Editor</h2>
          <p class="st-text-muted" style="font-size: 14px;">Kamu memilih <span id="st-dlgCount" style="font-weight:bold; color:var(--st-text);"></span> berkas.</p>
          <textarea id="st-note" placeholder="Catatan tambahan untuk editor (opsional)..."></textarea>
          <div style="display: flex; gap: var(--st-space-2); justify-content: flex-end; flex-wrap: wrap;">
            <button class="st-btn st-btn-outline" id="st-closeDlgBtn">Batal</button>
            <button class="st-btn st-btn-primary" id="st-confirmSubmitBtn">Kirim Sekarang</button>
          </div>
        </div>
        <div id="st-dlgSuccess" style="display: none; text-align: center;">
          <h2>Berhasil Terkirim! 🎉</h2>
          <p class="st-text-muted" style="margin-bottom: 24px;">Pilihan kamu sudah dikunci. Beri tahu editor agar pesanan segera diproses.</p>
          <a href="#" id="st-waBtn" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-primary" style="background: #25D366; border-color: #25D366; color: white; width: 100%; display: none; align-items: center; justify-content: center;">
            💬 Hubungi Editor via WhatsApp
          </a>
          <button class="st-btn st-btn-outline" style="margin-top: 16px; width: 100%;" id="st-closeSuccessBtn">Tutup</button>
        </div>
      </div>
    `;

    $('st-note').value = statusData.note || '';
    bindEvents();
    checkStatus();
  }

  function setSaveStatus(text, stateClass = '') {
    const el = $('st-saveStatus');
    if (!el) return;
    el.textContent = text;
    el.className = 'st-save-status' + (stateClass ? ' ' + stateClass : '');
  }

  function checkStatus() {
    if (inResultView) return;
    isLocked = statusData.status === 'submitted';
    const bC = $('st-bannerContainer');
    const bText = $('st-bannerContent');
    const isWedding = gallery.category === 'wedding';
    const maxSelect = isWedding ? 0 : gallery.maxSelect;
    let overLimit = false;

    if (maxSelect && sel.size > maxSelect && !isLocked) {
      overLimit = true;
      bC.style.display = 'block';
      bText.className = 'st-banner st-locked';
      bText.innerHTML = `<span>⚠️ Batas diubah menjadi ${maxSelect}. Kurangi ${sel.size - maxSelect} foto sebelum mengirim.</span>`;
    } else if (isLocked) {
      bC.style.display = 'block';
      bText.className = 'st-banner st-locked';
      const waUrl = buildWaUrl(statusData.note);
      bText.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; flex-wrap: wrap; gap: 12px;">
          <span>🔒 Pilihan terkirim dan saat ini dikunci. Hubungi editor jika ingin mengubah pilihan.</span>
          ${waUrl ? `<a href="${esc(waUrl)}" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-primary" style="background: #25D366; border-color: #25D366; color: #111; height: 36px; padding: 0 14px; font-size: 13px; font-weight: 700;">💬 Hubungi Editor</a>` : ''}
        </div>
      `;
      $('st-note').value = statusData.note || '';
    } else if (statusData.status === 'reopened') {
      bC.style.display = 'block';
      bText.className = 'st-banner st-reopened';
      bText.innerHTML = `<span>✨ Editor telah membuka kembali akses. Kamu bisa mengubah dan mengirim ulang pilihan foto.</span>`;
    } else {
      bC.style.display = 'none';
    }

    const hideAllBtn = (maxSelect && photos.length > maxSelect) || photos.length === 0;
    $('st-allBtn').style.display = hideAllBtn ? 'none' : 'inline-flex';
    $('st-allBtn').disabled = isLocked || overLimit;
    $('st-resetBtn').disabled = isLocked || sel.size === 0;
    $('st-sendBtn').disabled = isLocked || sel.size === 0 || overLimit;

    const hasVideos = photos.some(p => p.mediaType === 'video');
    const unitLabel = hasVideos ? 'berkas' : 'foto';

    if (maxSelect) {
      $('st-progressWrap').style.display = 'block';
      $('st-count').textContent = `${sel.size} / ${maxSelect} ${unitLabel} dipilih`;
      $('st-progressFill').style.width = Math.min((sel.size / maxSelect) * 100, 100) + '%';
      $('st-progressFill').style.background = sel.size > maxSelect ? '#D31510' : 'var(--st-accent-blue)';
    } else {
      $('st-progressWrap').style.display = 'none';
      $('st-count').textContent = `${sel.size} ${unitLabel} dipilih`;
    }
  }

  // D5: Autosave pintar (ID debounce 400ms, catatan debounce 1500ms, hanya kirim field yang berubah, retry eksponensial, keepalive flush)
  function scheduleSaveIds() {
    if (isLocked) return;
    statusData.selectedIds = [...sel];
    saveLocalDraft();
    dirtyIds = true;
    setSaveStatus('Menyimpan…', 'st-saving');
    if (idSaveTimer) clearTimeout(idSaveTimer);
    idSaveTimer = setTimeout(() => flushAutoSave(false), 400);
  }

  function scheduleSaveNote() {
    if (isLocked) return;
    saveLocalDraft();
    dirtyNote = true;
    setSaveStatus('Menyimpan…', 'st-saving');
    if (noteSaveTimer) clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => flushAutoSave(false), 1500);
  }

  async function flushAutoSave(useKeepalive = false) {
    if (isLocked || (!dirtyIds && !dirtyNote)) return;
    if (idSaveTimer) { clearTimeout(idSaveTimer); idSaveTimer = null; }
    if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

    const payload = {};
    const sendingIds = dirtyIds;
    const sendingNote = dirtyNote;

    if (sendingIds) payload.ids = [...sel];
    if (sendingNote) payload.note = statusData.note;

    dirtyIds = false;
    dirtyNote = false;

    if (useKeepalive) {
      const config = window.StudioConfig || {};
      const token = sessionStorage.getItem('st_token') || localStorage.getItem('st_token') || '';
      try {
        fetch((config.apiBase || '') + '/client/selection', {
          method: 'POST',
          keepalive: true,
          headers: {
            'Content-Type': 'application/json',
            'X-HTTP-Method-Override': 'PUT',
            'X-Studio-Token': token
          },
          body: JSON.stringify(payload)
        });
      } catch (e) {}
      return;
    }

    if (isSaving) {
      if (sendingIds) dirtyIds = true;
      if (sendingNote) dirtyNote = true;
      return;
    }

    isSaving = true;
    setSaveStatus('Menyimpan…', 'st-saving');

    try {
      await apiFetch('/client/selection', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      retryCount = 0;
      isSaving = false;
      if (dirtyIds || dirtyNote) {
        flushAutoSave(false);
      } else {
        setSaveStatus('Tersimpan ✓', 'st-saved');
      }
    } catch (err) {
      isSaving = false;
      if (sendingIds) dirtyIds = true;
      if (sendingNote) dirtyNote = true;
      retryCount = Math.min(retryCount + 1, 4);
      const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 8000);
      setSaveStatus('Gagal menyimpan, mencoba lagi…', 'st-save-err');
      retryTimer = setTimeout(() => flushAutoSave(false), delay);
    }
  }

  function getImageCandidates(pItem, isLg = false) {
    const list = [];
    const isDesktopWedding = gallery && gallery.category === 'wedding' && typeof window !== 'undefined' && window.innerWidth >= 768;
    const defaultSz = isDesktopWedding ? 800 : 400;
    const sz = isLg ? 1600 : defaultSz;

    // Pilar 2: Direct-to-CDN priority (Google Drive CDN & lh3 googleusercontent)
    if (!String(pItem.id).startsWith('demo')) {
      const gThumb = `https://drive.google.com/thumbnail?id=${encodeURIComponent(pItem.id)}&sz=w${sz}`;
      const lhThumb = `https://lh3.googleusercontent.com/d/${encodeURIComponent(pItem.id)}=w${sz}`;
      list.push(gThumb, lhThumb);
    }

    const main = isLg ? (pItem.srcLg || pItem.src) : pItem.src;
    const fallback = isLg ? (pItem.fallbackSrcLg || pItem.fallbackSrc) : pItem.fallbackSrc;
    const fallbacksList = isLg ? (pItem.fallbacksLg || pItem.fallbacks) : pItem.fallbacks;

    if (main && !list.includes(main)) list.push(main);
    if (Array.isArray(fallbacksList)) {
      fallbacksList.forEach(u => {
        if (u && !list.includes(u)) list.push(u);
      });
    }
    if (fallback && !list.includes(fallback)) list.push(fallback);

    return list;
  }

  // D2, D3, D7: Render grid sekali per mode tampilan, img native lazy + fetchpriority, multi-candidate fallback
  function attachCardImage(card, pItem, i, forceBust = false) {
    let img = card.querySelector('img');
    if (img) img.remove();

    const candidates = getImageCandidates(pItem, false);
    if (!candidates.length) {
      card.classList.add('st-img-error');
      return;
    }

    img = document.createElement('img');
    const isWedding = gallery && gallery.category === 'wedding';
    if (!isWedding) {
      img.width = 400;
      img.height = 400;
    }
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.alt = pItem.name || '';
    if (i < 12) {
      img.loading = 'eager';
      img.fetchPriority = 'high';
    } else {
      img.loading = 'lazy';
      img.fetchPriority = 'low';
    }

    let attempt = 0;
    img.onload = () => {
      card.classList.remove('st-img-error');
      card.classList.add('st-img-loaded');
    };
    img.onerror = () => {
      attempt++;
      if (attempt < candidates.length) {
        const nextUrl = candidates[attempt];
        img.src = forceBust ? (nextUrl + (nextUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()) : nextUrl;
      } else {
        card.classList.add('st-img-error');
      }
    };

    const firstUrl = candidates[0];
    img.src = forceBust ? (firstUrl + (firstUrl.includes('?') ? '&' : '?') + '_t=' + Date.now()) : firstUrl;
    card.prepend(img);
  }

  // Pilar 1: Progressive DOM Chunking (Virtual Grid dengan Sentinel IntersectionObserver)
  const CHUNK_SIZE = 40;
  let renderedCount = 0;
  let activeRenderList = [];
  let isCurrentResultView = false;
  let gridObserver = null;

  // Wedding Multi-Column Masonry State
  let weddingColElements = [];
  let currentWeddingCols = 0;

  function getWeddingColumnCount() {
    const w = window.innerWidth;
    if (w >= 768) return 3; // Desktop & Tablet: 3 kolom pas memuat ~5 foto per frame
    return 2;              // Mobile: tetap 2 kolom
  }

  function renderNextChunk() {
    if (!activeRenderList || renderedCount >= activeRenderList.length) {
      removeSentinel();
      return;
    }

    const grid = $('st-grid');
    if (!grid) return;

    const isWedding = gallery && gallery.category === 'wedding' && weddingColElements.length > 0;
    const colCount = isWedding ? weddingColElements.length : 1;

    const nextBatch = activeRenderList.slice(renderedCount, renderedCount + CHUNK_SIZE);
    const frag = document.createDocumentFragment();

    nextBatch.forEach((p, idx) => {
      const overallIndex = renderedCount + idx;
      const isVideo = p.mediaType === 'video';
      const durLabel = isVideo ? (p.durationMs ? `▶ ${formatDuration(p.durationMs)}` : '🎬 VIDEO') : '';
      const c = document.createElement('div');
      c.className = 'st-photo-card' + (!isCurrentResultView && sel.has(p.id) ? ' st-selected' : '');
      c.dataset.i = overallIndex;
      c.dataset.id = p.id;
      c.innerHTML = `
        <div class="st-img-retry-wrap">
          <span>Gagal memuat pratinjau</span>
          <button type="button" class="st-retry-img-btn" data-i="${overallIndex}">↻ Muat ulang</button>
        </div>
        <div class="st-photo-card__overlay"></div>
        ${isVideo ? `<div class="st-badge-video">${durLabel}</div><button class="st-play-center-btn" type="button" aria-label="Putar video" tabindex="-1"><svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"/></svg></button>` : ''}
        ${isCurrentResultView ? '' : '<div class="st-badge-check">✓</div>'}
        <div class="st-badge-name" title="${esc(p.name)}">${esc(p.name)}</div>
        <button class="st-zoom-btn" type="button" aria-label="${isVideo ? 'Putar Video' : 'Perbesar'}" tabindex="-1">${isVideo ? '▶' : '⤢'}</button>
      `;
      attachCardImage(c, p, overallIndex);
      if (!isCurrentResultView) {
        cardMap.set(p.id, c);
      }
      if (isWedding) {
        weddingColElements[overallIndex % colCount].appendChild(c);
      } else {
        frag.appendChild(c);
      }
    });

    renderedCount += nextBatch.length;

    if (!isWedding) {
      const sentinel = $('st-grid-sentinel');
      if (sentinel) {
        grid.insertBefore(frag, sentinel);
      } else {
        grid.appendChild(frag);
      }
    }

    if (renderedCount >= activeRenderList.length) {
      removeSentinel();
    }
  }

  function setupSentinel() {
    removeSentinel();
    if (renderedCount >= activeRenderList.length) return;

    const grid = $('st-grid');
    if (!grid) return;

    const sentinel = document.createElement('div');
    sentinel.id = 'st-grid-sentinel';
    sentinel.style.width = '100%';
    sentinel.style.height = '60px';
    sentinel.style.gridColumn = '1 / -1';
    sentinel.style.display = 'flex';
    sentinel.style.alignItems = 'center';
    sentinel.style.justifyContent = 'center';
    sentinel.style.color = 'var(--st-text-muted)';
    sentinel.style.fontSize = '14px';
    sentinel.textContent = 'Memuat berkas lainnya...';
    grid.appendChild(sentinel);

    if ('IntersectionObserver' in window) {
      gridObserver = new IntersectionObserver((entries) => {
        if (entries[0] && entries[0].isIntersecting) {
          renderNextChunk();
        }
      }, { rootMargin: '400px' });
      gridObserver.observe(sentinel);
    } else {
      while (renderedCount < activeRenderList.length) {
        renderNextChunk();
      }
    }
  }

  function removeSentinel() {
    if (gridObserver) {
      gridObserver.disconnect();
      gridObserver = null;
    }
    const sentinel = $('st-grid-sentinel');
    if (sentinel) sentinel.remove();
  }

  function renderSkeleton(forceResultPhotos = null) {
    isCurrentResultView = Array.isArray(forceResultPhotos);
    const source = isCurrentResultView ? forceResultPhotos : photos;
    if (currentMediaTypeFilter === 'photo') {
      activeRenderList = source.filter(p => p.mediaType !== 'video');
    } else if (currentMediaTypeFilter === 'video') {
      activeRenderList = source.filter(p => p.mediaType === 'video');
    } else {
      activeRenderList = source;
    }

    const grid = $('st-grid');
    grid.innerHTML = '';
    cardMap.clear();
    renderedCount = 0;
    weddingColElements = [];

    const isWedding = gallery && gallery.category === 'wedding';
    if (isWedding) {
      const colCount = getWeddingColumnCount();
      currentWeddingCols = colCount;
      const masonryWrap = document.createElement('div');
      masonryWrap.className = 'st-wedding-masonry';
      masonryWrap.id = 'st-wedding-masonry';
      for (let i = 0; i < colCount; i++) {
        const col = document.createElement('div');
        col.className = 'st-wedding-col';
        masonryWrap.appendChild(col);
        weddingColElements.push(col);
      }
      grid.appendChild(masonryWrap);
    }

    renderNextChunk();

    if (renderedCount < activeRenderList.length) {
      setupSentinel();
    }

    if (!isCurrentResultView) {
      checkStatus();
    }
    updateOpacity();
  }

  // D2: Opacity & lock overlay cukup toggle class pada #st-grid
  function updateOpacity() {
    const grid = $('st-grid');
    if (!grid) return;
    const limitReached = !inResultView && Boolean(gallery && gallery.maxSelect && sel.size >= gallery.maxSelect);
    grid.classList.toggle('st-limit-reached', limitReached);
    grid.classList.toggle('st-grid-locked', !inResultView && isLocked);
  }

  function toggle(id) {
    if (isLocked) {
      toast('Pilihan sudah dikunci. Hubungi editor jika ingin mengubah pilihan.', 'warning');
      return;
    }
    if (!sel.has(id) && gallery.maxSelect && sel.size >= gallery.maxSelect) {
      toast(`Maksimal pilihan adalah ${gallery.maxSelect} foto`, 'warning');
      return;
    }
    const willSelect = !sel.has(id);
    if (willSelect) sel.add(id);
    else sel.delete(id);

    const cardEl = cardMap.get(id);
    if (cardEl) cardEl.classList.toggle('st-selected', willSelect);

    updateOpacity();
    scheduleSaveIds();
    checkStatus();
    if ($('st-lb').classList.contains('st-open')) updateLbBtn();
  }

  let currentLbList = [];
  let currentLbResultMode = false;

  function openLb(i, list, isResult = false) {
    if (!list || !list.length) return;
    cur = i;
    currentLbList = list;
    currentLbResultMode = isResult;
    $('st-lb').classList.add('st-open');
    showLb();
  }

  // D6: Prefetch tetangga kiri/kanan pada w=1600 dan pakai srcLg
  function prefetchLbNeighbors() {
    if (!currentLbList || currentLbList.length <= 1) return;
    const len = currentLbList.length;
    [(cur + 1) % len, (cur - 1 + len) % len].forEach(idx => {
      const item = currentLbList[idx];
      if (item && item.mediaType !== 'video' && (item.srcLg || item.src)) {
        const pre = new Image();
        pre.referrerPolicy = 'no-referrer';
        pre.src = item.srcLg || item.src;
      }
    });
  }

  function showLb() {
    const p = currentLbList[cur];
    if (!p) return;
    const lbImg = $('st-lbimg');
    const lbVideo = $('st-lbvideo');
    const isVideo = p.mediaType === 'video';

    if (isVideo) {
      lbImg.style.display = 'none';
      lbImg.src = '';
      if (lbVideo) {
        lbVideo.style.display = 'block';
        const prevUrl = p.previewUrl || `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/preview`;
        lbVideo.src = prevUrl;
      }
    } else {
      if (lbVideo) {
        lbVideo.style.display = 'none';
        lbVideo.src = '';
      }
      lbImg.style.display = 'block';
      lbImg.referrerPolicy = 'no-referrer';
      const candidates = getImageCandidates(p, true);
      let attempt = 0;
      lbImg.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          lbImg.src = candidates[attempt];
        }
      };
      lbImg.src = candidates[0] || p.srcLg || p.src;
    }

    $('st-lbname').textContent = p.name;
    if (!isVideo) prefetchLbNeighbors();

    const isDemo = String(p.id).startsWith('demo');
    const dlBtn = $('st-lbDownloadBtn');
    if (currentLbResultMode || isVideo) {
      dlBtn.style.display = 'inline-flex';
      dlBtn.textContent = isVideo ? 'Unduh Video' : 'Unduh';
      dlBtn.href = isDemo
        ? (p.srcLg || p.src)
        : `https://drive.google.com/uc?export=download&id=${encodeURIComponent(p.id)}`;
    } else {
      dlBtn.style.display = 'none';
    }

    if (currentLbResultMode) {
      $('st-lbselBtn').style.display = 'none';
    } else {
      $('st-lbselBtn').style.display = 'inline-flex';
      updateLbBtn();
    }
  }

  function updateLbBtn() {
    const p = currentLbList[cur];
    if (!p) return;
    const isSelected = sel.has(p.id);
    const isVideo = p.mediaType === 'video';
    const itemLabel = isVideo ? 'video' : 'foto';
    const atLimit = !isSelected && gallery.maxSelect && sel.size >= gallery.maxSelect;
    $('st-lbselBtn').textContent = isSelected
      ? `Batal pilih ${itemLabel}`
      : (atLimit ? `Batas penuh (${gallery.maxSelect})` : `Pilih ${itemLabel} ini`);
    $('st-lbselBtn').disabled = isLocked || atLimit;
  }

  function exitResultView() {
    inResultView = false;
    currentMediaTypeFilter = 'all';
    $('st-title').textContent = gallery.title;
    const isWedding = gallery.category === 'wedding';
    $('st-subtitle').textContent = isWedding
      ? 'Pilih foto & video kenangan pernikahan Anda (Tanpa batas kuota). Pilihan tersimpan otomatis.'
      : 'Ketuk foto yang ingin diedit. Pilihan tersimpan otomatis.';
    if ($('st-resultBanner')) $('st-resultBanner').style.display = 'block';
    $('st-bottomBar').style.display = 'flex';
    const photoCount = photos.filter(p => p.mediaType !== 'video').length;
    const videoCount = photos.filter(p => p.mediaType === 'video').length;
    if ($('st-status')) {
      $('st-status').textContent = videoCount > 0
        ? `${photos.length} berkas ditemukan (${photoCount} foto, ${videoCount} video).`
        : `${photos.length} foto ditemukan.`;
    }
    renderFilterTabs();
    renderSkeleton();
  }

  function bindEvents() {
    // D1: Satu event delegation pada #st-grid
    $('st-grid').addEventListener('click', (e) => {
      const retryBtn = e.target.closest('.st-retry-img-btn');
      if (retryBtn) {
        e.stopPropagation();
        const card = retryBtn.closest('.st-photo-card');
        if (!card) return;
        const idx = parseInt(card.dataset.i, 10);
        const list = activeRenderList;
        if (list[idx]) {
          card.classList.remove('st-img-error');
          attachCardImage(card, list[idx], idx, true);
        }
        return;
      }

      const card = e.target.closest('.st-photo-card');
      if (!card) return;
      const idx = parseInt(card.dataset.i, 10);
      const list = activeRenderList;
      if (!list[idx]) return;

      if (e.target.closest('.st-zoom-btn') || e.target.closest('.st-play-center-btn') || inResultView) {
        openLb(idx, list, inResultView);
      } else {
        toggle(list[idx].id);
      }
    });

    // D2: Pilih semua & Hapus pilihan tanpa renderSkeleton ulang
    $('st-allBtn').onclick = () => {
      if (isLocked) return;
      if (gallery.maxSelect && photos.length > gallery.maxSelect) {
        toast(`Maksimal pilihan adalah ${gallery.maxSelect} foto`, 'warning');
        return;
      }
      photos.forEach(p => {
        if (!sel.has(p.id)) {
          sel.add(p.id);
          const el = cardMap.get(p.id);
          if (el) el.classList.add('st-selected');
        }
      });
      updateOpacity();
      scheduleSaveIds();
      checkStatus();
      toast(`Semua ${photos.length} foto berhasil dipilih`, 'success');
    };

    $('st-resetBtn').onclick = async () => {
      if (isLocked || !sel.size) return;
      const ok = await confirmDialog({
        title: 'Hapus Semua Pilihan?',
        message: `Sebanyak ${sel.size} foto yang sudah Anda pilih akan dibatalkan pilihannya.`,
        confirmText: 'Ya, Hapus Pilihan',
        cancelText: 'Batal',
        variant: 'danger'
      });
      if (ok) {
        sel.forEach(id => {
          const el = cardMap.get(id);
          if (el) el.classList.remove('st-selected');
        });
        sel.clear();
        updateOpacity();
        scheduleSaveIds();
        checkStatus();
        toast('Semua pilihan foto telah dihapus', 'info');
      }
    };

    const step = d => {
      if (!currentLbList.length) return;
      if ($('st-lbvideo')) $('st-lbvideo').src = '';
      cur = (cur + d + currentLbList.length) % currentLbList.length;
      showLb();
    };
    $('st-prevBtn').onclick = () => step(-1);
    $('st-nextBtn').onclick = () => step(1);
    $('st-closeBtn').onclick = () => {
      $('st-lb').classList.remove('st-open');
      $('st-lbimg').src = '';
      if ($('st-lbvideo')) $('st-lbvideo').src = '';
    };
    $('st-lbselBtn').onclick = () => {
      if (currentLbList[cur]) toggle(currentLbList[cur].id);
    };

    let touchStartX = 0;
    $('st-lbContent').addEventListener('touchstart', e => {
      if (e.changedTouches && e.changedTouches[0]) {
        touchStartX = e.changedTouches[0].screenX;
      }
    }, { passive: true });
    $('st-lbContent').addEventListener('touchend', e => {
      if (e.changedTouches && e.changedTouches[0]) {
        const dx = e.changedTouches[0].screenX - touchStartX;
        if (Math.abs(dx) > 40) step(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    document.addEventListener('keydown', e => {
      if (!$('st-lb').classList.contains('st-open')) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      if (e.key === 'Escape') $('st-closeBtn').click();
    });

    $('st-note').addEventListener('input', () => {
      statusData.note = $('st-note').value;
      scheduleSaveNote();
    });

    // D5: Flush dengan keepalive saat tab ditutup / disembunyikan
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushAutoSave(true);
      }
    });
    window.addEventListener('pagehide', () => {
      flushAutoSave(true);
    });

    $('st-sendBtn').onclick = () => {
      const hasVideos = photos.some(p => p.mediaType === 'video');
      const unitLabel = hasVideos ? 'berkas' : 'foto';
      $('st-dlgCount').textContent = sel.size + ' ' + unitLabel;
      $('st-note').value = statusData.note || '';
      $('st-dlgForm').style.display = 'block';
      $('st-dlgSuccess').style.display = 'none';
      openDialog('st-dlg');
    };

    $('st-closeDlgBtn').onclick = () => closeDialog('st-dlg');
    $('st-closeSuccessBtn').onclick = () => closeDialog('st-dlg');

    $('st-confirmSubmitBtn').onclick = async () => {
      if (idSaveTimer) { clearTimeout(idSaveTimer); idSaveTimer = null; }
      if (noteSaveTimer) { clearTimeout(noteSaveTimer); noteSaveTimer = null; }
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      dirtyIds = false;
      dirtyNote = false;

      $('st-confirmSubmitBtn').disabled = true;
      try {
        const note = $('st-note').value;
        await apiFetch('/client/submit', {
          method: 'POST',
          body: JSON.stringify({ ids: [...sel], note })
        });
        statusData.status = 'submitted';
        statusData.note = note;
        isLocked = true;
        const curToken = sessionStorage.getItem('st_token') || localStorage.getItem('st_token');
        if (curToken) {
          try { localStorage.removeItem('st_draft_' + curToken); } catch (e) {}
        }
        setSaveStatus('Terkirim ✓', 'st-saved');
        checkStatus();
        updateOpacity();
        toast('Pilihan berkas berhasil dikirim & dikunci!', 'success');

        $('st-dlgForm').style.display = 'none';
        $('st-dlgSuccess').style.display = 'block';

        const waUrl = buildWaUrl(note);
        if (waUrl) {
          $('st-waBtn').href = waUrl;
          $('st-waBtn').style.display = 'flex';
        }
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        $('st-confirmSubmitBtn').disabled = false;
      }
    };

    if ($('st-showResultBtn')) {
      $('st-showResultBtn').onclick = async () => {
        const btn = $('st-showResultBtn');
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Memuat...';
        try {
          const res = await apiFetch('/client/result');
          inResultView = true;
          currentMediaTypeFilter = 'all';
          resultPhotos = sortByName(Array.isArray(res.files) ? res.files : []);
          const isWedding = gallery.category === 'wedding';
          $('st-title').textContent = 'Hasil Edit: ' + gallery.title;
          $('st-subtitle').textContent = isWedding
            ? 'Ketuk foto atau video untuk melihat atau mengunduh hasil edit pernikahan Anda.'
            : 'Ketuk foto untuk memperbesar atau mengunduh hasil edit.';
          const isDemoFolder = !res.folderId || String(res.folderId).startsWith('demo');
          const filesCount = resultPhotos.length;
          const photoCount = resultPhotos.filter(p => p.mediaType !== 'video').length;
          const videoCount = resultPhotos.filter(p => p.mediaType === 'video').length;

          $('st-status').innerHTML = `
            <div style="display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 8px;">
              <button type="button" class="st-btn st-btn-outline" id="st-backToSelectBtn">← Kembali ke Pilihan Berkas</button>
              ${!isDemoFolder ? `<a href="https://drive.google.com/drive/folders/${encodeURIComponent(res.folderId)}" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-secondary">📂 Buka Folder di Google Drive</a>` : ''}
            </div>
            <div class="st-text-muted">${filesCount ? (videoCount > 0 ? `${filesCount} berkas hasil edit (${photoCount} foto, ${videoCount} video).` : `${filesCount} foto hasil edit tersedia.`) : 'Belum ada berkas di folder hasil edit ini.'}</div>
          `;
          if ($('st-backToSelectBtn')) {
            $('st-backToSelectBtn').onclick = exitResultView;
          }
          $('st-bottomBar').style.display = 'none';
          $('st-bannerContainer').style.display = 'none';
          if ($('st-resultBanner')) $('st-resultBanner').style.display = 'none';
          renderFilterTabs();
          renderSkeleton(resultPhotos);
        } catch (e) {
          toast(e.message);
        } finally {
          btn.disabled = false;
          btn.textContent = origText;
        }
      };
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!gallery || gallery.category !== 'wedding') return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const newColCount = getWeddingColumnCount();
      if (newColCount !== currentWeddingCols && photos.length > 0) {
        renderSkeleton(inResultView ? resultPhotos : null);
      }
    }, 150);
  });

  init();
})();

