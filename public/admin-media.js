'use strict';

(() => {
  const $ = (selector) => document.querySelector(selector);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const id = location.pathname.match(/^\/admin\/products\/([a-zA-Z0-9_-]+)\/?$/)?.[1];
  const endpoint = id ? `/api/admin/products/${encodeURIComponent(id)}` : '';
  const state = { authenticated: false, loading: false, data: null, uploads: [], uploading: false, timer: null, galleryKey: '', xhr: null, unitDirty:false, unitSaving:false, revision:0 };
  const jobLabels = { uploading: 'Đang tải', queued: 'Đang xếp hàng', processing: 'Đang nén & chèn watermark', ready: 'Đã sẵn sàng', failed: 'Xử lý chưa thành công' };
  const activeStatuses = ['uploading', 'queued', 'processing'];
  const fileKinds = { jpg: 'image', jpeg: 'image', png: 'image', webp: 'image', mp4: 'video', mov: 'video', webm: 'video' };
  const safeURL = url => typeof url === 'string' && /^\/(?:images\/products\/[a-zA-Z0-9_.-]+|media\/[a-f0-9-]{36}\/(?:image\.webp|poster\.webp|video\.mp4))$/.test(url) ? url : '';
  const bytes = value => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return '—';
    if (number < 1024) return `${number} B`;
    if (number < 1024 * 1024) return `${(number / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} KB`;
    return `${(number / 1024 / 1024).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} MB`;
  };
  const duration = value => {
    const seconds = Math.max(0, Math.round(Number(value) || 0));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  function notice(text, kind = '') {
    const node = $('#studio-message');
    node.textContent = text;
    node.className = `notice ${kind}`;
    node.hidden = !text;
  }
  function showAuth(session = {}) {
    clearTimeout(state.timer);
    state.authenticated = false;
    $('#boot-status').hidden = true;
    $('#studio-content').hidden = true;
    $('#load-error').hidden = true;
    $('#logout').hidden = true;
    $('#auth-panel').hidden = false;
    $('#login-link').href = `/admin?next=${encodeURIComponent(`/admin/products/${id || ''}`)}`;
    $('#login-link').textContent = !session.enabled && session.setup_allowed ? 'Thiết lập mật khẩu quản trị →' : 'Đăng nhập quản trị →';
    $('#auth-message').textContent = !session.enabled && session.setup_allowed ? 'Tạo mật khẩu quản trị trên máy này để tải ảnh, video và quản lý sản phẩm.' : 'Đăng nhập quản trị để tải ảnh, video và cập nhật thư viện sản phẩm.';
  }
  async function api(path, options = {}) {
    const response = await window.SentaiAdmin.fetch(path, { credentials: 'same-origin', cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showAuth({ enabled: true });
      const error = new Error(body.error || `Không thể hoàn tất yêu cầu (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function poll(delay = 2000) {
    clearTimeout(state.timer);
    if (state.authenticated) state.timer = setTimeout(() => refresh(), delay);
  }
  function uploadAvailable() {
    return state.authenticated && Boolean(state.data?.settings?.processor_ready) && Boolean(state.data?.settings?.phone);
  }
  function unitName(product = state.data?.product) { return product?.unit_label || 'Món hàng'; }
  function ownerText(product = state.data?.product) {
    return product ? `${product.family_name || product.name} — ${unitName(product)} · ${product.collection_name || product.series || 'Chưa xếp BST'}` : '';
  }
  function renderUnit() {
    const product = state.data.product;
    const variants = (state.data.family?.variants || [product]).filter(item => item && /^[a-zA-Z0-9_-]+$/.test(item.id));
    $('#product-title').textContent = product.family_name || product.name;
    $('#product-meta').textContent = product.series || 'Ảnh & video sản phẩm';
    $('#unit-owner-title').textContent = unitName(product);
    $('#unit-owner-summary').textContent = product.condition || 'Chưa mô tả tình trạng';
    $('#unit-count').textContent = `${variants.length} món`;
    $('#unit-select').innerHTML = variants.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(unitName(item))} · ${escapeHTML(item.collection_name || item.series || 'Chưa xếp BST')}${item.availability === 'sold_out' ? ' · Đã bán' : ''}</option>`).join('');
    $('#unit-select').value = product.id;
    $('#unit-select').disabled = variants.length < 2 || state.uploading;
    $('#upload-destination').textContent = `Lưu riêng cho ${unitName(product)}`;
    $('#library-owner').textContent = `${unitName(product)} · ${product.collection_name || product.series || 'Chưa xếp BST'}`;
    const uploadedCover = (state.data.media || []).find(item => (!item.product_id || item.product_id === id) && safeURL(item.kind === 'video' ? item.poster_url : item.url));
    const cover = uploadedCover ? safeURL(uploadedCover.kind === 'video' ? uploadedCover.poster_url : uploadedCover.url) : (product.source_images || []).map(safeURL).find(Boolean);
    $('#unit-cover').hidden = !cover;
    if (cover) {
      const image = $('#unit-cover-image');
      if (image.getAttribute('src') !== cover) image.src = cover;
      image.alt = `${uploadedCover ? 'Ảnh thực tế' : 'Ảnh tham khảo'} · ${unitName(product)}`;
      $('#unit-cover-label').textContent = uploadedCover ? 'Ảnh thực tế' : 'Tham khảo';
    }
    $('#public-product-link').href = typeof product.detail_url === 'string' && /^\/products\/[a-zA-Z0-9_-]+\?variant=[a-zA-Z0-9_-]+$/.test(product.detail_url) ? product.detail_url : `/products/${encodeURIComponent(id)}`;
    document.title = `Ảnh & video · ${product.family_name || product.name} · ${unitName(product)} · Sentai Galaxy`;
    if (!state.unitDirty && !state.unitSaving) {
      $('#unit-label').value = product.unit_label || 'Món hàng';
      $('#unit-collection').value = product.collection_label || '';
      $('#unit-condition').value = product.condition || '';
    }
    $('#unit-source-condition').textContent = `Từ danh mục: ${product.source_condition || 'Chưa mô tả tình trạng.'}`;
  }
  function renderSettings() {
    const settings = state.data.settings || {};
    $('#watermark-phone').textContent = settings.phone || 'Chưa cấu hình số điện thoại';
    $('#upload-limits').textContent = `Ảnh JPG, PNG, WebP ≤ ${bytes(settings.max_image_bytes || 26214400)} · Video MP4, MOV, WebM ≤ ${bytes(settings.max_video_bytes || 314572800)}, tối đa ${Math.round((settings.max_duration_seconds || 600) / 60)} phút.`;
    $('#choose-files').disabled = !uploadAvailable();
    $('#quality').disabled = !uploadAvailable();
    const issue = !settings.phone ? 'Cần cấu hình số điện thoại cửa hàng trước khi chèn watermark.' : !settings.processor_ready ? settings.processor_message || 'Bộ xử lý ảnh/video chưa sẵn sàng trên máy chủ. Vui lòng kiểm tra cấu hình và làm mới.' : '';
    $('#processor-note').textContent = issue;
    $('#processor-note').hidden = !issue;
  }
  function renderJobs() {
    const jobs = Array.isArray(state.data?.jobs) ? state.data.jobs : [];
    const active = jobs.filter(job => activeStatuses.includes(job.status));
    const recent = jobs.filter(job => job.status === 'failed').slice(0, 5);
    const displayed = [...active, ...recent];
    $('#processing-section').hidden = displayed.length === 0;
    $('#processing-title').textContent = active.length ? 'Đang xử lý' : 'Cần thử lại';
    $('#processing-count').textContent = `${displayed.length} file`;
    $('#processing-list').innerHTML = displayed.map(job => {
      const status = Object.hasOwn(jobLabels, job.status) ? job.status : 'queued';
      const activeJob = activeStatuses.includes(status);
      return `<article class="job-item ${status}"><div class="job-head"><strong>${escapeHTML(job.original_name || 'File tải lên')}</strong><span class="job-status ${status}">${activeJob ? '<span class="job-spinner" aria-hidden="true"></span>' : ''}${escapeHTML(jobLabels[status])}</span></div>${status === 'failed' ? `<small>${escapeHTML(job.error || 'Không xử lý được file.')} Chọn lại file để thử lại.</small>` : status === 'uploading' ? '<small>Máy chủ đang nhận file. Giữ trang mở đến khi tải xong.</small>' : status === 'processing' ? '<small>Máy chủ đang xử lý. Bạn có thể rời trang rồi quay lại xem kết quả.</small>' : status === 'queued' ? '<small>File đã được tải lên và đang chờ tới lượt xử lý.</small>' : ''}</article>`;
    }).join('');
  }
  function renderGallery() {
    const media = (Array.isArray(state.data.media) ? state.data.media : []).filter(item => !item.product_id || item.product_id === id);
    const sources = (state.data.product?.source_images || state.data.product?.images || []).filter(url => typeof url === 'string' && url.startsWith('/images/products/') && safeURL(url));
    const owner = ownerText();
    const key = JSON.stringify({ media, sources, owner });
    if (key === state.galleryKey) return;
    state.galleryKey = key;
    $('#media-count').textContent = media.length;
    $('#media-empty').hidden = media.length > 0;
    $('#media-grid').innerHTML = media.map(item => {
      const url = safeURL(item.url);
      const poster = safeURL(item.poster_url);
      const video = item.kind === 'video';
      const saving = Number(item.original_bytes) > 0 ? Math.round((1 - Number(item.output_bytes) / Number(item.original_bytes)) * 100) : null;
      const savingText = saving == null ? '' : saving >= 0 ? ` · giảm ${saving}%` : ' · ưu tiên chất lượng';
      const preview = !url ? '<div class="media-thumb">Chưa có bản xem trước</div>' : video ? `<div class="media-thumb"><span class="media-kind">VIDEO · ${duration(item.duration)}</span><video controls playsinline preload="metadata"${poster ? ` poster="${escapeHTML(poster)}"` : ''} src="${escapeHTML(url)}" aria-label="${escapeHTML(item.original_name || 'Video sản phẩm')}"></video></div>` : `<button class="media-thumb" data-preview="${escapeHTML(item.id)}" aria-label="Xem ảnh ${escapeHTML(item.original_name)}"><span class="media-kind">ẢNH</span><img src="${escapeHTML(url)}" alt="${escapeHTML(item.original_name || 'Ảnh sản phẩm')}" loading="lazy"></button>`;
      return `<article class="media-card">${preview}<div class="media-info"><h3 title="${escapeHTML(item.original_name || '')}">${escapeHTML(item.original_name || (video ? 'Video sản phẩm' : 'Ảnh sản phẩm'))}</h3><div class="media-actions"><button class="row-action" data-preview="${escapeHTML(item.id)}" ${url ? '' : 'disabled'}>Xem ↗</button><button class="delete-button" data-delete="${escapeHTML(item.id)}" aria-label="Gỡ ${escapeHTML(item.original_name || 'file này')} khỏi ${escapeHTML(unitName())}">Gỡ</button></div><details class="file-details"><summary>Thông tin file</summary><p class="media-unit-owner">${escapeHTML(owner)}</p><dl class="media-specs"><dt>Bản gốc</dt><dd>${bytes(item.original_bytes)}</dd><dt>Sau xử lý</dt><dd>${bytes(item.output_bytes)}${escapeHTML(savingText)}</dd><dt>Kích thước</dt><dd>${escapeHTML(item.width)} × ${escapeHTML(item.height)} px</dd><dt>Đóng dấu</dt><dd>${escapeHTML(item.watermark || state.data.settings?.phone || '—')}</dd><dt>Chế độ</dt><dd>${item.quality === 'original' ? 'Độ phân giải gốc' : 'Ưu tiên giữ nét'}</dd></dl></details></div></article>`;
    }).join('');
    $('#source-section').hidden = sources.length === 0;
    $('#source-grid').innerHTML = sources.map((url, index) => `<button class="source-item" data-source="${escapeHTML(url)}" aria-label="Xem ảnh danh mục ${index + 1}"><img src="${escapeHTML(url)}" alt="Ảnh danh mục ${index + 1}" loading="lazy"></button>`).join('');
  }
  async function refresh() {
    if (!state.authenticated || state.loading || !endpoint) return;
    clearTimeout(state.timer);
    state.loading = true;
    const revision = state.revision;
    $('#refresh-media').disabled = true;
    try {
      const data = await api(endpoint);
      if (!data.product) throw new Error('Máy chủ chưa trả về sản phẩm.');
      if (revision !== state.revision) return;
      state.data = data;
      $('#boot-status').hidden = true;
      $('#load-error').hidden = true;
      $('#auth-panel').hidden = true;
      $('#studio-content').hidden = false;
      $('#logout').hidden = false;
      renderUnit(); renderSettings(); renderJobs(); renderGallery();
      if (!state.uploading && $('#studio-message').textContent === 'Đã tải file lên. Máy chủ đang tự tối ưu và chèn watermark.') {
        const accepted = new Set(state.uploads.filter(item => item.status === 'accepted').map(item => item.job));
        const batchJobs = (data.jobs || []).filter(job => accepted.has(job.id));
        if (batchJobs.length && batchJobs.every(job => !activeStatuses.includes(job.status))) {
          const failed = batchJobs.filter(job => job.status === 'failed');
          notice(failed.length ? `${failed.length} file chưa xử lý được. Xem lỗi trong hàng đợi và chọn lại file để thử lại.` : 'Đã tối ưu và chèn watermark. Ảnh, video đã sẵn sàng trên trang sản phẩm.', failed.length ? 'error' : 'success');
        }
      }
      if ((data.jobs || []).some(job => activeStatuses.includes(job.status)) || state.uploading) poll();
    } catch (error) {
      if (error.status === 401) return;
      if (state.data) {
        notice(`Chưa cập nhật được tiến trình. ${error.message} Chọn “Làm mới” để thử lại.`, 'error');
        if ((state.data.jobs || []).some(job => activeStatuses.includes(job.status)) || state.uploading) poll(5000);
      } else {
        $('#boot-status').hidden = true;
        $('#load-error').hidden = false;
        $('#load-error-message').textContent = error.message;
      }
    } finally {
      state.loading = false;
      $('#refresh-media').disabled = false;
      if (revision !== state.revision && state.authenticated) poll(300);
    }
  }

  function renderUploads() {
    const items = state.uploads.filter(item => item.status !== 'accepted');
    $('#upload-queue-wrap').hidden = items.length === 0;
    $('#upload-queue').innerHTML = items.map(item => `<article class="upload-item ${item.status}"><div class="upload-item-head"><strong>${escapeHTML(item.file.name)}</strong><span class="upload-status">${item.status === 'sending' ? item.percent === 100 ? 'Đang xác nhận tải lên…' : `Đang tải · ${item.percent}%` : item.status === 'failed' ? 'Chưa tải được' : 'Chờ tải lên'}</span></div><small>${bytes(item.file.size)} · ${item.quality === 'original' ? 'Độ phân giải gốc' : 'Ưu tiên giữ nét'}</small>${item.status === 'sending' ? `<progress value="${item.percent}" max="100" aria-label="Tiến trình tải ${escapeHTML(item.file.name)}">${item.percent}%</progress>` : ''}${item.error ? `<small>${escapeHTML(item.error)}</small>` : ''}${item.status === 'failed' ? `<button class="row-action" data-retry-upload="${escapeHTML(item.id)}">Thử tải lại</button>` : ''}</article>`).join('');
  }
  async function sendFile(item) {
    const csrf = await window.SentaiAdmin.csrfToken();
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      state.xhr = xhr;
      xhr.open('POST', `${endpoint}/media?kind=${item.kind}&quality=${item.quality}`);
      xhr.withCredentials = true;
      xhr.timeout = 10 * 60 * 1000;
      xhr.setRequestHeader('Content-Type', item.file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
      xhr.setRequestHeader('X-Upload-Id', item.id);
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.upload.addEventListener('progress', event => {
        if (event.lengthComputable) {
          const percent = Math.min(100, Math.round(event.loaded / event.total * 100));
          if (percent !== item.percent) { item.percent = percent; renderUploads(); }
        }
      });
      xhr.addEventListener('load', () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText); } catch { /* Server response is validated below. */ }
        if (xhr.status >= 200 && xhr.status < 300 && data.job) resolve(data.job);
        else {
          if (xhr.status === 401) showAuth({ enabled: true });
          reject(new Error(data.error || `Không tải được file (${xhr.status}).`));
        }
      });
      xhr.addEventListener('error', () => reject(new Error('Mất kết nối khi tải. Bạn có thể thử lại cùng file.')));
      xhr.addEventListener('timeout', () => reject(new Error('Thời gian tải quá lâu. Kiểm tra kết nối rồi thử lại.')));
      xhr.addEventListener('abort', () => reject(new Error('Quá trình tải đã dừng.')));
      xhr.send(item.file);
    });
  }
  async function processUploads() {
    if (state.uploading || !state.authenticated) return;
    state.uploading = true;
    $('#unit-select').disabled = true;
    for (const item of state.uploads) {
      if (item.status !== 'waiting' || !state.authenticated) continue;
      item.status = 'sending'; item.percent = 0; item.error = '';
      renderUploads();
      try {
        const job = await sendFile(item);
        if (job.status === 'failed') {
          item.id = crypto.randomUUID();
          throw new Error(job.error || 'Lần xử lý trước đã thất bại. Bạn có thể thử tải lại file.');
        }
        item.status = 'accepted'; item.job = job.id;
        if (state.data && !(state.data.jobs || []).some(existing => existing.id === job.id)) state.data.jobs = [job, ...(state.data.jobs || [])];
        renderUploads(); renderJobs();
        notice('Đã tải file lên. Máy chủ đang tự tối ưu và chèn watermark.', 'success');
        await refresh(); poll();
      } catch (error) {
        item.status = 'failed'; item.error = error.message; renderUploads();
      } finally { state.xhr = null; }
    }
    state.uploading = false;
    await refresh();
  }
  function queueFiles(fileList) {
    if (!uploadAvailable()) return notice('Chưa thể tải file. Kiểm tra thông tin bộ xử lý phía trên.', 'error');
    const files = [...fileList];
    if (files.length > 20) return notice('Mỗi lần chọn tối đa 20 file. Bạn có thể chia thành nhiều lượt.', 'error');
    const errors = [];
    for (const file of files) {
      const kind = fileKinds[file.name.split('.').pop().toLowerCase()];
      const limit = kind === 'video' ? state.data.settings.max_video_bytes || 314572800 : state.data.settings.max_image_bytes || 26214400;
      if (!kind) { errors.push(`${file.name}: chỉ nhận JPG, PNG, WebP, MP4, MOV, WebM.`); continue; }
      if (!file.size || file.size > limit) { errors.push(`${file.name}: file trống hoặc lớn hơn ${bytes(limit)}.`); continue; }
      state.uploads.push({ id: crypto.randomUUID(), file, kind, quality: $('#quality').value === 'original' ? 'original' : 'high', status: 'waiting', percent: 0, error: '' });
    }
    if (errors.length) notice(errors.join(' '), 'error');
    else notice('');
    renderUploads(); processUploads();
  }

  $('#unit-select').addEventListener('change', event => {
    const target = event.target.value;
    if (!target || target === id) return;
    if (state.uploading) { event.target.value = id; notice('Chờ các file tải xong trước khi đổi sang món khác.', 'error'); return; }
    if (state.unitDirty && !confirm('Thông tin món đang sửa chưa lưu. Rời trang để mở món khác?')) { event.target.value = id; return; }
    state.unitDirty = false;
    if ((state.data.family?.variants || []).some(item => item.id === target)) location.assign(`/admin/products/${encodeURIComponent(target)}`);
  });
  $('#unit-form').addEventListener('input', () => { state.unitDirty = true; });
  $('#unit-reset-condition').addEventListener('click', () => {
    $('#unit-condition').value = state.data?.product?.source_condition || '';
    state.unitDirty = true;
    $('#unit-form-error').textContent = 'Đã điền tình trạng gốc. Bấm Lưu thay đổi để áp dụng.';
  });
  $('#unit-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.unitSaving || !state.data?.product) return;
    const button = event.submitter;
    button.disabled = true; state.unitSaving = true; state.revision++;
    $('#unit-form-error').textContent = '';
    const condition = $('#unit-condition').value.trim();
    try {
      const data = await api(endpoint, { method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        unit_label:$('#unit-label').value.trim(), collection_label:$('#unit-collection').value.trim(),
        condition_note:condition === (state.data.product.source_condition || '') ? null : condition
      }) });
      state.data.product = data.product;
      if (state.data.family?.variants) state.data.family.variants = state.data.family.variants.map(item => item.id === id ? data.product : item);
      state.unitDirty = false;
      notice(`Đã lưu ${unitName(data.product)}.`, 'success');
    } catch (error) { $('#unit-form-error').textContent = error.message; }
    finally { state.unitSaving = false; state.revision++; button.disabled = false; renderUnit(); renderGallery(); await refresh(); }
  });

  $('#choose-files').addEventListener('click', () => $('#media-files').click());
  $('#media-files').addEventListener('change', event => { queueFiles(event.target.files); event.target.value = ''; });
  $('#quality').addEventListener('change', () => {
    $('#quality-help').textContent = $('#quality').value === 'original' ? 'Giữ kích thước điểm ảnh của bản gốc trong giới hạn xử lý. Vẫn nén chất lượng cao và chèn watermark; dung lượng có thể tăng.' : 'Ảnh tối đa 2560 px, video tối đa 1920 px theo cạnh dài. Giữ tỷ lệ và không phóng lớn ảnh/video nhỏ.';
  });
  for (const name of ['dragenter', 'dragover']) $('#dropzone').addEventListener(name, event => { event.preventDefault(); if (uploadAvailable()) $('#dropzone').classList.add('dragging'); });
  $('#dropzone').addEventListener('dragleave', event => { if (!$('#dropzone').contains(event.relatedTarget)) $('#dropzone').classList.remove('dragging'); });
  $('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragging'); queueFiles(event.dataTransfer.files); });
  $('#upload-queue').addEventListener('click', event => {
    const button = event.target.closest('[data-retry-upload]');
    const item = button && state.uploads.find(upload => upload.id === button.dataset.retryUpload);
    if (item && item.status === 'failed') { item.status = 'waiting'; item.error = ''; renderUploads(); processUploads(); }
  });
  function preview(item) {
    const url = safeURL(item.url);
    if (!url) return;
    $('#preview-title').textContent = item.original_name || 'Ảnh sản phẩm';
    const poster = safeURL(item.poster_url);
    $('#preview-content').innerHTML = item.kind === 'video' ? `<video controls playsinline preload="metadata" src="${escapeHTML(url)}"${poster ? ` poster="${escapeHTML(poster)}"` : ''}></video>` : `<img src="${escapeHTML(url)}" alt="${escapeHTML(item.original_name || 'Ảnh sản phẩm')}">`;
    $('#preview-dialog').showModal();
  }
  $('#close-preview').addEventListener('click', () => $('#preview-dialog').close());
  $('#preview-dialog').addEventListener('close', () => $('#preview-content').replaceChildren());
  $('#media-grid').addEventListener('click', async event => {
    const viewButton = event.target.closest('[data-preview]');
    if (viewButton) { const item = state.data.media.find(media => media.id === viewButton.dataset.preview); if (item) preview(item); return; }
    const button = event.target.closest('[data-delete]');
    if (!button) return;
    const item = state.data.media.find(media => media.id === button.dataset.delete);
    if (!item || !confirm(`Gỡ “${item.original_name || 'file này'}” khỏi sản phẩm? Bản gốc vẫn được giữ riêng trên máy chủ.`)) return;
    button.disabled = true;
    try {
      await api(`/api/admin/media/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      notice('Đã gỡ file khỏi trang sản phẩm.', 'success');
      await refresh();
    } catch (error) { notice(error.message, 'error'); button.disabled = false; }
  });
  $('#source-grid').addEventListener('click', event => { const button = event.target.closest('[data-source]'); if (button) preview({ kind: 'image', url: button.dataset.source, original_name: 'Ảnh từ danh mục' }); });
  $('#refresh-media').addEventListener('click', () => { notice(''); refresh(); });
  $('#retry-load').addEventListener('click', () => boot());
  $('#logout').addEventListener('click', async () => {
    if (state.uploading && !confirm('Một số file đang tải. Dừng tải và đăng xuất?')) return;
    state.authenticated = false;
    clearTimeout(state.timer);
    if (state.xhr) state.xhr.abort();
    try { await api('/api/admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); location.assign('/admin'); }
    catch (error) { state.authenticated = true; notice(error.message, 'error'); }
  });
  window.addEventListener('beforeunload', event => { if (state.uploading || state.unitDirty || state.unitSaving) { event.preventDefault(); event.returnValue = ''; } });
  async function boot() {
    if (!id) {
      $('#boot-status').hidden = true; $('#load-error').hidden = false;
      $('#load-error-message').textContent = 'Đường dẫn sản phẩm không hợp lệ. Vui lòng mở từ danh mục quản trị.';
      return;
    }
    try {
      const session = await api('/api/admin/session');
      if (!session.authenticated) return showAuth(session);
      state.authenticated = true;
      await refresh();
    } catch (error) {
      $('#boot-status').hidden = true; $('#load-error').hidden = false;
      $('#load-error-message').textContent = error.message;
    }
  }
  boot();
})();
