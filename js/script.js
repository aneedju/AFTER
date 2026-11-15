/* Personal movie / drama review log.
 * Everything is stored in this browser's localStorage.
 * Closing the window or pressing X keeps the draft; clearing site data removes everything.
 */
(() => {
  'use strict';

  // ===== Storage keys =====
  const REVIEWS_KEY = 'reviews:list';
  const LEGACY_REVIEWS_KEY = 'cinelog:reviews'; // from the first version, read once as a fallback
  const VIEW_MODE_KEY = 'reviews:viewMode';
  const DRAFT_PREFIX = 'reviews:draft:'; // + 'new' or the review id

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const els = {
    grid: $('reviewGrid'), empty: $('emptyState'), emptyTitle: $('emptyTitle'), emptyDesc: $('emptyDesc'),
    search: $('searchInput'), yearSelect: $('yearSelect'), viewToggle: $('viewToggle'), sort: $('sortSelect'), chips: $('filterChips'),
    totalCount: $('totalCount'), todayStamp: $('todayStamp'),
    openWrite: $('openWrite'), emptyWrite: $('emptyWrite'),
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
  let reviews = readJSON(REVIEWS_KEY, null) || readJSON(LEGACY_REVIEWS_KEY, []);
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
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2200);
  }

  function saveReviews() {
    const ok = writeJSON(REVIEWS_KEY, reviews);
    if (!ok) alert('Not enough storage space. Try a smaller photo or delete an old review.');
    return ok;
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
    if (!r.image) return Promise.resolve(4 / 3);
    if (ratioCache[r.id + r.image.length]) return Promise.resolve(ratioCache[r.id + r.image.length]);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => { const v = img.naturalWidth / img.naturalHeight || 4 / 3; ratioCache[r.id + r.image.length] = v; resolve(v); };
      img.onerror = () => resolve(4 / 3);
      img.src = r.image;
    });
  }
  const columnCount = () => {
    const w = window.innerWidth;
    return w <= 460 ? 1 : w <= 760 ? 2 : w <= 1100 ? 3 : 4;
  };
  function cardHTML(r) {
    return `
      <article class="card" data-id="${r.id}" tabindex="0" role="button" aria-label="Open review: ${esc(r.title)}">
        <div class="card-thumb">
          ${r.image ? `<img src="${r.image}" alt="">` : '<div class="no-image">No image</div>'}
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
  function openDetail(id) {
    const r = reviews.find((x) => x.id === id);
    if (!r) return;
    detailId = id;
    els.detailPhoto.innerHTML = r.image ? `<img src="${r.image}" alt="">` : '<div class="no-image">No image</div>';
    els.detailTitle.textContent = r.title;
    els.detailMeta.textContent = `${typeLabel(r.type)} — Watched ${fmtDate(r.date)}`;
    els.detailRating.innerHTML = `${starsHTML(r.rating)}<span class="num">${fmtRating(r.rating)}</span><span class="max">/ 5</span>`;
    els.detailContent.textContent = r.content || 'No written review.';
    els.detailContent.classList.toggle('muted', !r.content);
    openSheet(els.detailModal);
    els.detailModal.querySelector('.sheet').scrollTop = 0;
  }

  els.editBtn.addEventListener('click', () => {
    const id = detailId;
    closeSheet(els.detailModal);
    openWrite(id);
  });
  els.deleteBtn.addEventListener('click', () => {
    const r = reviews.find((x) => x.id === detailId);
    if (!r) return;
    if (!confirm(`Delete "${r.title}"? This can't be undone.`)) return;
    reviews = reviews.filter((x) => x.id !== detailId);
    saveReviews();
    removeDraft(detailId);
    closeSheet(els.detailModal);
    render();
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
    };
  }

  const isFormEmpty = (d) => !d.title.trim() && !d.rating && !d.content.trim() && !d.image;

  function sameAsOriginal(d) {
    const o = reviews.find((r) => r.id === form.editingId);
    return !!o && o.type === d.type && o.title === d.title.trim() && o.rating === d.rating &&
      o.date === d.date && o.content === d.content.trim() && o.image === d.image;
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
      const ok = writeJSON(key, { ...data, savedAt: Date.now() });
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

  function fillForm(d) {
    form.type = d.type || 'movie';
    els.typeSegment.querySelectorAll('.chip').forEach((b) => b.classList.toggle('active', b.dataset.type === form.type));
    els.title.value = d.title || '';
    els.date.value = d.date || todayStr();
    els.content.value = d.content || '';
    els.charCount.textContent = els.content.value.length;
    setPhoto(d.image || '', { save: false });
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
      fillForm(draft);
      setStatus('Restored your unsaved draft', true);
    } else if (target) {
      fillForm(target);
    } else {
      fillForm({ type: 'movie', date: todayStr() });
    }

    openSheet(els.writeModal);
    const writeSheet = els.writeModal.querySelector('.sheet');
    writeSheet.scrollTop = 0;
    // Desktop only: on phones, focusing the title pops up the keyboard and scrolls the sheet down,
    // so the photo area at the top ends up hidden when the sheet opens.
    const isTouch = window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 760;
    if (!isTouch) {
      setTimeout(() => els.title.focus({ preventScroll: true }), 60);
    } else {
      // make sure the sheet starts at the very top after the open animation / address-bar changes
      requestAnimationFrame(() => { writeSheet.scrollTop = 0; });
      setTimeout(() => { writeSheet.scrollTop = 0; }, 120);
    }
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
    fillForm(target || { type: 'movie', date: todayStr() });
    setStatus('');
  });

  // ===== Photo =====
  function setPhoto(dataUrl, { save = true } = {}) {
    form.image = dataUrl;
    els.photoPreview.hidden = !dataUrl;
    els.dropzoneEmpty.hidden = !!dataUrl;
    els.photoRemove.hidden = !dataUrl;
    els.dropzone.classList.toggle('has-image', !!dataUrl);
    if (dataUrl) els.photoPreview.src = dataUrl; else els.photoPreview.removeAttribute('src');
    if (save) scheduleDraftSave();
  }

  // Resize + JPEG-compress so many photos fit in localStorage
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
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const d = currentFormData();
    let valid = true;

    if (!d.title.trim()) { els.titleError.hidden = false; els.title.focus(); valid = false; }
    if (!d.rating) { els.ratingError.hidden = false; if (valid) els.starInput.focus(); valid = false; }
    if (!valid) return;

    const payload = {
      type: d.type,
      title: d.title.trim(),
      rating: d.rating,
      date: d.date || todayStr(),
      content: d.content.trim(),
      image: d.image,
    };

    const prev = reviews;
    if (form.editingId) {
      reviews = reviews.map((r) => (r.id === form.editingId ? { ...r, ...payload, updatedAt: Date.now() } : r));
    } else {
      reviews = [{ id: uid(), createdAt: Date.now(), ...payload }, ...reviews];
    }

    if (!saveReviews()) { reviews = prev; return; }

    clearTimeout(draftTimer);
    removeDraft(form.editingId);
    const wasEdit = !!form.editingId;
    closeSheet(els.writeModal);
    render();
    showToast(wasEdit ? 'Review updated' : 'Review saved');
  });

  // Keep the draft even if the tab is closed or reloaded mid-write
  window.addEventListener('beforeunload', () => { clearTimeout(draftTimer); saveDraft(); });
  window.addEventListener('pagehide', () => { clearTimeout(draftTimer); saveDraft(); });

  // ===== Start =====
  try { localStorage.removeItem('reviews:theme'); } catch { /* old dark-mode setting, no longer used */ }
  render();
})();
