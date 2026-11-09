/* studio-editor.js */
(function() {
  const { apiFetch, esc, openDialog, closeDialog, toast, confirmDialog, copyText, toAbsoluteUrl, extractFolderId } = window.StudioApp;

  let currentCategory = (window.StudioConfig && window.StudioConfig.category) ||
    (window.location.pathname.includes('/wedding') ? 'wedding' : 'studio');

  let galleries = [], currentPhotos = [], currentCur = 0;
  let activeGalleryId = null, currentCsvUrl = null, pollTimer = null;
  let linkDebounce = null, resultLinkDebounce = null;

  let editorMediaTypeFilter = 'all';
  let activeEditorFilterList = [];

  const $ = id => document.getElementById(id);

  // Alphanumeric natural sort for photography filenames (e.g. IMG_1, IMG_2, IMG_10)
  const naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  function sortByName(list) {
    if (!Array.isArray(list)) return [];
    return list.slice().sort((a, b) => naturalCollator.compare(a.name || a.id || '', b.name || b.id || ''));
  }

  function formatDuration(ms) {
    if (!ms || isNaN(ms)) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function getEditorKey() {
    try {
      const url = new URL(window.location.href);
      const key = url.searchParams.get('key');
      if (key) {
        localStorage.setItem('st_editor_key', key);
        url.searchParams.delete('key');
        window.history.replaceState({}, document.title, url.pathname + url.search + url.hash);
      }
    } catch (e) {}
    if (window.StudioConfig && window.StudioConfig.isAdmin) return 'admin';
    return localStorage.getItem('st_editor_key');
  }

  async function init() {
    const key = getEditorKey();
    if (!key && !(window.StudioConfig && window.StudioConfig.isAdmin)) {
      return renderError('Link tidak valid atau sesi berakhir. Mintalah link editor terbaru dari admin.');
    }

    renderApp();
    await loadGalleries();

    if (window.StudioConfig && window.StudioConfig.isAdmin) {
      loadAdminPanel();
    }

    pollTimer = setInterval(() => {
      loadGalleries(true);
    }, 15000);
  }

  function renderError(msg) {
    if (pollTimer) clearInterval(pollTimer);
    $('st-app').innerHTML = `
      <div class="st-container" style="padding: 64px 16px; text-align: center;">
        <div style="background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-xl); padding: 32px; max-width: 520px; margin: 0 auto;">
          <h2 style="color: #ff4d4f; margin-bottom: 12px;">Akses Ditolak</h2>
          <p class="st-text-muted" style="margin: 0 auto;">${esc(msg)}</p>
        </div>
      </div>
    `;
  }

  async function switchCategory(cat) {
    if (currentCategory === cat) return;
    currentCategory = cat;
    const basePath = (window.StudioConfig && window.StudioConfig.basePath) !== undefined
      ? window.StudioConfig.basePath
      : (window.location.pathname.startsWith('/studioapp') ? '/studioapp' : '');
    window.history.pushState({}, '', `${basePath}/${cat}/editor`);
    if (window.StudioConfig) {
      window.StudioConfig.category = cat;
      window.StudioConfig.clientPageUrl = `${basePath}/${cat}/client`;
    }
    document.title = cat === 'wedding'
      ? 'Wedding Editor - Manajemen Galeri Pernikahan'
      : 'Studio Editor - Manajemen Galeri';
    closeDetailPanel();
    renderApp();
    await loadGalleries();
  }

  function renderApp() {
    const isWedding = currentCategory === 'wedding';

    $('st-app').innerHTML = `
      <header class="st-header-section">
        <div class="st-container" style="display: flex; flex-direction: column; gap: var(--st-space-3);">
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--st-space-3);">
            <div>
              <h1 id="st-title">${isWedding ? '💍 Dashboard Editor Wedding' : '📸 Dashboard Editor'}</h1>
              <p class="st-text-muted" id="st-subtitle" style="margin-bottom: 0;">${isWedding ? 'Pantau dan kelola pilihan foto & video pernikahan tanpa batas.' : 'Pantau dan kelola pilihan foto dari klien.'}</p>
            </div>
            <div class="st-mode-nav">
              <button type="button" class="st-mode-btn ${!isWedding ? 'st-mode-btn--active' : ''}" id="st-modeStudioBtn">📸 Mode Studio</button>
              <button type="button" class="st-mode-btn ${isWedding ? 'st-mode-btn--active' : ''}" id="st-modeWeddingBtn">💍 Mode Wedding</button>
            </div>
          </div>
          <div style="display: flex; gap: var(--st-space-2); margin-top: 8px; flex-wrap: wrap;">
            <button class="st-btn st-btn-primary" id="st-settingsBtn">💬 Pengaturan WA</button>
            <button class="st-btn st-btn-outline" id="st-backupBtn">📦 Backup & Migrasi</button>
          </div>
        </div>
      </header>

      <div class="st-container" id="st-adminPanel" style="display: none; margin-bottom: 24px;"></div>

      <main class="st-container st-editor-main" id="st-main">
        <div id="st-listPanel" class="st-editor-list-panel">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: var(--st-space-4); flex-wrap: wrap; gap: var(--st-space-3);">
            <h2 style="margin: 0;">Daftar Galeri ${isWedding ? 'Wedding' : 'Studio'}</h2>
            <div style="display: flex; gap: var(--st-space-2);">
              <button class="st-btn st-btn-primary" style="height: 36px; font-size: 14px;" id="st-newGalleryBtn">+ Galeri Baru</button>
              <button class="st-btn st-btn-outline" style="height: 36px; font-size: 14px;" id="st-refreshBtn">↻ Refresh</button>
            </div>
          </div>
          <div id="st-clientsList">Memuat...</div>
        </div>

        <div id="st-detailPanel" class="st-editor-detail-panel" style="display: none;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--st-space-3); margin-bottom: var(--st-space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: var(--st-space-3); flex-wrap: wrap;">
              <button class="st-btn st-btn-outline" id="st-closeDetailBtn" style="height: 36px; font-size: 14px; padding: 0 14px;">← Galeri</button>
              <button type="button" class="st-sidebar-toggle-btn" id="st-toggleSidebarBtn" title="Sembunyikan panel daftar galeri untuk memperlebar foto">◧ Sembunyikan Sidebar</button>
              <div>
                <h2 id="st-detailTitle" style="margin: 0;">Detail Galeri</h2>
                <small id="st-detailSyncInfo" class="st-text-muted" style="font-size: 12px;"></small>
              </div>
            </div>
          </div>
          <div id="st-detailContent"></div>
        </div>
      </main>

      <!-- Dialog Konfirmasi Perubahan Pilihan Manual -->
      <div id="st-reviewDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-reviewDlg" class="st-dialog" style="max-width: 490px;"></div>

      <!-- Dialog Unduh Batch Berkas (Direct CDN) -->
      <div id="st-downloadDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-downloadDlg" class="st-dialog" style="max-width: 540px;"></div>

      <!-- Dialog Atur Galeri -->
      <div id="st-manageDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-manageDlg" class="st-dialog">
        <h2 id="st-manageTitle">Atur Galeri</h2>
        <form id="st-manageForm">
          <input type="hidden" id="st-mId">
          <div class="st-form-group">
            <label for="st-mName">Nama Klien / Judul Galeri</label>
            <input type="text" id="st-mName" class="st-form-control" required placeholder="mis. Andi & Siska Wedding">
          </div>
          <div class="st-form-group">
            <label for="st-mLink">Link / ID Folder Mentah (Google Drive)</label>
            <input type="text" id="st-mLink" class="st-form-control" required placeholder="Paste link atau ID folder mentah...">
            <div style="margin-top: 8px; font-size: 14px;" id="st-mLinkResult"></div>
          </div>
          <div class="st-form-group">
            <label for="st-mResultLink">Link / ID Folder Hasil Edit (Opsional)</label>
            <input type="text" id="st-mResultLink" class="st-form-control" placeholder="Paste link folder hasil akhir (kosongkan jika belum ada)...">
            <div style="margin-top: 8px; font-size: 14px;" id="st-mResultLinkResult"></div>
          </div>
          <div class="st-form-group" id="st-mLimitGroup">
            <label for="st-mLimit">Batas Maksimal Foto</label>
            <input type="number" id="st-mLimit" class="st-form-control" min="0" placeholder="0 = tanpa batas">
          </div>
          <div class="st-banner" id="st-mWeddingNotice" style="display: none; border-color: #388e3c; color: #2e7d32; font-size: 13px; margin-bottom: var(--st-space-3);">
            💍 <strong>Mode Wedding:</strong> Kuota pemilihan foto & video otomatis <strong>Unlimited (Tanpa Batas)</strong>.
          </div>
          <div id="st-mTokenSection" class="st-form-group" style="display: none; padding-top: 8px; border-top: 1px solid var(--st-border);">
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
              <small class="st-text-muted">Jika link klien bocor, Anda dapat mereset token link klien:</small>
              <button type="button" class="st-btn st-btn-outline" style="height: 32px; font-size: 13px;" id="st-mRegenTokenBtn">🔑 Buat Ulang Link Klien</button>
            </div>
          </div>
          <div style="display: flex; gap: var(--st-space-2); justify-content: flex-end; margin-top: var(--st-space-5); flex-wrap: wrap;">
            <button type="button" class="st-btn st-btn-outline" style="color: #ff4d4f; border-color: #ff4d4f; margin-right: auto; display: none;" id="st-mDeleteBtn">Hapus</button>
            <button type="button" class="st-btn st-btn-outline" id="st-mCancelBtn">Batal</button>
            <button type="submit" class="st-btn st-btn-primary" id="st-mSubmit">Simpan</button>
          </div>
        </form>
      </div>

      <!-- Dialog Pengaturan WA Editor -->
      <div id="st-settingsDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-settingsDlg" class="st-dialog">
        <h2>Pengaturan WhatsApp</h2>
        <form id="st-settingsForm">
          <div class="st-form-group">
            <label for="st-sWa">Nomor WA Editor</label>
            <input type="text" id="st-sWa" class="st-form-control" placeholder="mis. 6281234567890">
            <small class="st-text-muted">Awali dengan kode negara (62) tanpa + atau 0. Kosongkan untuk menonaktifkan tombol WA di klien.</small>
          </div>
          <div style="display: flex; gap: var(--st-space-2); justify-content: flex-end; margin-top: var(--st-space-4);">
            <button type="button" class="st-btn st-btn-outline" id="st-sCancelBtn">Batal</button>
            <button type="submit" class="st-btn st-btn-primary" id="st-sSubmit">Simpan</button>
          </div>
        </form>
      </div>

      <!-- Dialog Backup & Migrasi Data (Ekspor & Impor JSON) -->
      <div id="st-backupDlg-backdrop" class="st-dialog-backdrop"></div>
      <div id="st-backupDlg" class="st-dialog" style="max-width: 540px;">
        <h2>📦 Backup & Migrasi Data (JSON)</h2>
        <p class="st-text-muted" style="margin-top: 4px; font-size: 13px;">
          Ekspor atau impor data galeri dan pengaturan dalam format JSON universal. Kompatibel penuh antara DomaiNesia (MySQL) dan Vercel (Firebase).
        </p>

        <!-- Bagian Ekspor -->
        <div style="background: rgba(0,0,0,0.03); border: 1px solid var(--st-border-color, #e2e8f0); border-radius: 8px; padding: 14px; margin-top: 14px;">
          <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700;">⬇️ Ekspor Data (Backup)</h4>
          <p class="st-text-muted" style="margin: 0 0 10px 0; font-size: 13px;">
            Unduh seluruh daftar galeri (beserta status dan pilihan foto klien) dan pengaturan sistem ke dalam file <code>.json</code>.
          </p>
          <button type="button" class="st-btn st-btn-primary" id="st-exportBtn" style="height: 36px; font-size: 13px;">
            📥 Unduh File Backup (.json)
          </button>
        </div>

        <!-- Bagian Impor -->
        <div style="background: rgba(0,0,0,0.03); border: 1px solid var(--st-border-color, #e2e8f0); border-radius: 8px; padding: 14px; margin-top: 14px;">
          <h4 style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700;">⬆️ Impor Data (Restore / Migrasi)</h4>
          <p class="st-text-muted" style="margin: 0 0 10px 0; font-size: 13px;">
            Pilih file <code>.json</code> hasil ekspor untuk dimasukkan ke sistem ini.
          </p>

          <input type="file" id="st-importFileInput" accept=".json,application/json" style="margin-bottom: 10px; font-size: 13px; width: 100%;">

          <!-- Preview Berkas Terpilih -->
          <div id="st-importPreview" style="display: none; background: #fff; border: 1px dashed #cbd5e1; border-radius: 6px; padding: 10px; font-size: 13px; margin-bottom: 12px; line-height: 1.5;"></div>

          <!-- Opsi Mode Impor -->
          <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 13px;">
            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
              <input type="radio" name="st-import-mode" value="upsert" checked style="margin-top: 2px;">
              <span><strong>Gabungkan & Perbarui (Upsert) - Direkomendasikan:</strong> Galeri yang cocok (token sama) akan diperbarui, galeri baru ditambahkan. Data galeri lama lainnya tetap aman.</span>
            </label>
            <label style="display: flex; align-items: flex-start; gap: 8px; cursor: pointer;">
              <input type="radio" name="st-import-mode" value="replace" style="margin-top: 2px;">
              <span style="color: #dc2626;"><strong>Timpa Total (Replace All):</strong> Hapus seluruh galeri lama di sistem dan ganti seutuhnya dengan isi file JSON ini.</span>
            </label>
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; margin-top: 4px;">
              <input type="checkbox" id="st-importOverwriteKey">
              <span>Ikut perbarui Kunci Editor (admin key) dari file backup</span>
            </label>
          </div>

          <button type="button" class="st-btn st-btn-primary" id="st-importSubmitBtn" style="margin-top: 14px; height: 38px; width: 100%;" disabled>
            🚀 Mulai Impor Data
          </button>
        </div>

        <div style="display: flex; justify-content: flex-end; margin-top: var(--st-space-4);">
          <button type="button" class="st-btn st-btn-outline" id="st-backupCloseBtn">Tutup</button>
        </div>
      </div>

      <!-- Lightbox Editor -->
      <div id="st-lb" class="st-lightbox" role="dialog" aria-modal="true" aria-label="Pratinjau berkas">
        <div class="st-lightbox-header">
          <button class="st-lightbox-nav" style="position: static; transform: none; background: transparent;" id="st-lbCloseBtn" aria-label="Tutup">✕</button>
        </div>
        <div class="st-lightbox-content" id="st-lbContent">
          <button class="st-lightbox-nav st-lightbox-prev" id="st-lbPrevBtn" aria-label="Sebelumnya">‹</button>
          <img id="st-lbimg" class="st-lightbox-img" alt="">
          <iframe id="st-lbvideo" class="st-lightbox-video" allow="autoplay; fullscreen" style="display: none;" title="Video Player"></iframe>
          <button class="st-lightbox-nav st-lightbox-next" id="st-lbNextBtn" aria-label="Berikutnya">›</button>
        </div>
        <div class="st-lightbox-footer">
          <span id="st-lbname" style="font-weight: 600;"></span>
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button type="button" id="st-lbSelectToggle" class="st-lb-select-btn" style="display: none;">✓ Pilih Berkas</button>
            <a id="st-lbDriveBtn" href="#" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-outline" style="height: 36px; font-size: 14px;">📥 Unduh Asli</a>
          </div>
        </div>
      </div>
    `;

    bindEvents();
  }

  function formatSyncRelative(mysqlDateStr) {
    if (!mysqlDateStr) return 'Belum pernah disinkronkan';
    const d = new Date(mysqlDateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return `Terakhir sinkron: ${mysqlDateStr}`;
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return 'Terakhir sinkron baru saja';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `Terakhir sinkron ${diffMin} menit lalu`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `Terakhir sinkron ${diffHr} jam lalu`;
    return `Terakhir sinkron ${d.toLocaleString('id-ID')}`;
  }

  async function loadAdminPanel() {
    try {
      const res = await apiFetch('/editor/key');
      const box = $('st-adminPanel');
      if (!box) return;
      const editorUrl = toAbsoluteUrl(res.url);
      box.style.display = 'block';
      box.innerHTML = `
        <div style="background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-md); padding: 16px;">
          <h3 style="margin-top:0; margin-bottom:8px;">Akses Editor (Khusus Admin)</h3>
          <p class="st-text-muted" style="margin-bottom:12px;">Berikan link ini kepada editor. Mereka tidak perlu login WordPress.</p>
          <div class="st-link-box">
            <input type="text" readonly value="${esc(editorUrl)}" style="width:100%; background:transparent; border:none; color:var(--st-text); outline:none; cursor:pointer;" id="st-editorLinkInput" title="Klik untuk memilih semua">
          </div>
          <div style="display:flex; gap:8px; flex-wrap:wrap;">
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px;" id="st-copyEditorLinkBtn">Salin Link Editor</button>
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px; color:#ff4d4f; border-color:#ff4d4f;" id="st-rotateKeyBtn">Rotasi Kunci</button>
            <button class="st-btn st-btn-outline" style="height:32px; font-size:13px;" id="st-diagBtn">🔍 Cek Diagnostik Drive</button>
          </div>
          <div id="st-diagResult" style="display:none; margin-top:12px; padding:12px; background:var(--st-bg); border:1px solid var(--st-border); border-radius:var(--st-radius-sm); font-size:13px; overflow-x:auto;"></div>
        </div>
      `;

      $('st-editorLinkInput').onclick = () => {
        $('st-editorLinkInput').select();
      };

      $('st-copyEditorLinkBtn').onclick = () => {
        copyText(editorUrl, 'Link editor disalin!');
      };

      $('st-rotateKeyBtn').onclick = async () => {
        const ok = await confirmDialog({
          title: 'Rotasi Kunci Editor?',
          message: 'Link editor yang lama akan hangus. Semua editor yang sedang menggunakan link lama harus membuka link baru.',
          confirmText: 'Ya, Rotasi Kunci',
          cancelText: 'Batal',
          variant: 'danger'
        });
        if (!ok) return;
        try {
          const resRotate = await apiFetch('/editor/key/rotate', { method: 'POST' });
          if (resRotate.key) {
            localStorage.setItem('st_editor_key', resRotate.key);
          }
          toast('Kunci berhasil dirotasi. Silakan salin link yang baru.', 'success');
          loadAdminPanel();
        } catch (e) {
          toast(e.message, 'error');
        }
      };

      $('st-diagBtn').onclick = async () => {
        const out = $('st-diagResult');
        out.style.display = 'block';
        out.textContent = 'Menjalankan diagnostik Google Drive API...';
        try {
          const d = await apiFetch('/editor/diagnostics');
          const lt = d.filesListTest || {};
          const gt = d.filesGetTest || {};
          const env = d.environment || {};
          out.innerHTML = `
            <div style="display:grid; gap:6px;">
              <div><strong>API Key Terdefinisi:</strong> ${d.keyDefined ? '✅ Ya' : '❌ Tidak (Mode Demo)'} | <strong>Folder Uji:</strong> <code>${esc(d.testedFolderId || '-')}</code></div>
              <div><strong>files.list:</strong> HTTP ${esc(lt.httpStatus ?? '-')} (${esc(lt.durationMs ?? '-')} ms) — File: ${esc(lt.fileCount ?? 0)} ${lt.errorReason ? `| ❌ Reason: <code>${esc(lt.errorReason)}</code> (${esc(lt.errorMessage || '')})` : '✅ OK'}</div>
              <div><strong>files.get:</strong> ${gt.fileId ? `ID <code>${esc(gt.fileId)}</code> → HTTP ${esc(gt.httpStatus)} (${esc(gt.durationMs)} ms) — Nama: <strong>${esc(gt.name || '-')}</strong> (${esc(gt.mimeType || '-')}) ${gt.errorReason ? `| ❌ <code>${esc(gt.errorReason)}</code>` : '✅ OK'}` : 'Belum ada sampel file'}</div>
              <div class="st-text-muted">PHP ${esc(env.phpVersion)} | DB v${esc(env.dbVersion)} | cURL ${esc(env.curlVersion)} | ObjectCache: ${env.extObjectCache ? 'Ya' : 'Tidak'} | Disk Cache: ${esc(env.cacheFileCount)} file (${esc(env.cacheSizeMb)} MB)</div>
            </div>
          `;
        } catch (e) {
          out.innerHTML = `<span style="color:#ff4d4f;">Gagal memuat diagnostik: ${esc(e.message)}</span>`;
        }
      };
    } catch (e) {
      console.error(e);
    }
  }

  async function loadGalleries(isBackground = false) {
    try {
      galleries = await apiFetch(`/editor/galleries?category=${encodeURIComponent(currentCategory)}`);
      renderGalleries();
    } catch (e) {
      if (e.status === 401 && !(window.StudioConfig && window.StudioConfig.isAdmin)) {
        localStorage.removeItem('st_editor_key');
        renderError('Kunci editor tidak valid atau telah dirotasi oleh Admin. Mintalah link editor terbaru.');
        return;
      }
      if (!isBackground && $('st-clientsList')) {
        $('st-clientsList').textContent = e.message;
      }
    }
  }

  function renderGalleries() {
    const list = $('st-clientsList');
    if (!list) return;
    const isWedding = currentCategory === 'wedding';

    if (!galleries.length) {
      list.innerHTML = `<p class="st-text-muted">Belum ada galeri ${isWedding ? 'Wedding' : 'Studio'}. Klik "+ Galeri Baru" untuk memulai.</p>`;
      return;
    }

    list.innerHTML = '';
    galleries.forEach(g => {
      const card = document.createElement('div');
      const isActive = activeGalleryId && String(activeGalleryId) === String(g.id);
      card.className = 'st-client-card' + (isActive ? ' st-client-card--active' : '');

      let statusBadge = '';
      if (g.status === 'submitted') statusBadge = '<span class="st-badge-status st-status-submitted">Terkirim 🔒</span>';
      else if (g.status === 'draft') statusBadge = '<span class="st-badge-status st-status-draft">Draft</span>';
      else if (g.status === 'reopened') statusBadge = '<span class="st-badge-status st-status-reopened">Dibuka Kembali</span>';
      else statusBadge = '<span class="st-badge-status st-status-unstarted">Belum Mulai</span>';

      const gIsWedding = g.category === 'wedding';
      const dateStr = g.updated_at ? new Date(g.updated_at.replace(' ', 'T')).toLocaleString('id-ID') : '-';
      const limitStr = (!gIsWedding && Number(g.max_select) > 0) ? ` / ${g.max_select}` : (gIsWedding ? ' (Unlimited)' : '');
      const countNum = Number(g.selected_count) || 0;
      const clientLink = toAbsoluteUrl(g.link);

      card.innerHTML = `
        <div class="st-client-card-header">
          <h3 class="st-client-card-title">${esc(g.title)} ${g.result_folder_id ? '<span title="Folder hasil edit tersedia">✅</span>' : ''}</h3>
          ${statusBadge}
        </div>
        <div class="st-text-muted" style="font-size: 14px; display: grid; gap: 4px;">
          <span>Terpilih: <strong>${countNum}${limitStr}</strong> berkas</span>
          <span>Update: ${esc(dateStr)}</span>
        </div>
        <div style="display: flex; gap: var(--st-space-2); margin-top: var(--st-space-2); flex-wrap: wrap;">
          <button type="button" class="st-btn st-btn-primary st-view-btn" data-id="${g.id}" ${countNum === 0 ? 'disabled' : ''}>Lihat Pilihan (${countNum})</button>
          <button type="button" class="st-btn st-btn-outline st-manual-select-btn" data-id="${g.id}" title="Pilih foto/video manual oleh editor">✋ Pilih Berkas</button>
          <button type="button" class="st-btn st-btn-outline st-edit-btn" data-id="${g.id}">Atur</button>
          <button type="button" class="st-btn st-btn-outline st-copy-btn" data-link="${esc(clientLink)}">Salin Link Klien</button>
          ${g.status === 'submitted' ? `<button type="button" class="st-btn st-btn-outline st-reopen-btn" data-id="${g.id}">Buka Akses</button>` : ''}
        </div>
      `;
      list.appendChild(card);
    });

    list.querySelectorAll('.st-view-btn').forEach(b => {
      b.onclick = () => viewGallery(b.dataset.id, false);
    });
    list.querySelectorAll('.st-manual-select-btn').forEach(b => {
      b.onclick = () => openManualSelectConfirm(b.dataset.id);
    });
    list.querySelectorAll('.st-edit-btn').forEach(b => {
      b.onclick = () => openManageDialog(b.dataset.id);
    });
    list.querySelectorAll('.st-copy-btn').forEach(b => {
      b.onclick = () => {
        const link = toAbsoluteUrl(b.dataset.link);
        if (!link) return toast('Link klien tidak tersedia.');
        copyText(link, 'Link klien disalin!');
      };
    });
    list.querySelectorAll('.st-reopen-btn').forEach(b => {
      b.onclick = () => reopenGallery(b.dataset.id);
    });
  }

  // --- Manage Gallery ---
  let validatedFolderId = null;
  let validatedResultFolderId = '';

  function openManageDialog(id) {
    if (linkDebounce) clearTimeout(linkDebounce);
    if (resultLinkDebounce) clearTimeout(resultLinkDebounce);

    validatedFolderId = null;
    validatedResultFolderId = '';
    $('st-mLinkResult').innerHTML = '';
    $('st-mLink').value = '';
    $('st-mResultLinkResult').innerHTML = '';
    $('st-mResultLink').value = '';

    const isWedding = currentCategory === 'wedding';
    const limitGrp = $('st-mLimitGroup');
    const weddingNotice = $('st-mWeddingNotice');
    if (limitGrp) limitGrp.style.display = isWedding ? 'none' : 'block';
    if (weddingNotice) weddingNotice.style.display = isWedding ? 'flex' : 'none';

    if (id && id !== 'new') {
      const g = galleries.find(x => String(x.id) === String(id));
      if (!g) return;
      $('st-manageTitle').textContent = 'Atur Galeri: ' + g.title;
      $('st-mId').value = g.id;
      $('st-mName').value = g.title;
      $('st-mLimit').value = isWedding ? 0 : (g.max_select || 0);
      $('st-mDeleteBtn').style.display = 'inline-flex';
      $('st-mTokenSection').style.display = 'block';

      if (g.source_folder_id) {
        validatedFolderId = g.source_folder_id;
        $('st-mLink').value = `https://drive.google.com/drive/folders/${g.source_folder_id}`;
        $('st-mLinkResult').innerHTML = `✅ ID Folder: <strong>${esc(g.source_folder_id)}</strong>`;
      }
      if (g.result_folder_id) {
        validatedResultFolderId = g.result_folder_id;
        $('st-mResultLink').value = `https://drive.google.com/drive/folders/${g.result_folder_id}`;
        $('st-mResultLinkResult').innerHTML = `✅ ID Folder: <strong>${esc(g.result_folder_id)}</strong>`;
      }
    } else {
      $('st-manageTitle').textContent = isWedding ? 'Buat Galeri Wedding Baru' : 'Buat Galeri Baru';
      $('st-mId').value = '';
      $('st-mName').value = '';
      $('st-mLimit').value = 0;
      $('st-mDeleteBtn').style.display = 'none';
      $('st-mTokenSection').style.display = 'none';
    }
    openDialog('st-manageDlg');
  }

  async function checkDriveLink(val, outEl, isOptional = false) {
    const trimmed = (val || '').trim();
    if (!trimmed) {
      if (isOptional) {
        outEl.innerHTML = '<span class="st-text-muted">Folder hasil edit dikosongkan.</span>';
        return '';
      }
      outEl.innerHTML = '<span style="color:#ff4d4f">❌ Link/ID wajib diisi</span>';
      return null;
    }

    const ext = extractFolderId(trimmed);
    if (!ext) {
      outEl.innerHTML = '<span style="color:#ff4d4f">❌ Format Link/ID Google Drive tidak valid</span>';
      return null;
    }

    outEl.innerHTML = '⏳ Mengecek folder...';
    try {
      const d = await apiFetch('/editor/drive/resolve', {
        method: 'POST',
        body: JSON.stringify({ input: ext })
      });
      const breakdown = d.videoCount > 0
        ? `${d.photoCount} foto, ${d.videoCount} video (${d.totalCount} berkas)`
        : `${d.photoCount} foto`;
      outEl.innerHTML = `✅ <strong>${esc(d.name)}</strong> — ${breakdown}`;
      return d.folderId;
    } catch (err) {
      outEl.innerHTML = `<span style="color:#ff4d4f">❌ Error: ${esc(err.message)}</span>`;
      return null;
    }
  }

  async function reopenGallery(id) {
    const ok = await confirmDialog({
      title: 'Buka Kembali Akses Klien?',
      message: 'Klien akan dapat mengubah dan mengirim ulang pilihan berkasnya.',
      confirmText: 'Ya, Buka Akses',
      cancelText: 'Batal',
      variant: 'warning'
    });
    if (!ok) return;
    try {
      await apiFetch(`/editor/galleries/${id}/reopen`, { method: 'POST' });
      toast('Akses klien berhasil dibuka kembali', 'success');
      await loadGalleries();
      if (activeGalleryId && String(activeGalleryId) === String(id)) {
        viewGallery(id, false);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function regenerateClientToken() {
    const id = $('st-mId').value;
    if (!id) return;
    const ok = await confirmDialog({
      title: 'Buat Ulang Link Klien?',
      message: 'Link klien yang lama tidak akan bisa diakses lagi. Pastikan Anda mengirimkan link baru kepada klien.',
      confirmText: 'Ya, Buat Ulang',
      cancelText: 'Batal',
      variant: 'warning'
    });
    if (!ok) return;
    try {
      const res = await apiFetch(`/editor/galleries/${id}/regenerate-token`, { method: 'POST' });
      await loadGalleries();
      const newLink = toAbsoluteUrl(res.link);
      if (newLink) {
        await copyText(newLink, 'Link klien baru berhasil dibuat & disalin!');
      } else {
        toast('Token klien berhasil diperbarui', 'success');
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function deleteGallery() {
    const id = $('st-mId').value;
    if (!id) return;
    const ok = await confirmDialog({
      title: 'Hapus Galeri Ini?',
      message: 'Galeri beserta seluruh data pilihan klien akan dihapus secara permanen.',
      confirmText: 'Ya, Hapus Galeri',
      cancelText: 'Batal',
      variant: 'danger'
    });
    if (!ok) return;
    try {
      await apiFetch(`/editor/galleries/${id}`, { method: 'DELETE' });
      toast('Galeri berhasil dihapus', 'success');
      closeDialog('st-manageDlg');
      if (activeGalleryId && String(activeGalleryId) === String(id)) {
        closeDetailPanel();
      }
      loadGalleries();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // --- Sidebar & Dropdowns ---
  let isSidebarCollapsed = localStorage.getItem('st_editor_sidebar_collapsed') === '1';

  function applySidebarState() {
    const mainEl = $('st-main');
    const toggleBtn = $('st-toggleSidebarBtn');
    if (!mainEl) return;

    if (window.innerWidth < 900) {
      if (toggleBtn) toggleBtn.style.display = 'none';
      return;
    }

    if (toggleBtn) {
      toggleBtn.style.display = activeGalleryId ? 'inline-flex' : 'none';
    }

    if (isSidebarCollapsed && activeGalleryId) {
      mainEl.classList.add('st-sidebar-collapsed');
      if (toggleBtn) {
        toggleBtn.innerHTML = '◧ Buka Daftar';
        toggleBtn.title = 'Tampilkan panel daftar galeri';
      }
    } else {
      mainEl.classList.remove('st-sidebar-collapsed');
      if (toggleBtn) {
        toggleBtn.innerHTML = '◧ Sembunyikan Sidebar';
        toggleBtn.title = 'Sembunyikan panel daftar galeri untuk memperlebar foto';
      }
    }
  }

  function toggleSidebar() {
    isSidebarCollapsed = !isSidebarCollapsed;
    localStorage.setItem('st_editor_sidebar_collapsed', isSidebarCollapsed ? '1' : '0');
    applySidebarState();
  }

  function closeAllDropdowns() {
    document.querySelectorAll('.st-dropdown-menu.st-open').forEach(el => {
      el.classList.remove('st-open');
    });
  }

  function toggleDropdown(menuId, e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const menu = $(menuId);
    if (!menu) return;
    const isOpen = menu.classList.contains('st-open');
    closeAllDropdowns();
    if (!isOpen) {
      menu.classList.add('st-open');
    }
  }

  function closeDetailPanel() {
    if (isPickerMode) {
      exitPickerMode();
      return;
    }
    closeAllDropdowns();
    activeGalleryId = null;
    $('st-detailPanel').style.display = 'none';
    $('st-listPanel').style.display = 'block';
    $('st-main').classList.remove('st-sidebar-collapsed');
    renderGalleries();
    applySidebarState();
  }

  function getImageCandidates(pItem, isLg = false) {
    const list = [];
    const sz = isLg ? 1600 : 400;

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

  // --- Direct-to-Client Batch Photo Downloader (0% Server RAM) ---
  let downloadAbortCtrl = null;

  function openBatchDownloadDialog(galleryId, initialMode = 'zip') {
    const g = galleries.find(x => String(x.id) === String(galleryId));
    const title = g?.title || $('st-detailTitle').textContent || 'Galeri';
    const note = g?.note || '';
    const photosToDownload = [...currentPhotos];

    if (!photosToDownload.length) {
      toast('Belum ada berkas yang dipilih pada galeri ini.', 'warning');
      return;
    }

    const photoItems = photosToDownload.filter(p => p.mediaType !== 'video');
    const videoItems = photosToDownload.filter(p => p.mediaType === 'video');

    const dlg = $('st-downloadDlg');
    if (!dlg) return;

    dlg.innerHTML = `
      <h2 style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
        <span>📦</span> <span>Unduh Berkas: ${esc(title)}</span>
      </h2>
      <p class="st-text-muted" style="font-size: 13.5px; margin-bottom: 12px;">
        Mengunduh berkas langsung dari server <strong>Google Drive CDN</strong> ke perangkat Anda (0% beban RAM & bandwidth server).
      </p>

      <div class="st-download-stat-grid">
        <div class="st-download-stat-card">
          <span class="st-download-stat-label">Total Berkas</span>
          <span class="st-download-stat-val">${photosToDownload.length} Berkas</span>
        </div>
        <div class="st-download-stat-card">
          <span class="st-download-stat-label">Rincian</span>
          <span class="st-download-stat-val">${photoItems.length} Foto, ${videoItems.length} Video</span>
        </div>
        <div class="st-download-stat-card">
          <span class="st-download-stat-label">Metode</span>
          <span class="st-download-stat-val" style="color: #49aa19;">Direct to Client ⚡</span>
        </div>
      </div>

      ${videoItems.length > 0 ? `
        <div style="margin-top: 14px; padding: 12px; background: var(--st-surface); border: 1px solid var(--st-border); border-radius: var(--st-radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
            <strong style="font-size: 13px;">🎬 Berkas Video (${videoItems.length}):</strong>
            <small class="st-text-muted">Unduh langsung tanpa membebani browser</small>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px; max-height: 140px; overflow-y: auto;">
            ${videoItems.map(v => `
              <div style="display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding: 4px 0; border-bottom: 1px solid var(--st-border);">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px;" title="${esc(v.name)}">${esc(v.name)}</span>
                <a href="${v.downloadUrl || `https://drive.google.com/uc?export=download&id=${encodeURIComponent(v.id)}`}" target="_blank" rel="noopener noreferrer" class="st-btn st-btn-outline" style="height: 28px; font-size: 12px; padding: 0 10px;">📥 Unduh Video</a>
              </div>
            `).join('')}
          </div>
          <small class="st-text-muted" style="display: block; margin-top: 8px;">Tautan video di atas juga tercantum lengkap di dalam berkas <code>ringkasan_pilihan.txt</code> pada paket ZIP.</small>
        </div>
      ` : ''}

      <div id="st-dlProgressSection" class="st-progress-wrap" style="display: none; margin-top: 14px;">
        <div class="st-progress-status-line">
          <span id="st-dlStatusMain">Menyiapkan...</span>
          <span id="st-dlStatusPercent" style="font-weight: 700;">0%</span>
        </div>
        <div class="st-progress-bar">
          <div class="st-progress-fill st-progress-fill--active" id="st-dlProgressFill"></div>
        </div>
        <div class="st-progress-subline" id="st-dlStatusSub">Menghubungkan ke Google CDN...</div>
      </div>

      <div id="st-dlActions" style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap;">
        <button type="button" class="st-btn st-btn-outline" id="st-dlCloseBtn">Batal</button>
        <button type="button" class="st-btn st-btn-outline" id="st-dlDirectBtn">📥 Unduh Foto Satu per Satu</button>
        <button type="button" class="st-btn st-btn-primary" id="st-dlStartZipBtn">${photoItems.length > 0 ? `📦 Unduh ZIP Foto (${photoItems.length})` : '📦 Unduh ZIP Manifest'}</button>
      </div>
    `;

    openDialog('st-downloadDlg');

    const closeBtn = $('st-dlCloseBtn');
    const startZipBtn = $('st-dlStartZipBtn');
    const directBtn = $('st-dlDirectBtn');
    const progressSection = $('st-dlProgressSection');
    const statusMain = $('st-dlStatusMain');
    const statusPercent = $('st-dlStatusPercent');
    const statusSub = $('st-dlStatusSub');
    const progressFill = $('st-dlProgressFill');

    let isDownloading = false;

    const cancelOrClose = () => {
      if (isDownloading && downloadAbortCtrl) {
        downloadAbortCtrl.abort();
        toast('Pengunduhan dibatalkan');
      }
      closeDialog('st-downloadDlg');
    };

    closeBtn.onclick = cancelOrClose;

    const runDownload = async (isZip) => {
      if (!window.StudioZip) {
        toast('Modul pengunduh ZIP belum siap. Silakan muat ulang halaman.', 'error');
        return;
      }

      isDownloading = true;
      downloadAbortCtrl = new AbortController();
      progressSection.style.display = 'flex';
      startZipBtn.style.display = 'none';
      directBtn.style.display = 'none';
      closeBtn.textContent = '✕ Batalkan';
      closeBtn.classList.remove('st-btn-outline');
      closeBtn.classList.add('st-btn-secondary');

      try {
        if (isZip) {
          await window.StudioZip.downloadGalleryZip({
            title,
            note,
            photos: photosToDownload,
            signal: downloadAbortCtrl.signal,
            concurrency: 3,
            onProgress: (p) => {
              progressFill.style.width = `${p.percent}%`;
              statusPercent.textContent = `${p.percent}%`;
              if (p.phase === 'downloading') {
                statusMain.textContent = `Mengunduh berkas ${p.current} dari ${p.total}`;
                const sizeStr = p.loadedBytes ? ` (${window.StudioZip.formatBytes(p.loadedBytes)})` : '';
                statusSub.textContent = `Berkas: ${esc(p.currentName)}${sizeStr}`;
              } else if (p.phase === 'packing') {
                statusMain.textContent = 'Mengompresi arsip ZIP di memori browser...';
                statusSub.textContent = p.currentName || 'Hampir selesai';
              } else if (p.phase === 'complete') {
                statusMain.textContent = 'Pengunduhan Selesai! 🎉';
                statusSub.textContent = p.currentName;
                progressFill.classList.remove('st-progress-fill--active');
              }
            }
          });
          toast(`Berhasil mengunduh paket ZIP!`, 'success');
        } else {
          await window.StudioZip.downloadFilesDirect({
            photos: photosToDownload,
            signal: downloadAbortCtrl.signal,
            delayMs: 350,
            onProgress: (p) => {
              progressFill.style.width = `${p.percent}%`;
              statusPercent.textContent = `${p.percent}%`;
              statusMain.textContent = `Mengunduh berkas ${p.current} dari ${p.total}`;
              statusSub.textContent = p.currentName;
            }
          });
          toast(`Berhasil memicu unduhan berkas!`, 'success');
        }

        closeBtn.textContent = 'Tutup';
        closeBtn.classList.remove('st-btn-secondary');
        closeBtn.classList.add('st-btn-primary');
        isDownloading = false;
        closeBtn.onclick = () => closeDialog('st-downloadDlg');
      } catch (err) {
        if (err.name === 'AbortError' || (err.message && err.message.includes('dibatalkan'))) {
          statusMain.textContent = 'Pengunduhan Dibatalkan';
          statusSub.textContent = 'Tidak ada berkas yang disimpan.';
        } else {
          toast(`Gagal mengunduh: ${err.message}`, 'error');
          statusMain.textContent = 'Terjadi Kesalahan';
          statusSub.textContent = err.message;
        }
        progressFill.style.backgroundColor = '#ff4d4f';
        progressFill.classList.remove('st-progress-fill--active');
        closeBtn.textContent = 'Tutup';
        isDownloading = false;
        closeBtn.onclick = () => closeDialog('st-downloadDlg');
      }
    };

    startZipBtn.onclick = () => runDownload(true);
    directBtn.onclick = () => runDownload(false);

    if (initialMode === 'zip_auto') {
      runDownload(true);
    }
  }

  function renderDetailData(id, data) {
    $('st-detailTitle').textContent = data.title;
    if ($('st-detailSyncInfo')) {
      $('st-detailSyncInfo').textContent = formatSyncRelative(data.syncedAt);
    }
    currentPhotos = sortByName(Array.isArray(data.photos) ? data.photos : []);
    editorMediaTypeFilter = 'all';

    const targetG = galleries.find(x => String(x.id) === String(id));
    const isWedding = (targetG?.category || data.category || currentCategory) === 'wedding';
    const clientLink = toAbsoluteUrl(targetG?.link || data.link || '');

    const photoCount = currentPhotos.filter(p => p.mediaType !== 'video').length;
    const videoCount = currentPhotos.filter(p => p.mediaType === 'video').length;
    const hasVideos = videoCount > 0;

    const noteHtml = data.note
      ? `<div class="st-banner">📝 <div><strong>Catatan Klien:</strong> ${esc(data.note)}</div></div>`
      : '';

    let statusBadgeHtml = '';
    const st = targetG?.status || data.status;
    if (st === 'submitted') statusBadgeHtml = '<span class="st-badge-status st-status-submitted" style="font-size: 12px; padding: 2px 10px;">Terkirim 🔒</span>';
    else if (st === 'draft') statusBadgeHtml = '<span class="st-badge-status st-status-draft" style="font-size: 12px; padding: 2px 10px;">Draft</span>';
    else if (st === 'reopened') statusBadgeHtml = '<span class="st-badge-status st-status-reopened" style="font-size: 12px; padding: 2px 10px;">Dibuka Kembali</span>';
    else statusBadgeHtml = '<span class="st-badge-status st-status-unstarted" style="font-size: 12px; padding: 2px 10px;">Belum Mulai</span>';

    const limitStr = (!isWedding && targetG?.max_select > 0) ? ` / ${targetG.max_select}` : (isWedding ? ' (Unlimited)' : '');
    const countDisplay = hasVideos
      ? `Total: <strong>${currentPhotos.length}</strong>${limitStr} berkas (${photoCount} foto, ${videoCount} video)`
      : `Total: <strong>${currentPhotos.length}</strong>${limitStr} foto`;

    if (!currentPhotos.length) {
      $('st-detailContent').innerHTML = `
        ${noteHtml}
        <div class="st-detail-toolbar">
          <div class="st-toolbar-left">
            <span style="font-size: 14px;">Total: <strong>0</strong>${limitStr} berkas</span>
            ${statusBadgeHtml}
          </div>
          <div class="st-toolbar-right">
            <button type="button" class="st-btn st-btn-primary" id="st-emptyManualSelectBtn" style="height: 36px; font-size: 13px; padding: 0 14px;">✋ Pilih Berkas Manual Sekarang</button>
            ${clientLink ? `<button type="button" class="st-btn st-btn-outline" id="st-emptyCopyLinkBtn" style="height: 36px; font-size: 13px; padding: 0 12px;" title="Salin link klien">🔗 Link Klien</button>` : ''}
            <div class="st-dropdown-wrap">
              <button type="button" class="st-btn st-btn-outline" id="st-emptyMoreBtn" style="height: 36px; font-size: 13px; padding: 0 12px;">⚙️ Opsi ▾</button>
              <div class="st-dropdown-menu" id="st-emptyMoreMenu">
                <button type="button" class="st-dropdown-item" id="st-emptyDdWarming">⚡ <span>Siapkan Cache Thumbnail</span></button>
                <button type="button" class="st-dropdown-item" id="st-emptyDdResync">🔄 <span>Sinkronisasi Ulang Drive</span></button>
                <div class="st-dropdown-divider"></div>
                <button type="button" class="st-dropdown-item" id="st-emptyDdManage">✏️ <span>Pengaturan Galeri</span></button>
              </div>
            </div>
          </div>
        </div>
        <div class="st-banner">Belum ada berkas yang dipilih oleh klien pada galeri ini. Klik tombol di atas untuk memilih berkas secara manual atau salin link untuk klien.</div>
      `;
      if ($('st-emptyManualSelectBtn')) {
        $('st-emptyManualSelectBtn').onclick = () => openManualSelectConfirm(id);
      }
      if ($('st-emptyCopyLinkBtn')) {
        $('st-emptyCopyLinkBtn').onclick = () => copyText(clientLink, 'Link klien disalin!');
      }
      if ($('st-emptyMoreBtn')) {
        $('st-emptyMoreBtn').onclick = (e) => toggleDropdown('st-emptyMoreMenu', e);
      }
      if ($('st-emptyDdWarming')) {
        $('st-emptyDdWarming').onclick = () => { closeAllDropdowns(); warmThumbsForGallery(id); };
      }
      if ($('st-emptyDdResync')) {
        $('st-emptyDdResync').onclick = () => { closeAllDropdowns(); resyncGalleryNames(id); };
      }
      if ($('st-emptyDdManage')) {
        $('st-emptyDdManage').onclick = () => { closeAllDropdowns(); openManageDialog(id); };
      }
      return;
    }

    const missingCount = currentPhotos.filter(p => p.nameMissing || !p.name).length;
    const missingBannerHtml = missingCount > 0 ? `
      <div class="st-banner" style="justify-content: space-between; flex-wrap: wrap; border-color: #fbbf24; color: #fbbf24;">
        <span>⚠️ ${missingCount} berkas belum memiliki nama asli dari Google Drive.</span>
        <button type="button" class="st-btn st-btn-outline" id="st-resyncNamesBtn" style="height: 34px; font-size: 13px; padding: 0 14px; border-color: #fbbf24; color: #fbbf24;">🔄 Muat Ulang Nama</button>
      </div>
    ` : '';

    const csv = 'nama_file,id,tipe\n' + currentPhotos.map(p => {
      const cleanName = (p.nameMissing || !p.name) ? '' : String(p.name);
      return `"${cleanName.replace(/"/g, '""')}","${String(p.id).replace(/"/g, '""')}","${p.mediaType || 'photo'}"`;
    }).join('\n');

    const validNames = currentPhotos.filter(p => !p.nameMissing && p.name).map(p => p.name);

    if (currentCsvUrl) {
      URL.revokeObjectURL(currentCsvUrl);
    }
    const csvBlob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    currentCsvUrl = URL.createObjectURL(csvBlob);

    const filterTabsHtml = hasVideos ? `
      <div class="st-filter-tabs" id="st-editorFilterTabs" style="margin-top: 14px; margin-bottom: 2px;">
        <button type="button" class="st-filter-tab ${editorMediaTypeFilter === 'all' ? 'st-filter-tab--active' : ''}" data-filter="all">Semua (${currentPhotos.length})</button>
        <button type="button" class="st-filter-tab ${editorMediaTypeFilter === 'photo' ? 'st-filter-tab--active' : ''}" data-filter="photo">📷 Foto (${photoCount})</button>
        <button type="button" class="st-filter-tab ${editorMediaTypeFilter === 'video' ? 'st-filter-tab--active' : ''}" data-filter="video">🎬 Video (${videoCount})</button>
      </div>
    ` : '';

    $('st-detailContent').innerHTML = `
      ${noteHtml}
      ${missingBannerHtml}
      <div class="st-detail-toolbar">
        <div class="st-toolbar-left">
          <span style="font-size: 14px;">${countDisplay}</span>
          ${statusBadgeHtml}
        </div>
        <div class="st-toolbar-right">
          <button type="button" class="st-btn st-btn-primary" id="st-detailManualSelectBtn" style="height: 36px; font-size: 13px; padding: 0 14px;">
            ✋ Ubah / Tambah Pilihan
          </button>

          ${clientLink ? `
            <button type="button" class="st-btn st-btn-outline" id="st-detailCopyLinkBtn" style="height: 36px; font-size: 13px; padding: 0 12px;" title="Salin link klien">
              🔗 Link Klien
            </button>
          ` : ''}

          <div class="st-dropdown-wrap">
            <button type="button" class="st-btn st-btn-outline" id="st-exportDropdownBtn" style="height: 36px; font-size: 13px; padding: 0 12px;">
              📥 Ekspor ▾
            </button>
            <div class="st-dropdown-menu" id="st-exportDropdownMenu">
              <button type="button" class="st-dropdown-item" id="st-ddDownloadZip" style="font-weight: 600;">
                <span>📦 <strong>Unduh Berkas (ZIP + Video Link)</strong></span>
              </button>
              <button type="button" class="st-dropdown-item" id="st-ddDownloadDirect">
                <span>📥 Unduh Satu per Satu (Direct)</span>
              </button>
              <div class="st-dropdown-divider"></div>
              <a href="${currentCsvUrl}" download="pilihan_${esc(id)}.csv" class="st-dropdown-item" id="st-ddDownloadCsv">
                <span>📄 Unduh File CSV</span>
              </a>
              <button type="button" class="st-dropdown-item" id="st-ddCopyNames">
                <span>📋 Salin Nama File</span>
              </button>
              <button type="button" class="st-dropdown-item" id="st-ddCopyCsv">
                <span>📋 Salin Format CSV</span>
              </button>
            </div>
          </div>

          <div class="st-dropdown-wrap">
            <button type="button" class="st-btn st-btn-outline" id="st-moreDropdownBtn" style="height: 36px; font-size: 13px; padding: 0 12px;">
              ⚙️ Opsi ▾
            </button>
            <div class="st-dropdown-menu" id="st-moreDropdownMenu">
              <button type="button" class="st-dropdown-item" id="st-ddWarmThumbs">
                <span>⚡ Siapkan Cache Thumbnail</span>
              </button>
              <button type="button" class="st-dropdown-item" id="st-ddResyncDrive">
                <span>🔄 Sinkronisasi Ulang Drive</span>
              </button>
              ${targetG?.status === 'submitted' ? `
                <button type="button" class="st-dropdown-item" id="st-ddReopen">
                  <span>🔓 Buka Akses Klien</span>
                </button>
              ` : ''}
              <div class="st-dropdown-divider"></div>
              <button type="button" class="st-dropdown-item" id="st-ddManageGallery">
                <span>✏️ Pengaturan Galeri</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      ${filterTabsHtml}
      <div class="st-photo-grid st-editor-photo-grid" id="st-editorGrid" style="margin-top: 14px;"></div>
    `;

    if ($('st-detailManualSelectBtn')) {
      $('st-detailManualSelectBtn').onclick = () => openManualSelectConfirm(id);
    }
    if ($('st-detailCopyLinkBtn')) {
      $('st-detailCopyLinkBtn').onclick = () => copyText(clientLink, 'Link klien disalin!');
    }
    if ($('st-resyncNamesBtn')) {
      $('st-resyncNamesBtn').onclick = () => resyncGalleryNames(id);
    }

    if ($('st-editorFilterTabs')) {
      $('st-editorFilterTabs').querySelectorAll('.st-filter-tab').forEach(btn => {
        btn.onclick = () => {
          editorMediaTypeFilter = btn.dataset.filter;
          $('st-editorFilterTabs').querySelectorAll('.st-filter-tab').forEach(b => {
            b.classList.toggle('st-filter-tab--active', b.dataset.filter === editorMediaTypeFilter);
          });
          applyEditorFilter();
        };
      });
    }

    // Ekspor dropdown triggers
    if ($('st-exportDropdownBtn')) {
      $('st-exportDropdownBtn').onclick = (e) => toggleDropdown('st-exportDropdownMenu', e);
    }
    if ($('st-ddDownloadZip')) {
      $('st-ddDownloadZip').onclick = () => {
        closeAllDropdowns();
        openBatchDownloadDialog(id, 'zip');
      };
    }
    if ($('st-ddDownloadDirect')) {
      $('st-ddDownloadDirect').onclick = () => {
        closeAllDropdowns();
        openBatchDownloadDialog(id, 'direct');
      };
    }
    if ($('st-ddDownloadCsv')) {
      $('st-ddDownloadCsv').onclick = () => closeAllDropdowns();
    }
    if ($('st-ddCopyNames')) {
      $('st-ddCopyNames').onclick = () => {
        closeAllDropdowns();
        if (!validNames.length) {
          toast('Nama file belum tersedia. Klik "Muat Ulang Nama" terlebih dahulu.');
          return;
        }
        const msg = missingCount > 0
          ? `${validNames.length} nama file disalin (${missingCount} nama belum tersedia dilewati)`
          : `${validNames.length} nama file disalin!`;
        copyText(validNames.join('\n'), msg);
      };
    }
    if ($('st-ddCopyCsv')) {
      $('st-ddCopyCsv').onclick = () => {
        closeAllDropdowns();
        copyText(csv, 'Data CSV disalin!');
      };
    }

    // Opsi dropdown triggers
    if ($('st-moreDropdownBtn')) {
      $('st-moreDropdownBtn').onclick = (e) => toggleDropdown('st-moreDropdownMenu', e);
    }
    if ($('st-ddWarmThumbs')) {
      $('st-ddWarmThumbs').onclick = () => {
        closeAllDropdowns();
        warmThumbsForGallery(id);
      };
    }
    if ($('st-ddResyncDrive')) {
      $('st-ddResyncDrive').onclick = () => {
        closeAllDropdowns();
        resyncGalleryNames(id);
      };
    }
    if ($('st-ddReopen')) {
      $('st-ddReopen').onclick = () => {
        closeAllDropdowns();
        reopenGallery(id);
      };
    }
    if ($('st-ddManageGallery')) {
      $('st-ddManageGallery').onclick = () => {
        closeAllDropdowns();
        openManageDialog(id);
      };
    }

    applyEditorFilter();
  }

  function applyEditorFilter() {
    if (editorMediaTypeFilter === 'photo') {
      activeEditorFilterList = currentPhotos.filter(p => p.mediaType !== 'video');
    } else if (editorMediaTypeFilter === 'video') {
      activeEditorFilterList = currentPhotos.filter(p => p.mediaType === 'video');
    } else {
      activeEditorFilterList = [...currentPhotos];
    }
    renderEditorGrid();
  }

  let editorRenderedCount = 0;
  let editorObserver = null;
  const EDITOR_CHUNK_SIZE = 40;

  function renderEditorGrid() {
    editorRenderedCount = 0;
    removeEditorSentinel();
    const gridEl = $('st-editorGrid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    if (!activeEditorFilterList.length) {
      gridEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--st-text-muted); grid-column: 1 / -1;">Tidak ada berkas untuk filter ini.</div>';
      return;
    }

    renderNextEditorChunk();
    if (editorRenderedCount < activeEditorFilterList.length) {
      setupEditorSentinel();
    }
  }

  function renderNextEditorChunk() {
    const gridEl = $('st-editorGrid');
    if (!gridEl || editorRenderedCount >= activeEditorFilterList.length) {
      removeEditorSentinel();
      return;
    }
    const nextBatch = activeEditorFilterList.slice(editorRenderedCount, editorRenderedCount + EDITOR_CHUNK_SIZE);
    const frag = document.createDocumentFragment();

    nextBatch.forEach((p, idx) => {
      const i = editorRenderedCount + idx;
      const isVideo = p.mediaType === 'video';
      const durLabel = isVideo ? (p.durationMs ? `▶ ${formatDuration(p.durationMs)}` : '🎬 VIDEO') : '';

      const card = document.createElement('div');
      card.className = 'st-photo-card';
      card.dataset.i = i;
      card.tabIndex = 0;

      const retryWrap = document.createElement('div');
      retryWrap.className = 'st-img-retry-wrap';
      retryWrap.innerHTML = `<span>Gagal memuat pratinjau</span><button type="button" class="st-retry-img-btn" data-i="${i}">↻ Muat ulang</button>`;

      const candidates = getImageCandidates(p, false);
      const img = document.createElement('img');
      img.width = 400;
      img.height = 400;
      img.referrerPolicy = 'no-referrer';
      img.alt = p.name || '(nama belum tersedia)';
      img.loading = i < 8 ? 'eager' : 'lazy';
      img.decoding = 'async';

      let attempt = 0;
      img.onload = () => {
        card.classList.remove('st-img-error');
        card.classList.add('st-img-loaded');
      };
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          img.src = candidates[attempt];
        } else {
          card.classList.add('st-img-error');
        }
      };
      img.src = candidates[0] || p.src;

      const overlay = document.createElement('div');
      overlay.className = 'st-photo-card__overlay';
      overlay.style.opacity = '1';

      const displayLabel = (!p.nameMissing && p.name) ? p.name : '(nama belum tersedia)';
      const badgeName = document.createElement('div');
      badgeName.className = 'st-badge-name' + ((p.nameMissing || !p.name) ? ' st-badge-name--missing' : '');
      badgeName.style.opacity = '1';
      badgeName.style.bottom = '8px';
      badgeName.title = displayLabel;
      badgeName.textContent = displayLabel;

      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'st-zoom-btn';
      zoomBtn.setAttribute('aria-label', isVideo ? 'Putar Video' : 'Perbesar');
      zoomBtn.tabIndex = -1;
      zoomBtn.textContent = isVideo ? '▶' : '⤢';

      if (isVideo) {
        const badgeVideo = document.createElement('div');
        badgeVideo.className = 'st-badge-video';
        badgeVideo.textContent = durLabel;

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'st-play-center-btn';
        playBtn.setAttribute('aria-label', 'Putar video');
        playBtn.tabIndex = -1;
        playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"/></svg>';

        card.append(img, retryWrap, overlay, badgeVideo, playBtn, badgeName, zoomBtn);
      } else {
        card.append(img, retryWrap, overlay, badgeName, zoomBtn);
      }

      card.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openLb(i);
        }
      };
      frag.appendChild(card);
    });

    editorRenderedCount += nextBatch.length;

    const sentinel = $('st-editor-grid-sentinel');
    if (sentinel) {
      gridEl.insertBefore(frag, sentinel);
    } else {
      gridEl.appendChild(frag);
    }

    if (editorRenderedCount >= activeEditorFilterList.length) {
      removeEditorSentinel();
    }
  }

  function setupEditorSentinel() {
    removeEditorSentinel();
    if (editorRenderedCount >= activeEditorFilterList.length) return;

    const gridEl = $('st-editorGrid');
    if (!gridEl) return;

    const sentinel = document.createElement('div');
    sentinel.id = 'st-editor-grid-sentinel';
    sentinel.style.width = '100%';
    sentinel.style.height = '50px';
    sentinel.style.gridColumn = '1 / -1';
    sentinel.style.display = 'flex';
    sentinel.style.alignItems = 'center';
    sentinel.style.justifyContent = 'center';
    sentinel.style.color = 'var(--st-text-muted)';
    sentinel.style.fontSize = '13px';
    sentinel.textContent = 'Memuat berkas lainnya...';
    gridEl.appendChild(sentinel);

    if ('IntersectionObserver' in window) {
      editorObserver = new IntersectionObserver((entries) => {
        if (entries[0] && entries[0].isIntersecting) {
          renderNextEditorChunk();
        }
      }, { rootMargin: '300px' });
      editorObserver.observe(sentinel);
    } else {
      while (editorRenderedCount < activeEditorFilterList.length) {
        renderNextEditorChunk();
      }
    }
  }

  function removeEditorSentinel() {
    if (editorObserver) {
      editorObserver.disconnect();
      editorObserver = null;
    }
    const sentinel = $('st-editor-grid-sentinel');
    if (sentinel) sentinel.remove();
  }

  async function viewGallery(id, forceRefresh = false) {
    activeGalleryId = id;
    renderGalleries();

    if (window.innerWidth < 900) {
      $('st-listPanel').style.display = 'none';
    } else {
      $('st-listPanel').style.display = isSidebarCollapsed ? 'none' : 'block';
    }
    $('st-detailPanel').style.display = 'block';
    applySidebarState();
    $('st-detailContent').innerHTML = '<p class="st-text-muted">Memuat berkas pilihan klien...</p>';

    try {
      const query = forceRefresh ? '?refresh=1' : '';
      const data = await apiFetch(`/editor/galleries/${id}${query}`);
      renderDetailData(id, data);
    } catch (e) {
      $('st-detailContent').innerHTML = `<div class="st-banner" style="border-color:#ff4d4f; color:#ff4d4f;">Error: ${esc(e.message)}</div>`;
    }
  }

  async function resyncGalleryNames(id) {
    const btn = $('st-resyncNamesBtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Memuat ulang nama...';
    }
    try {
      const data = await apiFetch(`/editor/galleries/${id}/resync`, { method: 'POST' });
      renderDetailData(id, data);
      await loadGalleries(true);
      toast(data.missingNameCount === 0 ? 'Semua nama berkas berhasil dimuat!' : 'Sinkronisasi selesai.');
    } catch (e) {
      toast(e.message);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🔄 Muat Ulang Nama';
      }
    }
  }

  function openLb(i) {
    const list = activeEditorFilterList.length ? activeEditorFilterList : currentPhotos;
    if (!list.length) return;
    currentCur = i;
    $('st-lb').classList.add('st-open');
    showLb();
  }
  window.StudioApp.editorOpenLb = openLb;

  function showLb() {
    const list = activeEditorFilterList.length ? activeEditorFilterList : currentPhotos;
    const p = list[currentCur];
    if (!p) return;
    const isVideo = p.mediaType === 'video';
    const lbImg = $('st-lbimg');
    const lbVideo = $('st-lbvideo');

    if (isVideo) {
      lbImg.style.display = 'none';
      lbImg.src = '';
      if (lbVideo) {
        lbVideo.style.display = 'block';
        lbVideo.src = p.previewUrl || `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/preview`;
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

    const displayLabel = (!p.nameMissing && p.name) ? p.name : '(nama belum tersedia)';
    lbImg.alt = displayLabel;
    $('st-lbname').textContent = `${displayLabel} (${currentCur + 1} / ${list.length})`;

    const dlBtn = $('st-lbDriveBtn');
    if (dlBtn) {
      if (String(p.id).startsWith('demo')) {
        dlBtn.style.display = 'none';
      } else {
        dlBtn.style.display = 'inline-flex';
        dlBtn.textContent = isVideo ? '📥 Unduh Video' : '📥 Unduh Asli';
        dlBtn.href = p.downloadUrl || `https://drive.google.com/uc?export=download&id=${encodeURIComponent(p.id)}`;
      }
    }

    const lbBtn = $('st-lbSelectToggle');
    if (lbBtn) lbBtn.style.display = 'none';
  }

  function closeLb() {
    const lbVideo = $('st-lbvideo');
    if (lbVideo) {
      lbVideo.src = '';
      lbVideo.style.display = 'none';
    }
    $('st-lb').classList.remove('st-open');
  }

  // ==========================================
  // EDITOR MANUAL SELECTION (PICKER MODE)
  // ==========================================
  let isPickerMode = false;
  let pickerGalleryId = null;
  let pickerData = null;
  let pickerSelected = new Set();
  let pickerPhotos = [];
  let pickerFiltered = [];
  let pickerRenderedCount = 0;
  let pickerObserver = null;
  let pickerMediaTypeFilter = 'all';
  const PICKER_CHUNK_SIZE = 40;

  async function openManualSelectConfirm(id) {
    const g = galleries.find(x => String(x.id) === String(id));
    const title = g ? g.title : 'Galeri';
    const ok = await confirmDialog({
      title: 'Pilih Berkas Manual oleh Editor?',
      message: `Apakah Anda yakin ingin memilih foto & video sendiri secara manual untuk "${title}"? Tindakan ini berisiko menimbulkan ketidaksesuaian jika klien memiliki preferensi berbeda atau sedang memilih berkasnya. Pastikan Anda telah berkoordinasi dengan klien.`,
      confirmText: 'Ya, Lanjut Pilih Manual',
      cancelText: 'Batal',
      variant: 'warning'
    });
    if (!ok) return;
    startManualSelection(id);
  }

  async function startManualSelection(id) {
    pickerGalleryId = id;
    activeGalleryId = id;
    isPickerMode = true;
    pickerMediaTypeFilter = 'all';
    renderGalleries();

    if (window.innerWidth < 900) {
      $('st-listPanel').style.display = 'none';
    } else {
      $('st-listPanel').style.display = isSidebarCollapsed ? 'none' : 'block';
    }
    $('st-detailPanel').style.display = 'block';
    applySidebarState();
    $('st-detailTitle').textContent = 'Pilih Berkas Manual...';
    if ($('st-detailSyncInfo')) $('st-detailSyncInfo').textContent = '';
    $('st-detailContent').innerHTML = `
      <div class="st-container" style="padding: 32px 0; text-align: center;">
        <div class="st-shell-loading">Memuat seluruh berkas galeri dari Google Drive...</div>
      </div>
    `;

    try {
      const data = await apiFetch(`/editor/galleries/${id}/all-photos`);
      pickerData = data;
      pickerPhotos = sortByName(Array.isArray(data.photos) ? data.photos : []);
      pickerSelected = new Set(Array.isArray(data.selectedIds) ? data.selectedIds : []);
      pickerFiltered = [...pickerPhotos];
      renderPickerUI();
    } catch (err) {
      $('st-detailContent').innerHTML = `
        <div class="st-banner" style="border-color:#ff4d4f; color:#ff4d4f; flex-direction: column; align-items: flex-start; gap: 10px;">
          <span>❌ Gagal memuat berkas: ${esc(err.message)}</span>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="st-btn st-btn-outline" id="st-pickerRetryBtn">↻ Coba Lagi</button>
            <button type="button" class="st-btn st-btn-outline" id="st-pickerFailBackBtn">← Kembali</button>
          </div>
        </div>
      `;
      if ($('st-pickerRetryBtn')) $('st-pickerRetryBtn').onclick = () => startManualSelection(id);
      if ($('st-pickerFailBackBtn')) $('st-pickerFailBackBtn').onclick = () => exitPickerMode();
    }
  }

  function renderPickerUI() {
    if (!pickerData) return;
    const isWedding = (pickerData.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData.maxSelect || 0);
    const maxLabel = (!isWedding && max > 0) ? ` / ${max}` : (isWedding ? ' (Unlimited)' : '');

    const pPhotoCount = pickerPhotos.filter(p => p.mediaType !== 'video').length;
    const pVideoCount = pickerPhotos.filter(p => p.mediaType === 'video').length;
    const pHasVideos = pVideoCount > 0;

    $('st-detailTitle').textContent = `Pilih Berkas: ${pickerData.title}`;
    if ($('st-detailSyncInfo')) {
      const infoStr = pHasVideos
        ? `${pickerPhotos.length} berkas tersedia (${pPhotoCount} foto, ${pVideoCount} video)`
        : `${pickerPhotos.length} foto tersedia di Google Drive`;
      $('st-detailSyncInfo').textContent = infoStr;
    }

    const filterTabsHtml = pHasVideos ? `
      <div class="st-filter-tabs" id="st-pickerFilterTabs" style="margin-top: 8px;">
        <button type="button" class="st-filter-tab ${pickerMediaTypeFilter === 'all' ? 'st-filter-tab--active' : ''}" data-filter="all">Semua (${pickerPhotos.length})</button>
        <button type="button" class="st-filter-tab ${pickerMediaTypeFilter === 'photo' ? 'st-filter-tab--active' : ''}" data-filter="photo">📷 Foto (${pPhotoCount})</button>
        <button type="button" class="st-filter-tab ${pickerMediaTypeFilter === 'video' ? 'st-filter-tab--active' : ''}" data-filter="video">🎬 Video (${pVideoCount})</button>
      </div>
    ` : '';

    $('st-detailContent').innerHTML = `
      <div class="st-picker-wrap">
        <div class="st-picker-header">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <button type="button" class="st-btn st-btn-outline" id="st-pickerBackBtn" style="height: 38px; font-size: 13px;">← Kembali ke Detail</button>
            <input type="search" id="st-pickerSearch" class="st-picker-search" placeholder="🔍 Cari nama foto atau video...">
          </div>
          <div class="st-text-muted" style="font-size: 13px;" id="st-pickerFilterCount">
            Menampilkan ${pickerFiltered.length} berkas
          </div>
        </div>

        ${filterTabsHtml}

        <div class="st-banner" style="border-color: #fbbf24; color: #fbbf24; font-size: 13px; margin: 0;">
          <span>⚠️ <strong>Mode Pemilihan Manual:</strong> Anda memilih langsung untuk klien ini. Klik berkas untuk memilih / membatalkan. Pilihan akan disimpan dan status dikunci sebagai <em>Terkirim</em>.</span>
        </div>

        <div class="st-photo-grid st-picker-grid" id="st-pickerGrid"></div>

        <div class="st-picker-bottom-bar" id="st-pickerBar">
          <div class="st-picker-info">
            <span id="st-pickerCounter">Terpilih: <strong>${pickerSelected.size}</strong>${maxLabel} berkas</span>
          </div>
          <div class="st-picker-actions">
            <button type="button" class="st-btn st-btn-outline" id="st-pickerSelectBatchBtn" style="font-size: 13px; height: 36px;">${max > 0 ? `Pilih Hingga Batas (${max})` : 'Pilih Semua'}</button>
            <button type="button" class="st-btn st-btn-outline" id="st-pickerResetBtn" style="font-size: 13px; height: 36px;">Hapus Pilihan</button>
            <button type="button" class="st-btn st-btn-outline" id="st-pickerCancelBtn" style="font-size: 13px; height: 36px;">Batal</button>
            <button type="button" class="st-btn st-btn-primary" id="st-pickerReviewBtn" style="font-size: 13px; height: 36px;">✓ Konfirmasi Perubahan</button>
          </div>
        </div>
      </div>
    `;

    $('st-pickerBackBtn').onclick = () => exitPickerMode();
    $('st-pickerCancelBtn').onclick = () => exitPickerMode();
    $('st-pickerResetBtn').onclick = () => {
      pickerSelected.clear();
      updatePickerCounters();
      refreshPickerGridSelection();
    };
    $('st-pickerSelectBatchBtn').onclick = () => {
      const toSelect = max > 0 ? pickerFiltered.slice(0, max) : pickerFiltered;
      pickerSelected.clear();
      toSelect.forEach(p => pickerSelected.add(p.id));
      updatePickerCounters();
      refreshPickerGridSelection();
    };
    $('st-pickerReviewBtn').onclick = () => openReviewSelectionDialog();

    if ($('st-pickerFilterTabs')) {
      $('st-pickerFilterTabs').querySelectorAll('.st-filter-tab').forEach(btn => {
        btn.onclick = () => {
          pickerMediaTypeFilter = btn.dataset.filter;
          $('st-pickerFilterTabs').querySelectorAll('.st-filter-tab').forEach(b => {
            b.classList.toggle('st-filter-tab--active', b.dataset.filter === pickerMediaTypeFilter);
          });
          applyPickerFilter();
        };
      });
    }

    let searchDebounce = null;
    $('st-pickerSearch').oninput = () => {
      if (searchDebounce) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        applyPickerFilter();
      }, 200);
    };

    applyPickerFilter();
  }

  function applyPickerFilter() {
    const q = ($('st-pickerSearch')?.value || '').trim().toLowerCase();
    pickerFiltered = pickerPhotos.filter(p => {
      if (pickerMediaTypeFilter === 'photo' && p.mediaType === 'video') return false;
      if (pickerMediaTypeFilter === 'video' && p.mediaType !== 'video') return false;
      if (q && !(p.name || '').toLowerCase().includes(q)) return false;
      return true;
    });

    if ($('st-pickerFilterCount')) {
      $('st-pickerFilterCount').textContent = `Menampilkan ${pickerFiltered.length} berkas`;
    }
    renderPickerGrid();
  }

  function renderPickerGrid() {
    pickerRenderedCount = 0;
    removePickerSentinel();
    const gridEl = $('st-pickerGrid');
    if (!gridEl) return;
    gridEl.innerHTML = '';

    if (!pickerFiltered.length) {
      gridEl.innerHTML = '<div style="padding: 40px; text-align: center; color: var(--st-text-muted); grid-column: 1 / -1;">Tidak ada berkas yang cocok dengan pencarian/filter.</div>';
      return;
    }

    renderNextPickerChunk();
    if (pickerRenderedCount < pickerFiltered.length) {
      setupPickerSentinel();
    }
  }

  function renderNextPickerChunk() {
    const gridEl = $('st-pickerGrid');
    if (!gridEl || pickerRenderedCount >= pickerFiltered.length) {
      removePickerSentinel();
      return;
    }

    const nextBatch = pickerFiltered.slice(pickerRenderedCount, pickerRenderedCount + PICKER_CHUNK_SIZE);
    const frag = document.createDocumentFragment();
    const isWedding = (pickerData?.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData?.maxSelect || 0);
    const limitReached = max > 0 && pickerSelected.size >= max;

    nextBatch.forEach((p, idx) => {
      const i = pickerRenderedCount + idx;
      const isSelected = pickerSelected.has(p.id);
      const isVideo = p.mediaType === 'video';
      const durLabel = isVideo ? (p.durationMs ? `▶ ${formatDuration(p.durationMs)}` : '🎬 VIDEO') : '';

      const card = document.createElement('div');
      card.className = 'st-photo-card' + (isSelected ? ' st-selected' : '') + (!isSelected && limitReached ? ' st-limit-reached' : '');
      card.dataset.id = p.id;
      card.dataset.i = i;
      card.tabIndex = 0;

      const candidates = getImageCandidates(p, false);
      const img = document.createElement('img');
      img.width = 400;
      img.height = 400;
      img.referrerPolicy = 'no-referrer';
      img.alt = p.name || '(nama belum tersedia)';
      img.loading = i < 8 ? 'eager' : 'lazy';
      img.decoding = 'async';

      let attempt = 0;
      img.onload = () => {
        card.classList.remove('st-img-error');
        card.classList.add('st-img-loaded');
      };
      img.onerror = () => {
        attempt++;
        if (attempt < candidates.length) {
          img.src = candidates[attempt];
        } else {
          card.classList.add('st-img-error');
        }
      };
      img.src = candidates[0] || p.src;

      const retryWrap = document.createElement('div');
      retryWrap.className = 'st-img-retry-wrap';
      retryWrap.innerHTML = `<span>Gagal memuat pratinjau</span><button type="button" class="st-retry-img-btn" data-i="${i}">↻ Muat ulang</button>`;

      const overlay = document.createElement('div');
      overlay.className = 'st-photo-card__overlay';

      const checkBadge = document.createElement('div');
      checkBadge.className = 'st-badge-check';
      checkBadge.textContent = '✓';

      const displayLabel = p.name || '(nama belum tersedia)';
      const badgeName = document.createElement('div');
      badgeName.className = 'st-badge-name';
      badgeName.title = displayLabel;
      badgeName.textContent = displayLabel;

      const zoomBtn = document.createElement('button');
      zoomBtn.type = 'button';
      zoomBtn.className = 'st-zoom-btn';
      zoomBtn.setAttribute('aria-label', isVideo ? 'Putar Video' : 'Perbesar');
      zoomBtn.textContent = isVideo ? '▶' : '⤢';
      zoomBtn.onclick = (e) => {
        e.stopPropagation();
        openPickerLb(i);
      };

      if (isVideo) {
        const badgeVideo = document.createElement('div');
        badgeVideo.className = 'st-badge-video';
        badgeVideo.textContent = durLabel;

        const playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'st-play-center-btn';
        playBtn.setAttribute('aria-label', 'Putar video');
        playBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="6,4 20,12 6,20"/></svg>';
        playBtn.onclick = (e) => {
          e.stopPropagation();
          openPickerLb(i);
        };

        card.append(img, retryWrap, overlay, badgeVideo, playBtn, checkBadge, badgeName, zoomBtn);
      } else {
        card.append(img, retryWrap, overlay, checkBadge, badgeName, zoomBtn);
      }

      card.onclick = (e) => {
        if (e.target.closest('.st-zoom-btn') || e.target.closest('.st-play-center-btn') || e.target.closest('.st-retry-img-btn')) return;
        togglePickerSelect(p.id);
      };

      card.onkeydown = (e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          togglePickerSelect(p.id);
        }
      };

      frag.appendChild(card);
    });

    pickerRenderedCount += nextBatch.length;

    const sentinel = $('st-picker-grid-sentinel');
    if (sentinel) {
      gridEl.insertBefore(frag, sentinel);
    } else {
      gridEl.appendChild(frag);
    }

    if (pickerRenderedCount >= pickerFiltered.length) {
      removePickerSentinel();
    }
  }

  function setupPickerSentinel() {
    removePickerSentinel();
    const gridEl = $('st-pickerGrid');
    if (!gridEl || pickerRenderedCount >= pickerFiltered.length) return;

    const sentinel = document.createElement('div');
    sentinel.id = 'st-picker-grid-sentinel';
    sentinel.style.width = '100%';
    sentinel.style.height = '50px';
    sentinel.style.gridColumn = '1 / -1';
    sentinel.style.display = 'flex';
    sentinel.style.alignItems = 'center';
    sentinel.style.justifyContent = 'center';
    sentinel.style.color = 'var(--st-text-muted)';
    sentinel.style.fontSize = '13px';
    sentinel.textContent = 'Memuat berkas lainnya...';
    gridEl.appendChild(sentinel);

    if ('IntersectionObserver' in window) {
      pickerObserver = new IntersectionObserver((entries) => {
        if (entries[0] && entries[0].isIntersecting) {
          renderNextPickerChunk();
        }
      }, { rootMargin: '300px' });
      pickerObserver.observe(sentinel);
    } else {
      while (pickerRenderedCount < pickerFiltered.length) {
        renderNextPickerChunk();
      }
    }
  }

  function removePickerSentinel() {
    if (pickerObserver) {
      pickerObserver.disconnect();
      pickerObserver = null;
    }
    const sentinel = $('st-picker-grid-sentinel');
    if (sentinel) sentinel.remove();
  }

  function togglePickerSelect(photoId) {
    const isWedding = (pickerData?.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData?.maxSelect || 0);

    if (pickerSelected.has(photoId)) {
      pickerSelected.delete(photoId);
    } else {
      if (max > 0 && pickerSelected.size >= max) {
        toast(`Maksimal pilihan adalah ${max} foto.`);
        return;
      }
      pickerSelected.add(photoId);
    }

    updatePickerCounters();
    refreshPickerGridSelection();

    const lbBtn = $('st-lbSelectToggle');
    if (lbBtn && $('st-lb').classList.contains('st-open')) {
      const curPhoto = pickerFiltered[currentCur];
      if (curPhoto && curPhoto.id === photoId) {
        const sel = pickerSelected.has(photoId);
        const isVideo = curPhoto.mediaType === 'video';
        lbBtn.classList.toggle('st-selected', sel);
        lbBtn.textContent = sel ? '✓ Terpilih' : (isVideo ? '+ Pilih Video Ini' : '+ Pilih Foto Ini');
      }
    }
  }

  function updatePickerCounters() {
    const isWedding = (pickerData?.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData?.maxSelect || 0);
    const maxLabel = (!isWedding && max > 0) ? ` / ${max}` : (isWedding ? ' (Unlimited)' : '');
    const counterEl = $('st-pickerCounter');
    if (counterEl) {
      counterEl.innerHTML = `Terpilih: <strong>${pickerSelected.size}</strong>${maxLabel} berkas`;
    }
  }

  function refreshPickerGridSelection() {
    const gridEl = $('st-pickerGrid');
    if (!gridEl) return;
    const isWedding = (pickerData?.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData?.maxSelect || 0);
    const limitReached = max > 0 && pickerSelected.size >= max;

    gridEl.querySelectorAll('.st-photo-card').forEach(card => {
      const pid = card.dataset.id;
      const isSel = pickerSelected.has(pid);
      card.classList.toggle('st-selected', isSel);
      card.classList.toggle('st-limit-reached', !isSel && limitReached);
    });
  }

  function openReviewSelectionDialog() {
    if (!pickerData || !pickerGalleryId) return;
    const initialSet = new Set(Array.isArray(pickerData.selectedIds) ? pickerData.selectedIds : []);
    let addedCount = 0;
    let removedCount = 0;

    pickerSelected.forEach(id => {
      if (!initialSet.has(id)) addedCount++;
    });
    initialSet.forEach(id => {
      if (!pickerSelected.has(id)) removedCount++;
    });

    const isWedding = (pickerData.category || currentCategory) === 'wedding';
    const max = isWedding ? 0 : Number(pickerData.maxSelect || 0);
    const maxLabel = (!isWedding && max > 0) ? ` / ${max}` : (isWedding ? ' (Unlimited)' : '');

    $('st-reviewDlg').innerHTML = `
      <h2 style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
        <span>⚠️</span> <span>Konfirmasi Pilihan Manual</span>
      </h2>
      <p class="st-text-muted" style="margin-bottom: 14px; font-size: 14px;">
        Galeri: <strong>${esc(pickerData.title)}</strong>
      </p>

      <div class="st-review-box">
        <div class="st-review-stat-row">
          <span>Total Berkas Dipilih:</span>
          <span class="st-review-stat-val">${pickerSelected.size}${maxLabel} berkas</span>
        </div>
        <div class="st-review-stat-row">
          <span>Perubahan Seleksi:</span>
          <div class="st-review-diff-wrap">
            ${addedCount > 0 ? `<span class="st-review-diff-badge st-diff-add">+${addedCount} baru</span>` : ''}
            ${removedCount > 0 ? `<span class="st-review-diff-badge st-diff-remove">-${removedCount} dihapus</span>` : ''}
            ${addedCount === 0 && removedCount === 0 ? `<span class="st-review-diff-badge st-diff-same">Tidak ada perubahan</span>` : ''}
          </div>
        </div>
        <div class="st-review-stat-row">
          <span>Status Galeri Baru:</span>
          <span class="st-badge-status st-status-submitted" style="font-size: 12px; padding: 2px 10px;">Terkirim (Terkunci)</span>
        </div>
      </div>

      <div class="st-banner" style="font-size: 13px; border-color: #fbbf24; color: #fbbf24; margin: 14px 0;">
        <span>Pilihan berkas klien akan disimpan dan status galeri dikunci. Klien tidak dapat mengubah berkas kecuali akses dibuka kembali oleh editor.</span>
      </div>

      <div style="display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap;">
        <button type="button" class="st-btn st-btn-outline" id="st-reviewCancelBtn">← Periksa Lagi</button>
        <button type="button" class="st-btn st-btn-primary" id="st-reviewConfirmBtn">✓ Ya, Simpan & Kunci</button>
      </div>
    `;

    openDialog('st-reviewDlg');

    $('st-reviewCancelBtn').onclick = () => {
      closeDialog('st-reviewDlg');
    };

    $('st-reviewConfirmBtn').onclick = () => {
      saveManualSelection();
    };
  }

  async function saveManualSelection() {
    if (!pickerGalleryId) return;
    const confirmBtn = $('st-reviewConfirmBtn');
    const bottomBtn = $('st-pickerReviewBtn');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = '⏳ Menyimpan...';
    }
    if (bottomBtn) {
      bottomBtn.disabled = true;
      bottomBtn.textContent = '⏳ Menyimpan...';
    }

    try {
      const ids = Array.from(pickerSelected);
      const res = await apiFetch(`/editor/galleries/${pickerGalleryId}/select`, {
        method: 'POST',
        body: JSON.stringify({ ids })
      });

      closeDialog('st-reviewDlg');
      toast(`Berhasil menyimpan ${res.count} berkas pilihan!`, 'success');
      exitPickerMode();
      await loadGalleries(true);
      await viewGallery(pickerGalleryId, true);
    } catch (err) {
      toast(`Gagal menyimpan: ${err.message}`, 'error');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '✓ Ya, Simpan & Kunci';
      }
      if (bottomBtn) {
        bottomBtn.disabled = false;
        bottomBtn.textContent = '✓ Konfirmasi Perubahan';
      }
    }
  }

  function exitPickerMode() {
    isPickerMode = false;
    pickerData = null;
    pickerSelected.clear();
    pickerPhotos = [];
    pickerFiltered = [];
    removePickerSentinel();
    closeDialog('st-reviewDlg');

    const lbBtn = $('st-lbSelectToggle');
    if (lbBtn) lbBtn.style.display = 'none';

    if (activeGalleryId) {
      viewGallery(activeGalleryId, false);
    } else {
      closeDetailPanel();
    }
  }

  function openPickerLb(i) {
    if (!pickerFiltered.length) return;
    currentCur = i;
    $('st-lb').classList.add('st-open');
    showPickerLb();
  }

  function showPickerLb() {
    const p = pickerFiltered[currentCur];
    if (!p) return;
    const isVideo = p.mediaType === 'video';
    const lbImg = $('st-lbimg');
    const lbVideo = $('st-lbvideo');

    if (isVideo) {
      lbImg.style.display = 'none';
      lbImg.src = '';
      if (lbVideo) {
        lbVideo.style.display = 'block';
        lbVideo.src = p.previewUrl || `https://drive.google.com/file/d/${encodeURIComponent(p.id)}/preview`;
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

    const displayLabel = p.name || '(nama belum tersedia)';
    lbImg.alt = displayLabel;
    $('st-lbname').textContent = `${displayLabel} (${currentCur + 1} / ${pickerFiltered.length})`;

    const dlBtn = $('st-lbDriveBtn');
    if (dlBtn) {
      if (String(p.id).startsWith('demo')) {
        dlBtn.style.display = 'none';
      } else {
        dlBtn.style.display = 'inline-flex';
        dlBtn.textContent = isVideo ? '📥 Unduh Video' : '📥 Unduh Asli';
        dlBtn.href = p.downloadUrl || `https://drive.google.com/uc?export=download&id=${encodeURIComponent(p.id)}`;
      }
    }

    const lbBtn = $('st-lbSelectToggle');
    if (lbBtn) {
      lbBtn.style.display = 'inline-flex';
      const isSel = pickerSelected.has(p.id);
      lbBtn.classList.toggle('st-selected', isSel);
      lbBtn.textContent = isSel ? '✓ Terpilih' : (isVideo ? '+ Pilih Video Ini' : '+ Pilih Foto Ini');
      lbBtn.onclick = () => {
        togglePickerSelect(p.id);
      };
    }
  }

  async function warmThumbsForGallery(id) {
    const targetId = id || activeGalleryId;
    if (!targetId) return;
    toast('Menyiapkan cache thumbnail di latar belakang...');
    try {
      const res = await apiFetch(`/editor/galleries/${targetId}/warm-thumbs`, { method: 'POST' });
      toast(`Thumbnail siap: ${res.cached}/${res.total} berkas${res.remaining > 0 ? ' (sisanya berjalan di latar belakang)' : ''}`);
      if (activeGalleryId && String(activeGalleryId) === String(targetId)) {
        viewGallery(activeGalleryId, false);
      }
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function bindEvents() {
    $('st-refreshBtn').onclick = () => {
      toast('Memuat ulang daftar galeri...');
      loadGalleries();
      if (activeGalleryId) viewGallery(activeGalleryId, false);
    };

    $('st-modeStudioBtn').onclick = () => switchCategory('studio');
    $('st-modeWeddingBtn').onclick = () => switchCategory('wedding');

    $('st-newGalleryBtn').onclick = () => openManageDialog('new');

    $('st-mLink').addEventListener('input', e => {
      validatedFolderId = null;
      if (linkDebounce) clearTimeout(linkDebounce);
      const val = e.target.value;
      linkDebounce = setTimeout(async () => {
        validatedFolderId = await checkDriveLink(val, $('st-mLinkResult'), false);
      }, 400);
    });

    $('st-mResultLink').addEventListener('input', e => {
      validatedResultFolderId = null;
      if (resultLinkDebounce) clearTimeout(resultLinkDebounce);
      const val = e.target.value;
      resultLinkDebounce = setTimeout(async () => {
        validatedResultFolderId = await checkDriveLink(val, $('st-mResultLinkResult'), true);
      }, 400);
    });

    $('st-mCancelBtn').onclick = () => closeDialog('st-manageDlg');
    $('st-mDeleteBtn').onclick = deleteGallery;
    $('st-mRegenTokenBtn').onclick = regenerateClientToken;

    $('st-manageForm').onsubmit = async (e) => {
      e.preventDefault();
      if (linkDebounce) clearTimeout(linkDebounce);
      if (resultLinkDebounce) clearTimeout(resultLinkDebounce);

      $('st-mSubmit').disabled = true;
      try {
        const id = $('st-mId').value;

        if (!validatedFolderId) {
          validatedFolderId = await checkDriveLink($('st-mLink').value, $('st-mLinkResult'), false);
        }
        if (!validatedFolderId) {
          throw new Error('Folder sumber wajib diisi dan valid');
        }

        const rawResultVal = ($('st-mResultLink').value || '').trim();
        if (!rawResultVal) {
          validatedResultFolderId = '';
        } else if (!validatedResultFolderId) {
          validatedResultFolderId = await checkDriveLink(rawResultVal, $('st-mResultLinkResult'), true);
          if (validatedResultFolderId === null) {
            throw new Error('Link/ID Folder Hasil Edit tidak valid');
          }
        }

        const body = {
          title: $('st-mName').value.trim(),
          max_select: currentCategory === 'wedding' ? 0 : (parseInt($('st-mLimit').value, 10) || 0),
          folder_id: validatedFolderId,
          source_folder_id: validatedFolderId,
          result_folder_id: validatedResultFolderId,
          category: currentCategory
        };

        if (id) {
          const existing = galleries.find(x => String(x.id) === String(id));
          if (existing && existing.source_folder_id !== validatedFolderId && Number(existing.selected_count) > 0) {
            const ok = await confirmDialog({
              title: 'Folder Mentah Diubah!',
              message: 'Pilihan berkas klien yang sudah ada pada galeri ini akan di-reset. Apakah Anda yakin ingin melanjutkan?',
              confirmText: 'Ya, Reset & Simpan',
              cancelText: 'Batal',
              variant: 'danger'
            });
            if (!ok) {
              return;
            }
          }
          await apiFetch(`/editor/galleries/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
          toast('Galeri berhasil disimpan', 'success');
        } else {
          const createRes = await apiFetch('/editor/galleries', { method: 'POST', body: JSON.stringify(body) });
          closeDialog('st-manageDlg');
          await loadGalleries();
          const newLink = toAbsoluteUrl(createRes?.link);
          if (newLink) {
            await copyText(newLink, 'Galeri dibuat & link klien langsung disalin!');
          } else {
            toast('Galeri berhasil dibuat', 'success');
          }
          return;
        }

        closeDialog('st-manageDlg');
        await loadGalleries();
        if (id && activeGalleryId && String(activeGalleryId) === String(id)) {
          viewGallery(id, false);
        }
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        $('st-mSubmit').disabled = false;
      }
    };

    $('st-settingsBtn').onclick = async () => {
      try {
        const res = await apiFetch('/editor/settings');
        $('st-sWa').value = res.whatsapp || '';
        openDialog('st-settingsDlg');
      } catch (e) {
        toast(e.message);
      }
    };

    $('st-sCancelBtn').onclick = () => closeDialog('st-settingsDlg');

    $('st-settingsForm').onsubmit = async (e) => {
      e.preventDefault();
      $('st-sSubmit').disabled = true;
      try {
        const wa = $('st-sWa').value.replace(/[^0-9]/g, '');
        await apiFetch('/editor/settings', { method: 'PATCH', body: JSON.stringify({ whatsapp: wa }) });
        toast('Pengaturan WA disimpan');
        closeDialog('st-settingsDlg');
      } catch (err) {
        toast(err.message);
      } finally {
        $('st-sSubmit').disabled = false;
      }
    };

    // ==========================================
    // BACKUP & MIGRASI DATA (EKSPOR & IMPOR JSON)
    // ==========================================
    let parsedImportData = null;

    if ($('st-backupBtn')) {
      $('st-backupBtn').onclick = () => {
        parsedImportData = null;
        if ($('st-importFileInput')) $('st-importFileInput').value = '';
        if ($('st-importPreview')) {
          $('st-importPreview').style.display = 'none';
          $('st-importPreview').innerHTML = '';
        }
        if ($('st-importSubmitBtn')) $('st-importSubmitBtn').disabled = true;
        openDialog('st-backupDlg');
      };
    }

    if ($('st-backupCloseBtn')) {
      $('st-backupCloseBtn').onclick = () => closeDialog('st-backupDlg');
    }

    if ($('st-exportBtn')) {
      $('st-exportBtn').onclick = async () => {
        const btn = $('st-exportBtn');
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Menyiapkan berkas...';
        try {
          const data = await apiFetch('/editor/data/export');
          const jsonStr = JSON.stringify(data, null, 2);
          const blob = new Blob([jsonStr], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `bc-studio-backup-${new Date().toISOString().slice(0, 10)}.json`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          toast('File backup JSON berhasil diunduh', 'success');
        } catch (err) {
          toast(err.message || 'Gagal mengekspor data', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      };
    }

    if ($('st-importFileInput')) {
      $('st-importFileInput').onchange = (e) => {
        const file = e.target.files && e.target.files[0];
        const preview = $('st-importPreview');
        const submitBtn = $('st-importSubmitBtn');
        if (!file) {
          parsedImportData = null;
          preview.style.display = 'none';
          submitBtn.disabled = true;
          return;
        }

        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const parsed = JSON.parse(evt.target.result);
            let gCount = 0;
            let hasSettings = false;
            let backend = 'unknown';

            if (Array.isArray(parsed)) {
              gCount = parsed.length;
            } else if (parsed && typeof parsed === 'object') {
              if (Array.isArray(parsed.galleries)) gCount = parsed.galleries.length;
              if (parsed.settings) hasSettings = true;
              if (parsed.source_backend) backend = parsed.source_backend;
            } else {
              throw new Error('Format JSON tidak sesuai format data galeri');
            }

            parsedImportData = parsed;
            preview.style.display = 'block';
            preview.innerHTML = `
              <div style="font-weight: 600; color: #166534; margin-bottom: 2px;">✅ File JSON Valid</div>
              <div>Nama: <code>${esc(file.name)}</code> (${(file.size / 1024).toFixed(1)} KB)</div>
              <div>Jumlah Galeri Terdeteksi: <strong>${gCount}</strong> galeri</div>
              ${hasSettings ? '<div>Pengaturan: Termasuk nomor WA / konfigurasi</div>' : ''}
              ${backend !== 'unknown' ? `<div>Sumber: Backend <code>${esc(backend)}</code></div>` : ''}
            `;
            submitBtn.disabled = false;
          } catch (err) {
            parsedImportData = null;
            preview.style.display = 'block';
            preview.innerHTML = `<div style="color: #dc2626; font-weight: 600;">❌ File tidak valid: ${esc(err.message)}</div>`;
            submitBtn.disabled = true;
          }
        };
        reader.readAsText(file);
      };
    }

    if ($('st-importSubmitBtn')) {
      $('st-importSubmitBtn').onclick = async () => {
        if (!parsedImportData) return;
        const modeRadio = document.querySelector('input[name="st-import-mode"]:checked');
        const mode = modeRadio ? modeRadio.value : 'upsert';
        const overwriteKey = $('st-importOverwriteKey') ? $('st-importOverwriteKey').checked : false;

        const isReplace = mode === 'replace';
        const confirmMsg = isReplace
          ? 'PERINGATAN: Mode Timpa Total akan MENGHAPUS SEMUA data galeri yang ada di sistem ini dan menggantinya dengan isi file backup. Apakah Anda yakin ingin melanjutkan?'
          : 'Apakah Anda yakin ingin mengimpor dan menggabungkan data dari file ini? Galeri dengan token sama akan diperbarui, galeri baru akan ditambahkan.';

        const ok = await confirmDialog({
          title: isReplace ? 'Konfirmasi Timpa Total (Replace All)' : 'Konfirmasi Impor Data (Upsert)',
          message: confirmMsg,
          confirmText: isReplace ? 'Ya, Timpa Semua' : 'Ya, Impor Sekarang',
          variant: isReplace ? 'danger' : 'warning'
        });

        if (!ok) return;

        const btn = $('st-importSubmitBtn');
        btn.disabled = true;
        const origSubmitText = btn.textContent;
        btn.textContent = 'Memproses impor...';

        try {
          const res = await apiFetch('/editor/data/import', {
            method: 'POST',
            body: JSON.stringify({
              data: parsedImportData,
              mode,
              overwrite_editor_key: overwriteKey
            })
          });

          toast(`Impor berhasil! Total: ${res.totalCount || 0} galeri (Baru: ${res.insertedCount || 0}, Diperbarui: ${res.updatedCount || 0})`, 'success');
          closeDialog('st-backupDlg');
          $('st-importFileInput').value = '';
          $('st-importPreview').style.display = 'none';
          parsedImportData = null;

          await loadGalleries();
          if (activeGalleryId) {
            viewGallery(activeGalleryId, false);
          }
        } catch (err) {
          toast(err.message || 'Gagal mengimpor data', 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = origSubmitText;
        }
      };
    }

    $('st-closeDetailBtn').onclick = closeDetailPanel;
    if ($('st-toggleSidebarBtn')) {
      $('st-toggleSidebarBtn').onclick = toggleSidebar;
    }
    window.addEventListener('resize', () => {
      applySidebarState();
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.st-dropdown-wrap')) {
        closeAllDropdowns();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllDropdowns();
      }
    });

    const stepLb = d => {
      const lbVideo = $('st-lbvideo');
      if (lbVideo) {
        lbVideo.src = '';
        lbVideo.style.display = 'none';
      }
      if (isPickerMode) {
        if (!pickerFiltered.length) return;
        currentCur = (currentCur + d + pickerFiltered.length) % pickerFiltered.length;
        showPickerLb();
      } else {
        const list = activeEditorFilterList.length ? activeEditorFilterList : currentPhotos;
        if (!list.length) return;
        currentCur = (currentCur + d + list.length) % list.length;
        showLb();
      }
    };
    $('st-lbPrevBtn').onclick = () => stepLb(-1);
    $('st-lbNextBtn').onclick = () => stepLb(1);
    $('st-lbCloseBtn').onclick = closeLb;

    let touchStartX = 0;
    $('st-lbContent').addEventListener('touchstart', e => {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });
    $('st-lbContent').addEventListener('touchend', e => {
      const dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 50) stepLb(dx > 0 ? -1 : 1);
    }, { passive: true });

    document.addEventListener('keydown', e => {
      if (!$('st-lb').classList.contains('st-open')) return;
      if (e.key === 'ArrowLeft') stepLb(-1);
      if (e.key === 'ArrowRight') stepLb(1);
      if (e.key === 'Escape') closeLb();
    });

    // Delegation on detail grid
    const editorGrid = $('st-editorGrid');
    if (editorGrid) {
      editorGrid.onclick = (e) => {
        const retryBtn = e.target.closest('.st-retry-img-btn');
        if (retryBtn) {
          e.stopPropagation();
          const card = retryBtn.closest('.st-photo-card');
          const idx = parseInt(card.dataset.i, 10);
          const p = activeEditorFilterList[idx] || currentPhotos[idx];
          const img = card.querySelector('img');
          if (img && p) {
            card.classList.remove('st-img-error');
            const candidates = getImageCandidates(p, false);
            let attempt = 0;
            img.onerror = () => {
              attempt++;
              if (attempt < candidates.length) {
                img.src = candidates[attempt] + (candidates[attempt].includes('?') ? '&' : '?') + '_t=' + Date.now();
              } else {
                card.classList.add('st-img-error');
              }
            };
            const first = candidates[0] || p.src;
            img.src = first + (first.includes('?') ? '&' : '?') + '_t=' + Date.now();
          }
          return;
        }

        const card = e.target.closest('.st-photo-card');
        if (card) {
          openLb(parseInt(card.dataset.i, 10));
        }
      };
    }
  }

  init();
})();
