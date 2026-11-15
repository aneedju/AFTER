/* AFTER — personal movie / drama review log.
 * Reviews and photos are stored in Supabase (login required), so every device sees the same data.
 * Drafts (unsaved writing) are still kept in this browser's localStorage.
 */
(() => {
  'use strict';

  // ===== Supabase =====
  const SUPABASE_URL = 'https://ihsrcwfyrrttahmenhcn.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_vSbnJwmd44DeqwVbL-dOwA_fjS1fyDJ'; // public (publishable) key — safe in the browser
  const BUCKET = 'photos';
  const SIGN_TTL = 60 * 60 * 24; // signed photo links last 1 day (a fresh set is made on every load)
  const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;

  // ===== Storage keys (this browser only) =====
  const REVIEWS_KEY = 'reviews:list'; // old local data, only read for "Import from this device"
  const LEGACY_REVIEWS_KEY = 'cinelog:reviews';
  const VIEW_MODE_KEY = 'reviews:viewMode';
  const DRAFT_PREFIX = 'reviews:draft:'; // + 'new' or the review id
  const IMPORTED_PREFIX = 'reviews:imported:'; // + user id

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('reviewGrid'), empty: $('emptyState'), emptyTitle: $('emptyTitle'), emptyDesc: $('emptyDesc'),
    search: $('searchInput'), yearSelect: $('yearSelect'), viewToggle: $('viewToggle'), sort: $('sortSelect'), chips: $('filterChips'),
    totalCount: $('totalCount'), todayStamp: $('todayStamp'),
    openWrite: $('openWrite'), emptyWrite: $('emptyWrite'),
    logoutBtn: $('logoutBtn'), importLocal: $('importLocal'),
    // auth
    authGate: $('authGate'), authForm: $('authForm'), authEmail: $('authEmail'), authPassword: $('authPassword'),
    authError: $('authError'), authSubmit: $('authSubmit'),
    // write
    writeModal: $('writeModal'), form: $('reviewForm'), writeTitle: $('writeTitle'),
    draftStatus: $('draftStatus'), typeSegment: $('typeSegment'),
    title: $('titleInput'), titleError: $('titleError'),
    starInput: $('starInput'), ratingNumber: $('ratingNumber'), ratingError: $('ratingError'),
    date: $('dateInput'), content: $('contentInput'), charCount: $('charCount'),
    dropzone: $('dropzone'), dropzoneEmpty: $('dropzoneEmpty'), photoPreview: $('photoPreview'),
    photoInput: $('photoInput'), photoRemove: $('photoRemove'),
    discardDraft: $('discardDraft'), saveBtn: $('saveBtn'),
    // detail
    detailModal: $('detailModal'), detailPhoto: $('detailPhoto'), detailTitle: $('detailTitle'),
    detailMeta: $('detailMeta'), detailRating: $('detailRating'), detailContent: $('detailContent'),
    editBtn: $('editBtn'), deleteBtn: $('deleteBtn'),
    toast: $('toast'),
  };

  // ===== State =====
  // review: { id, type, title, rating, date, content, imagePath, thumb, image, createdAt, updatedAt }
  //   imagePath = path in the photos bucket, thumb / image = temporary signed links (small / full size)
  let reviews = [];
  let loaded = false;
  let user = null;
  let saving = false;
  const view = { filter: 'all', sort: 'new', query: '', year: 'all', mode: readJSON(VIEW_MODE_KEY, 'photo') === 'list' ? 'list' : 'photo' };
  const form = { editingId: null, type: 'movie', rating: 0, image: '' };
  let detailId = null;
  let draftTimer = null;
  let toastTimer = null;

  // ===== Helpers =====
  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }
  const newId = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const typeLabel = (t) => (t === 'drama' ? 'Drama' : 'Movie');
  const fmtRating = (n) => Number(n).toFixed(1);
  // diary-style date: 2026. 11. 14
  const fmtDate = (s) => {
    if (!s) return '';
    const [y, m, d] = s.split('-');
    return `${y}. ${m}. ${d}`;
  };
  const isDataUrl = (s) => typeof s === 'string' && s.startsWith('data:');
  const thumbPath = (p) => p.replace(/\.jpg$/, '_t.jpg');
  const photoStateOf = (image) => (isDataUrl(image) ? 'new' : image ? 'keep' : 'none');

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  const rowToReview = (row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    rating: Number(row.rating),
    date: row.watched_on || '',
    content: row.content || '',
    imagePath: row.image_path || '',
    thumb: '',
    image: '',
    createdAt: Date.parse(row.created_at) || 0,
    updatedAt: Date.parse(row.updated_at) || 0,
  });

  // ===== Photos in Supabase Storage =====
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function resizeToJpegBlob(src, maxSize, quality) {
    const img = await loadImage(src);
    const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality);
    });
  }

  // uploads the full photo and a small thumbnail (used by the grid so it loads fast)
  async function uploadPhoto(dataUrl, path) {
    const full = await (await fetch(dataUrl)).blob();
    const thumb = await resizeToJpegBlob(dataUrl, 520, 0.8);
    const opts = { contentType: 'image/jpeg', upsert: false, cacheControl: '31536000' };
    let res = await sb.storage.from(BUCKET).upload(path, full, opts);
    if (res.error) throw res.error;
    res = await sb.storage.from(BUCKET).upload(thumbPath(path), thumb, opts);
    if (res.error) {
      await sb.storage.from(BUCKET).remove([path]);
      throw res.error;
    }
  }

  async function removePhoto(path) {
    if (!path) return;
    await sb.storage.from(BUCKET).remove([path, thumbPath(path)]);
  }

  async function signThumbs(list) {
    const paths = list.filter((r) => r.imagePath).map((r) => thumbPath(r.imagePath));
    if (!paths.length) return;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUrls(paths, SIGN_TTL);
    if (error || !data) { console.error(error); return; }
    const map = {};
    data.forEach((d) => { if (d.signedUrl) map[d.path] = d.signedUrl; });
    list.forEach((r) => { if (r.imagePath) r.thumb = map[thumbPath(r.imagePath)] || ''; });
  }

  async function ensureFull(r) {
    if (!r.imagePath || r.image) return;
    const { data } = await sb.storage.from(BUCKET).createSignedUrl(r.imagePath, SIGN_TTL);
    if (data) r.image = data.signedUrl;
  }

  async function loadReviews() {
    const { data, error } = await sb.from('reviews').select('*').order('created_at', { ascending: false });
    if (error) {
      console.error(error);
      showToast('Could not load reviews');
      return false;
    }
    reviews = data.map(rowToReview);
    await signThumbs(reviews);
    loaded = true;
    return true;
  }

  // ===== Stars =====
  const fillPct = (value, i) => Math.max(0, Math.min(1, value - (i - 1))) * 100;

  function starsHTML(value) {
    let html = '<span class="stars" aria-hidden="true">';
    for (let i = 1; i <= 5; i++) html += `<span class="star" style="--fill:${fillPct(value, i)}%"></span>`;
    return html + '</span>';
  }

  // Build the 5 stars once and only update their fill, so elements are never replaced mid-click
  els.starInput.innerHTML = [1, 2, 3, 4, 5].map((i) => `<span class="star" data-i="${i}"></span>`).join('');
  const starEls = Array.from(els.starInput.children);

  function renderStarInput(value) {
    starEls.forEach((s, idx) => s.style.setProperty('--fill', fillPct(value, idx + 1) + '%'));
    els.starInput.setAttribute('aria-valuenow', value);
  }

  function valueFromPointer(e) {
    for (let idx = 0; idx < starEls.length; idx++) {
      const rect = starEls[idx].getBoundingClientRect();
      const isLast = idx === starEls.length - 1;
      if (e.clientX <= rect.right + 3 || isLast) {
        if (e.clientX < rect.left - 3 && idx === 0) return null;
        return (e.clientX - rect.left) < rect.width / 2 ? idx + 0.5 : idx + 1;
      }
    }
    return null;
  }

  function setRating(v, { save = true } = {}) {
    form.rating = v;
    renderStarInput(v);
    els.ratingNumber.textContent = fmtRating(v);
    if (v > 0) els.ratingError.hidden = true;
    if (save) scheduleDraftSave();
  }

  els.starInput.addEventListener('mousemove', (e) => {
    const v = valueFromPointer(e);
    if (v !== null) { renderStarInput(v); els.ratingNumber.textContent = fmtRating(v); }
  });
  els.starInput.addEventListener('mouseleave', () => {
    renderStarInput(form.rating);
    els.ratingNumber.textContent = fmtRating(form.rating);
  });
  els.starInput.addEventListener('click', (e) => {
    const v = valueFromPointer(e);
    if (v === null) return;
    setRating(v === form.rating ? 0 : v); // clicking the same value clears it
  });
  els.starInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); setRating(Math.min(5, form.rating + 0.5)); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); setRating(Math.max(0, form.rating - 0.5)); }
  });

  // ===== Today's date in the header =====
  (() => {
    const d = new Date();
    els.todayStamp.textContent = `${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())}`;
  })();

  // ===== List =====
  const yearOf = (r) => (r.date || '').slice(0, 4) || 'N/A';

  // year dropdown built from the reviews that exist
  function populateYears() {
    const counts = {};
    reviews.forEach((r) => { const y = yearOf(r); counts[y] = (counts[y] || 0) + 1; });
    const years = Object.keys(counts).sort((a, b) => b.localeCompare(a));
    if (view.year !== 'all' && !counts[view.year]) view.year = 'all';
    els.yearSelect.innerHTML = '<option value="all">All years</option>' +
      years.map((y) => `<option value="${y}">${y} (${counts[y]})</option>`).join('');
    els.yearSelect.value = view.year;
  }

  function getVisible() {
    const q = view.query.trim().toLowerCase();
    const list = reviews.filter((r) =>
      (view.filter === 'all' || r.type === view.filter) &&
      (view.year === 'all' || yearOf(r) === view.year) &&
      (!q || r.title.toLowerCase().includes(q))
    );
    const sorters = {
      new: (a, b) => (b.date || '').localeCompare(a.date || '') || b.createdAt - a.createdAt,
      old: (a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt,
      high: (a, b) => b.rating - a.rating || b.createdAt - a.createdAt,
      low: (a, b) => a.rating - b.rating || b.createdAt - a.createdAt,
      title: (a, b) => a.title.localeCompare(b.title),
    };
    return list.sort(sorters[view.sort]);
  }

  // Photos keep their own aspect ratio, so cards are stacked into the shortest column (masonry)
  const ratioCache = {};
  function getRatio(r) {
    const src = r.thumb || r.image;
    if (!src) return Promise.resolve(4 / 3);
    const key = r.id + '|' + r.imagePath;
    if (ratioCache[key]) return Promise.resolve(ratioCache[key]);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { const v = img.naturalWidth / img.naturalHeight || 4 / 3; ratioCache[key] = v; resolve(v); };
      img.onerror = () => resolve(4 / 3);
      img.src = src;
    });
  }
  const columnCount = () => {
    const w = window.innerWidth;
    return w <= 460 ? 1 : w <= 760 ? 2 : w <= 1100 ? 3 : 4;
  };
  function cardHTML(r) {
    const src = r.thumb || r.image;
    return `
      <article class="card" data-id="${r.id}" tabindex="0" role="button" aria-label="Open review: ${esc(r.title)}">
        <div class="card-thumb">
          ${src ? `<img src="${src}" alt="">` : '<div class="no-image">No image</div>'}
        </div>
        <div class="card-meta">
          <div class="card-text">
            <h3 class="card-title">${esc(r.title)}</h3>
            <p class="card-sub">${typeLabel(r.type)} — ${fmtDate(r.date)}</p>
          </div>
          <span class="card-rating"><span class="star" style="--fill:100%"></span>${fmtRating(r.rating)}</span>
        </div>
      </article>`;
  }

  function rowHTML(r) {
    return `
      <article class="row" data-id="${r.id}" tabindex="0" role="button" aria-label="Open review: ${esc(r.title)}">
        <h3 class="row-title">${esc(r.title)}</h3>
        <span class="row-type">${typeLabel(r.type)}</span>
        <span class="row-date">${fmtDate(r.date)}</span>
        <span class="row-rating"><span class="star" style="--fill:100%"></span>${fmtRating(r.rating)}</span>
      </article>`;
  }

  let gridToken = 0;
  let gridCols = 0;
  async function renderGrid() {
    const token = ++gridToken;

    // nothing to show until the first load finishes (avoids a "No reviews yet" flash)
    if (!loaded) {
      els.grid.innerHTML = '';
      els.grid.hidden = false;
      els.empty.hidden = true;
      return;
    }

    const list = getVisible();
    els.grid.classList.toggle('is-list', view.mode === 'list');

    if (view.mode === 'list') {
      // group by year when the list is ordered by date
      const grouped = view.sort === 'new' || view.sort === 'old';
      let html = '', lastYear = null;
      list.forEach((r) => {
        const y = yearOf(r);
        if (grouped && y !== lastYear) {
          const n = list.filter((x) => yearOf(x) === y).length;
          html += `<h2 class="year-head">${y}<span>${n} ${n === 1 ? 'entry' : 'entries'}</span></h2>`;
          lastYear = y;
        }
        html += rowHTML(r);
      });
      els.grid.innerHTML = `<div class="list">${html}</div>`;
    } else {
      const ratios = await Promise.all(list.map(getRatio));
      if (token !== gridToken) return; // a newer render started

      const n = gridCols = columnCount();
      const cols = Array.from({ length: n }, () => ({ h: 0, html: [] }));
      list.forEach((r, i) => {
        const c = cols.reduce((min, x) => (x.h < min.h ? x : min), cols[0]);
        c.html.push(cardHTML(r));
        c.h += 1 / ratios[i] + 0.4; // image height relative to column width + paper margin and title rows
      });
      els.grid.innerHTML = cols.map((c) => `<div class="grid-col">${c.html.join('')}</div>`).join('');
    }

    els.empty.hidden = list.length > 0;
    els.grid.hidden = list.length === 0;
    if (!list.length) {
      if (!reviews.length) {
        els.emptyTitle.textContent = 'No reviews yet';
        els.emptyDesc.textContent = 'Write your first review.';
        els.emptyWrite.hidden = false;
      } else {
        els.emptyTitle.textContent = 'No matching reviews';
        els.emptyDesc.textContent = 'Try a different filter or search.';
        els.emptyWrite.hidden = true;
      }
    }
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view.mode === 'photo' && columnCount() !== gridCols) renderGrid(); }, 150);
  });

  function render() {
    els.totalCount.textContent = reviews.length;
    populateYears();
    renderGrid();
    updateWriteButton();
  }

  els.grid.addEventListener('click', (e) => {
    const card = e.target.closest('.card, .row');
    if (card) openDetail(card.dataset.id);
  });
  els.grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.card, .row');
    if (card) { e.preventDefault(); openDetail(card.dataset.id); }
  });
  els.search.addEventListener('input', () => { view.query = els.search.value; renderGrid(); });
  els.yearSelect.addEventListener('change', () => { view.year = els.yearSelect.value; renderGrid(); });
  els.sort.addEventListener('change', () => { view.sort = els.sort.value; renderGrid(); });
  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    view.filter = chip.dataset.filter;
    els.chips.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === chip));
    renderGrid();
  });

  // photo / list toggle (remembered)
  function syncViewToggle() {
    els.viewToggle.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.mode === view.mode));
  }
  els.viewToggle.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b || b.dataset.mode === view.mode) return;
    view.mode = b.dataset.mode;
    writeJSON(VIEW_MODE_KEY, view.mode);
    syncViewToggle();
    renderGrid();
  });
  syncViewToggle();

  // ===== Sheets =====
  function openSheet(el) {
    el.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet(el) {
    el.hidden = true;
    if (els.writeModal.hidden && els.detailModal.hidden) document.body.style.overflow = '';
  }
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (!closer) return;
    if (closer.dataset.close === 'write') closeWrite();
    if (closer.dataset.close === 'detail') closeSheet(els.detailModal);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.writeModal.hidden) closeWrite();
    else if (!els.detailModal.hidden) closeSheet(els.detailModal);
  });

  // ===== Detail =====
  function setDetailPhoto(r) {
    const src = r.image || r.thumb;
    els.detailPhoto.innerHTML = src ? `<img src="${src}" alt="">` : '<div class="no-image">No image</div>';
  }

  function openDetail(id) {
    const r = reviews.find((x) => x.id === id);
    if (!r) return;
    detailId = id;
    setDetailPhoto(r);
    els.detailTitle.textContent = r.title;
    els.detailMeta.textContent = `${typeLabel(r.type)} — Watched ${fmtDate(r.date)}`;
    els.detailRating.innerHTML = `${starsHTML(r.rating)}<span class="num">${fmtRating(r.rating)}</span><span class="max">/ 5</span>`;
    els.detailContent.textContent = r.content || 'No written review.';
    els.detailContent.classList.toggle('muted', !r.content);
    openSheet(els.detailModal);
    els.detailModal.querySelector('.sheet').scrollTop = 0;

    // the grid only loaded the thumbnail; swap in the full-size photo once it is ready
    if (r.imagePath && !r.image) {
      ensureFull(r).then(() => {
        if (!r.image) return;
        const pre = new Image();
        pre.onload = () => { if (detailId === id && !els.detailModal.hidden) setDetailPhoto(r); };
        pre.src = r.image;
      });
    }
  }

  els.editBtn.addEventListener('click', () => {
    const id = detailId;
    closeSheet(els.detailModal);
    openWrite(id);
  });
  els.deleteBtn.addEventListener('click', async () => {
    const r = reviews.find((x) => x.id === detailId);
    if (!r) return;
    if (!confirm(`Delete "${r.title}"? This can't be undone.`)) return;
    const { error } = await sb.from('reviews').delete().eq('id', r.id);
    if (error) {
      console.error(error);
      showToast('Could not delete — check your connection');
      return;
    }
    removePhoto(r.imagePath).catch((e) => console.error(e));
    reviews = reviews.filter((x) => x.id !== r.id);
    removeDraft(r.id);
    closeSheet(els.detailModal);
    render();
    updateImportButton();
    showToast('Review deleted');
  });

  // ===== Write / edit =====
  const draftKey = (id) => DRAFT_PREFIX + (id || 'new');

  function currentFormData() {
    return {
      type: form.type,
      title: els.title.value,
      rating: form.rating,
      date: els.date.value,
      content: els.content.value,
      image: form.image,
      photo: photoStateOf(form.image), // 'new' (picked on this device) | 'keep' (already saved) | 'none'
    };
  }

  const isFormEmpty = (d) => !d.title.trim() && !d.rating && !d.content.trim() && !d.image;

  function sameAsOriginal(d) {
    const o = reviews.find((r) => r.id === form.editingId);
    return !!o && o.type === d.type && o.title === d.title.trim() && o.rating === d.rating &&
      o.date === d.date && o.content === d.content.trim() && d.photo === (o.imagePath ? 'keep' : 'none');
  }

  function scheduleDraftSave() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 300);
  }

  function setStatus(text, restored = false) {
    els.draftStatus.textContent = text;
    els.draftStatus.classList.toggle('restored', restored);
  }

  function saveDraft() {
    if (els.writeModal.hidden) return;
    const data = currentFormData();
    const key = draftKey(form.editingId);
    const nothingToKeep = form.editingId ? sameAsOriginal(data) : isFormEmpty(data);
    if (nothingToKeep) {
      try { localStorage.removeItem(key); } catch { /* ignore */ }
      setStatus('');
    } else {
      // links to saved photos expire, so only a photo picked on this device is kept inside the draft
      const ok = writeJSON(key, { ...data, image: isDataUrl(data.image) ? data.image : '', savedAt: Date.now() });
      setStatus(ok ? 'Draft saved automatically' : 'Could not save the draft (photo may be too large)');
    }
    updateWriteButton();
  }

  function removeDraft(id) {
    try { localStorage.removeItem(draftKey(id)); } catch { /* ignore */ }
    updateWriteButton();
  }

  function updateWriteButton() {
    els.openWrite.textContent = localStorage.getItem(draftKey(null)) ? 'Continue draft' : 'Write review';
  }

  // a saved review as form data
  const sourceFromReview = (r) => ({ ...r, photo: r.imagePath ? 'keep' : 'none' });

  function fillForm(d, target = null) {
    form.type = d.type || 'movie';
    els.typeSegment.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.type === form.type));
    els.title.value = d.title || '';
    els.date.value = d.date || todayStr();
    els.content.value = d.content || '';
    els.charCount.textContent = els.content.value.length;

    const state = d.photo || (isDataUrl(d.image) ? 'new' : 'none'); // drafts from older versions have no "photo"
    let img = '';
    if (state === 'new') img = d.image || '';
    else if (state === 'keep' && target) img = target.image || target.thumb || '';
    setPhoto(img, { save: false });

    setRating(d.rating || 0, { save: false });
    els.titleError.hidden = true;
    els.ratingError.hidden = true;
  }

  function openWrite(editId = null) {
    form.editingId = editId;
    const draft = readJSON(draftKey(editId), null);
    const target = editId ? reviews.find((r) => r.id === editId) : null;

    els.writeTitle.textContent = editId ? 'Edit review' : 'Write a review';
    els.saveBtn.textContent = editId ? 'Save changes' : 'Save review';
    els.discardDraft.textContent = editId ? 'Reset changes' : 'Discard draft';
    setStatus('');

    if (draft) {
      fillForm(draft, target);
      setStatus('Restored your unsaved draft', true);
    } else if (target) {
      fillForm(sourceFromReview(target), target);
    } else {
      fillForm({ type: 'movie', date: todayStr() });
    }

    // the form starts with the thumbnail; swap in the full-size photo once it is ready
    if (target && target.imagePath && !target.image) {
      ensureFull(target).then(() => {
        if (form.editingId === target.id && target.image && form.image === target.thumb) {
          setPhoto(target.image, { save: false });
        }
      });
    }

    openSheet(els.writeModal);
    const writeSheet = els.writeModal.querySelector('.sheet');
    writeSheet.scrollTop = 0;
    // Desktop only: on phones, focusing the title pops up the keyboard and scrolls the sheet down,
    // so the photo area at the top ends up hidden when the sheet opens.
    const isTouch = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 760;
    if (!isTouch) setTimeout(() => els.title.focus({ preventScroll: true }), 60);
  }

  // X, overlay click and ESC all keep the draft
  function closeWrite() {
    clearTimeout(draftTimer);
    saveDraft();
    closeSheet(els.writeModal);
  }

  els.openWrite.addEventListener('click', () => openWrite(null));
  els.emptyWrite.addEventListener('click', () => openWrite(null));

  els.typeSegment.addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    form.type = b.dataset.type;
    els.typeSegment.querySelectorAll('.chip').forEach((s) => s.classList.toggle('active', s === b));
    scheduleDraftSave();
  });
  els.title.addEventListener('input', () => { if (els.title.value.trim()) els.titleError.hidden = true; scheduleDraftSave(); });
  els.date.addEventListener('input', scheduleDraftSave);
  els.content.addEventListener('input', () => { els.charCount.textContent = els.content.value.length; scheduleDraftSave(); });

  els.discardDraft.addEventListener('click', () => {
    const editing = form.editingId;
    if (!confirm(editing ? 'Discard your changes and restore the original review?' : 'Clear everything you have written?')) return;
    clearTimeout(draftTimer);
    removeDraft(editing);
    const target = editing ? reviews.find((r) => r.id === editing) : null;
    if (target) fillForm(sourceFromReview(target), target);
    else fillForm({ type: 'movie', date: todayStr() });
    setStatus('');
  });

  // ===== Photo (in the form) =====
  function setPhoto(src, { save = true } = {}) {
    form.image = src;
    els.photoPreview.hidden = !src;
    els.dropzoneEmpty.hidden = !!src;
    els.photoRemove.hidden = !src;
    els.dropzone.classList.toggle('has-image', !!src);
    if (src) els.photoPreview.src = src; else els.photoPreview.removeAttribute('src');
    if (save) scheduleDraftSave();
  }

  // Resize + JPEG-compress before upload
  function compressImage(file, maxSize = 1200, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = reject;
      reader.onload = () => {
        const img = new Image();
        img.onerror = reject;
        img.onload = () => {
          const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please choose an image file'); return; }
    try {
      setPhoto(await compressImage(file));
    } catch {
      showToast('Could not load that image');
    }
  }

  els.dropzone.addEventListener('click', () => els.photoInput.click());
  els.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.photoInput.click(); }
  });
  els.photoInput.addEventListener('change', () => { handleFile(els.photoInput.files[0]); els.photoInput.value = ''; });
  els.photoRemove.addEventListener('click', () => setPhoto(''));
  ['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => { e.preventDefault(); els.dropzone.classList.remove('dragover'); }));
  els.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

  // ===== Save =====
  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (saving || !user) return;
    const d = currentFormData();
    let valid = true;

    if (!d.title.trim()) { els.titleError.hidden = false; els.title.focus(); valid = false; }
    if (!d.rating) { els.ratingError.hidden = false; if (valid) els.starInput.focus(); valid = false; }
    if (!valid) return;

    const editId = form.editingId;
    const old = editId ? reviews.find((r) => r.id === editId) : null;
    const id = editId || newId();
    const label = els.saveBtn.textContent;
    let newPath = '';

    saving = true;
    els.saveBtn.disabled = true;
    els.saveBtn.textContent = 'Saving…';

    try {
      let imagePath = old ? old.imagePath : '';
      if (d.photo === 'new') {
        newPath = `${user.id}/${id}-${Date.now()}.jpg`;
        await uploadPhoto(d.image, newPath);
        imagePath = newPath;
      } else if (d.photo === 'none') {
        imagePath = '';
      }

      const row = {
        type: d.type,
        title: d.title.trim(),
        rating: d.rating,
        watched_on: d.date || todayStr(),
        content: d.content.trim(),
        image_path: imagePath || null,
      };
      const res = editId
        ? await sb.from('reviews').update({ ...row, updated_at: new Date().toISOString() }).eq('id', id).select().single()
        : await sb.from('reviews').insert({ id, ...row }).select().single();
      if (res.error) throw res.error;

      // the old photo is no longer used (replaced or removed)
      if (old && old.imagePath && old.imagePath !== imagePath) removePhoto(old.imagePath).catch((err) => console.error(err));

      const saved = rowToReview(res.data);
      await signThumbs([saved]);
      reviews = editId ? reviews.map((r) => (r.id === id ? saved : r)) : [saved, ...reviews];

      clearTimeout(draftTimer);
      removeDraft(editId);
      closeSheet(els.writeModal);
      render();
      updateImportButton();
      showToast(editId ? 'Review updated' : 'Review saved');
    } catch (err) {
      console.error(err);
      if (newPath) removePhoto(newPath).catch(() => {});
      showToast('Could not save — check your connection');
    } finally {
      saving = false;
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = label;
    }
  });

  // Keep the draft even if the tab is closed or reloaded mid-write
  window.addEventListener('beforeunload', () => { clearTimeout(draftTimer); saveDraft(); });
  window.addEventListener('pagehide', () => { clearTimeout(draftTimer); saveDraft(); });

  // ===== Import reviews that were saved on this device before sync existed =====
  function localReviews() {
    const list = readJSON(REVIEWS_KEY, null) || readJSON(LEGACY_REVIEWS_KEY, []);
    return Array.isArray(list) ? list : [];
  }
  const importedKey = () => IMPORTED_PREFIX + (user ? user.id : '');

  function pendingImport() {
    if (!user || !loaded) return [];
    try { if (localStorage.getItem(importedKey())) return []; } catch { /* ignore */ }
    const seen = new Set(reviews.map((r) => r.createdAt + '|' + r.title));
    return localReviews().filter((r) => r && r.title && !seen.has(r.createdAt + '|' + r.title));
  }

  function updateImportButton() {
    const n = pendingImport().length;
    els.importLocal.hidden = !n;
    els.importLocal.textContent = `Import ${n} from this device`;
  }

  async function importOne(r) {
    const id = newId();
    let imagePath = '';
    if (isDataUrl(r.image)) {
      imagePath = `${user.id}/${id}-${Date.now()}.jpg`;
      await uploadPhoto(r.image, imagePath);
    }
    const created = new Date(r.createdAt || Date.now()).toISOString();
    const { error } = await sb.from('reviews').insert({
      id,
      type: r.type === 'drama' ? 'drama' : 'movie',
      title: String(r.title),
      rating: Number(r.rating) || 0.5,
      watched_on: r.date || null,
      content: r.content || '',
      image_path: imagePath || null,
      created_at: created,
      updated_at: new Date(r.updatedAt || r.createdAt || Date.now()).toISOString(),
    });
    if (error) {
      if (imagePath) await removePhoto(imagePath).catch(() => {});
      throw error;
    }
  }

  els.importLocal.addEventListener('click', async () => {
    const todo = pendingImport();
    if (!todo.length) return;
    if (!confirm(`Import ${todo.length} review(s) saved on this device into your account?`)) return;
    els.importLocal.disabled = true;
    let ok = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
      els.importLocal.textContent = `Importing ${i + 1} / ${todo.length}…`;
      try { await importOne(todo[i]); ok++; } catch (err) { console.error(err); failed++; }
    }
    if (!failed) { try { localStorage.setItem(importedKey(), '1'); } catch { /* ignore */ } }
    await loadReviews();
    render();
    els.importLocal.disabled = false;
    updateImportButton();
    showToast(failed ? `Imported ${ok}, failed ${failed}` : `Imported ${ok} review${ok === 1 ? '' : 's'}`);
  });

  // ===== Login =====
  function showGate() {
    els.authGate.hidden = false;
    els.authForm.hidden = false;
  }

  async function enterApp(session) {
    user = session.user;
    els.authGate.hidden = true;
    loaded = false;
    reviews = [];
    render();
    await loadReviews();
    render();
    updateImportButton();
  }

  function leaveApp() {
    user = null;
    loaded = false;
    reviews = [];
    detailId = null;
    els.writeModal.hidden = true;
    els.detailModal.hidden = true;
    document.body.style.overflow = '';
    els.importLocal.hidden = true;
    render();
    showGate();
  }

  els.authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    els.authError.hidden = true;
    els.authSubmit.disabled = true;
    const { error } = await sb.auth.signInWithPassword({
      email: els.authEmail.value.trim(),
      password: els.authPassword.value,
    });
    els.authSubmit.disabled = false;
    if (error) {
      els.authError.textContent = 'Wrong email or password.';
      els.authError.hidden = false;
      return;
    }
    els.authPassword.value = '';
  });

  els.logoutBtn.addEventListener('click', async () => {
    if (!confirm('Log out?')) return;
    await sb.auth.signOut();
  });

  // ===== Start =====
  try { localStorage.removeItem('reviews:theme'); } catch { /* old dark-mode setting, no longer used */ }
  render();

  if (!sb) {
    els.authError.textContent = 'Could not load the sync library. Check your connection and reload.';
    els.authError.hidden = false;
  } else {
    // Supabase restores a saved login on its own; never call Supabase inside this callback directly
    sb.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        leaveApp();
      } else if (session && (event === 'INITIAL_SESSION' || event === 'SIGNED_IN')) {
        if (!user || user.id !== session.user.id) setTimeout(() => enterApp(session), 0);
      } else if (event === 'INITIAL_SESSION' && !session) {
        showGate();
      }
    });
  }
})();
