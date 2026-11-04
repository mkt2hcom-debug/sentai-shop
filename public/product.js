'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
  const money = value => new Intl.NumberFormat('vi-VN', {style:'currency',currency:'VND',maximumFractionDigits:0}).format(value);
  const uploadId = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const uploadedImage = new RegExp(`^/media/${uploadId}/(?:image|poster)\\.webp$`, 'i');
  const uploadedVideo = new RegExp(`^/media/${uploadId}/video\\.mp4$`, 'i');
  const state = {product:null, family:null, shop:{}, gallery:[], sources:[], videos:[], actualPhotos:false, selected:0, timer:null};
  const photoDialog = $('#photo-dialog');
  let photoOpener = null;
  let loadSequence = 0;

  function safeImage(value) {
    return typeof value === 'string' && (/^\/images\/products\/[a-zA-Z0-9_.-]+\.(?:jpe?g|png|webp|gif)$/i.test(value) || uploadedImage.test(value)) ? value : '';
  }
  function safeVideo(value) { return typeof value === 'string' && uploadedVideo.test(value) ? value : ''; }
  function hasPrice(product) { return Number.isSafeInteger(product.price_vnd) && product.price_vnd > 0; }
  function canOrder(product) { return hasPrice(product) && product.availability !== 'sold_out'; }
  const unitLabel = product => product.unit_label || 'Món 01';
  const collectionName = product => product.collection_name || product.collection_label || product.series || 'Chưa xếp bộ sưu tập';
  const unitTitle = product => `${state.family?.name || product.family_name || product.name} · ${unitLabel(product)}`;
  function unitURL(product, {keepView = true} = {}) {
    const familyId = state.family?.id || product.family_id || product.id;
    const url = new URL(`/products/${encodeURIComponent(familyId)}`, location.origin);
    url.searchParams.set('variant', product.id);
    if (keepView && new URLSearchParams(location.search).get('view') === 'video') url.searchParams.set('view','video');
    if (keepView && ['#product-gallery','#product-videos'].includes(location.hash)) url.hash = location.hash;
    return url;
  }
  function readCart() {
    try {
      const raw = JSON.parse(localStorage.getItem('sentai-cart-v1') || '[]');
      if (!Array.isArray(raw)) return [];
      const cart = new Map();
      for (const entry of raw) {
        if (!entry || typeof entry.product_id !== 'string' || !Number.isInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 20) continue;
        cart.set(entry.product_id, 1);
      }
      return [...cart].map(([product_id, quantity]) => ({product_id,quantity}));
    } catch { return []; }
  }
  function updateCartCount() {
    const count = readCart().reduce((sum, item) => sum + item.quantity, 0);
    $('#detail-cart-count').textContent = count;
    $('#detail-cart-link').setAttribute('aria-label', `Mở giỏ hàng, ${count} sản phẩm`);
  }
  function notify(text) {
    const toast = $('#detail-toast');
    clearTimeout(state.timer);
    toast.textContent = text;
    toast.classList.add('visible');
    state.timer = setTimeout(() => toast.classList.remove('visible'), 3500);
  }
  function purchaseMessage(text, isError = false) {
    const target = $('#purchase-message');
    target.textContent = text;
    target.classList.toggle('error', isError);
    target.hidden = !text;
  }
  function contactLink() {
    const url = state.shop.zalo_url;
    if (typeof url === 'string' && /^https:\/\/zalo\.me\/\d{9,15}$/.test(url)) return {href:url,text:'Hỏi giá qua Zalo',external:true};
    const phone = state.shop.contact_phone;
    if (typeof phone === 'string' && /^[+\d\s().-]{9,25}$/.test(phone) && /^\d{9,15}$/.test(phone.replace(/\D/g, ''))) return {href:`tel:${phone.replace(/[^+\d]/g,'')}`,text:`Gọi báo giá: ${phone}`,external:false};
    return null;
  }
  function renderContact() {
    const contact = contactLink();
    const target = $('#detail-shop-contact');
    target.hidden = !contact;
    if (!contact) return;
    const phone = state.shop.contact_phone;
    const phoneMarkup = typeof phone === 'string' && /^[+\d\s().-]{9,25}$/.test(phone)
      ? `<a href="tel:${escapeHTML(phone.replace(/[^+\d]/g,''))}">Điện thoại: ${escapeHTML(phone)}</a>` : '';
    target.innerHTML = `${phoneMarkup}${phoneMarkup && contact.external ? '<br>' : ''}${contact.external || !phoneMarkup ? `<a href="${escapeHTML(contact.href)}"${contact.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(contact.text)} ↗</a>` : ''}`;
  }

  function buildGallery(product) {
    const result = [];
    const seen = new Set();
    const add = entry => { if (entry.url && !seen.has(entry.url)) { seen.add(entry.url); result.push(entry); } };
    for (const image of Array.isArray(product.uploaded_images) ? product.uploaded_images : []) if (uploadedImage.test(image)) add({kind:'image',url:safeImage(image)});
    for (const item of Array.isArray(product.media) ? product.media : []) {
      if (!item || typeof item !== 'object' || (item.product_id && item.product_id !== product.id)) continue;
      if (item.kind === 'image') add({kind:'image',url:safeImage(item.url),poster:safeImage(item.poster_url)});
    }
    return result;
  }
  function buildSources(product) {
    const images = Array.isArray(product.source_images) ? product.source_images : (product.images || []).filter(image => typeof image === 'string' && image.startsWith('/images/products/'));
    return [...new Set(images)].map(image => ({kind:'image',url:safeImage(image),source:true})).filter(entry => entry.url);
  }
  function buildVideos(product) {
    const result = [];
    const seen = new Set();
    for (const item of Array.isArray(product.media) ? product.media : []) {
      if (!item || item.kind !== 'video' || (item.product_id && item.product_id !== product.id)) continue;
      const url = safeVideo(item.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      result.push({url, poster:safeImage(item.poster_url), duration:Number.isFinite(item.duration) ? item.duration : null});
    }
    return result;
  }
  function durationText(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`;
  }
  function renderThumbnails() {
    $('#media-count').textContent = `${state.gallery.length} ảnh`;
    $('#photos-jump').textContent = `Ảnh (${state.gallery.length})`;
    $('#media-thumbnails').hidden = state.gallery.length < 2;
    $('.gallery-navigation').hidden = state.gallery.length < 2;
    $('#media-thumbnails').innerHTML = state.gallery.map((entry, index) => {
      return `<button class="media-thumbnail" type="button" data-media-index="${index}" aria-label="Ảnh ${index + 1} — ${escapeHTML(unitTitle(state.product))}" aria-pressed="false" title="Ảnh ${index + 1}"><img src="${escapeHTML(entry.poster || entry.url)}" alt="" loading="lazy"></button>`;
    }).join('');
    $('#media-prev').disabled = state.gallery.length < 2;
    $('#media-next').disabled = state.gallery.length < 2;
  }
  function showMedia(index, focusThumb = false) {
    const stage = $('#media-stage');
    if (!state.gallery.length) {
      stage.innerHTML = `<div class="media-unavailable"><span aria-hidden="true">◇</span><p>${escapeHTML(unitLabel(state.product))} chưa có ảnh.</p></div>`;
      $('#media-caption').textContent = 'Chưa có ảnh';
      $('#gallery-help').hidden = true;
      return;
    }
    state.selected = (index + state.gallery.length) % state.gallery.length;
    const entry = state.gallery[state.selected];
    stage.innerHTML = `<button class="full-photo" type="button" aria-label="Phóng to ảnh ${escapeHTML(unitTitle(state.product))}"><img src="${escapeHTML(entry.url)}" alt="${escapeHTML(unitTitle(state.product))} — ${entry.source ? 'ảnh từ danh mục' : 'ảnh tải lên của món'} ${state.selected + 1}" fetchpriority="high"><span class="zoom-hint" aria-hidden="true">Phóng to ↗</span></button>`;
    stage.querySelector('.full-photo').addEventListener('click', openPhoto);
    $('#media-caption').textContent = `${state.selected + 1} / ${state.gallery.length}`;
    $('#gallery-help').hidden = false;
    $('#gallery-help').textContent = 'Chạm ảnh để phóng to. Vuốt ngang để đổi ảnh.';
    for (const thumb of document.querySelectorAll('[data-media-index]')) {
      const selected = Number(thumb.dataset.mediaIndex) === state.selected;
      thumb.setAttribute('aria-pressed', String(selected));
      if (selected && focusThumb) thumb.focus({preventScroll:true});
    }
  }
  function renderVideos() {
    const count = state.videos.length;
    $('#videos-jump').textContent = `Video (${count}) ↓`;
    $('#videos-jump').hidden = count === 0;
    $('#product-videos').hidden = count === 0;
    $('#videos-title').textContent = `Video · ${unitLabel(state.product)}`;
    $('#video-count').textContent = `${count} video`;
    const grid = $('#product-video-grid');
    grid.hidden = count === 0;
    grid.innerHTML = state.videos.map((entry, index) => {
      const duration = durationText(entry.duration);
      return `<article class="product-video-card"><video controls playsinline preload="none"${entry.poster ? ` poster="${escapeHTML(entry.poster)}"` : ''} aria-label="Video ${index + 1} — ${escapeHTML(unitTitle(state.product))}"><source src="${escapeHTML(entry.url)}" type="video/mp4">Trình duyệt chưa hỗ trợ video. <a href="${escapeHTML(entry.url)}">Mở video</a>.</video><div class="video-card-caption"><h3>${escapeHTML(unitLabel(state.product))} · Video ${index + 1}</h3>${duration ? `<span>${duration}</span>` : ''}</div><p class="video-load-error" role="status" hidden>Chưa tải được video. Vui lòng tải lại trang và thử phát lại.</p></article>`;
    }).join('');
    for (const video of grid.querySelectorAll('video')) {
      const showVideoError = () => { video.closest('.product-video-card').querySelector('.video-load-error').hidden = false; };
      video.addEventListener('error', showVideoError, {once:true});
      video.querySelector('source').addEventListener('error', showVideoError, {once:true});
      video.addEventListener('play', () => {
        for (const other of grid.querySelectorAll('video')) if (other !== video) other.pause();
      });
    }
  }
  function openPhoto() {
    const entry = state.gallery[state.selected];
    if (!entry || entry.kind !== 'image') return;
    photoOpener = document.activeElement;
    $('#photo-dialog-title').textContent = `${unitTitle(state.product)}${entry.source ? ' · Ảnh danh mục' : ''}`;
    $('#zoom-photo').innerHTML = `<img src="${escapeHTML(entry.url)}" alt="${escapeHTML(unitTitle(state.product))} — ảnh phóng to">`;
    photoDialog.showModal();
    document.body.classList.add('modal-open');
  }

  function renderPurchase(product) {
    const actions = $('#purchase-actions');
    const mobileAction = $('#mobile-purchase-action');
    $('#mobile-purchase-bar').hidden = false;
    $('#mobile-unit-label').textContent = unitLabel(product);
    $('#mobile-product-price').textContent = hasPrice(product) ? money(product.price_vnd) : 'Liên hệ giá';
    if (canOrder(product)) {
      const inCart = readCart().some(item => item.product_id === product.id);
      actions.innerHTML = `<div class="purchase-buttons"><button id="add-product-cart" data-purchase="add" class="button primary" type="button" ${inCart ? 'disabled' : ''}>${inCart ? 'Đã trong giỏ ✓' : 'Thêm vào giỏ +'}</button><button id="buy-product" data-purchase="buy" class="button outline" type="button">${inCart ? 'Mở giỏ hàng' : 'Đặt mua'} ↗</button></div>`;
      mobileAction.innerHTML = `<button id="mobile-purchase-primary" data-purchase="${inCart ? 'buy' : 'add'}" class="button primary" type="button">${inCart ? 'Mở giỏ hàng ↗' : 'Thêm vào giỏ +'}</button>`;
      return;
    }
    if (product.availability === 'sold_out') {
      actions.innerHTML = '<button class="button outline" type="button" disabled>Đã bán</button>';
      mobileAction.innerHTML = '<button class="button outline" type="button" disabled>Đã bán</button>';
      return;
    }
    const contact = contactLink();
    const contactMarkup = contact ? `<a class="button primary" href="${escapeHTML(contact.href)}"${contact.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${contact.external ? 'Hỏi giá Zalo' : 'Gọi báo giá'} <span aria-hidden="true">↗</span></a>` : '<button class="button outline" type="button" disabled>Chờ cập nhật giá</button>';
    actions.innerHTML = contactMarkup;
    mobileAction.innerHTML = contactMarkup;
  }
  function addToCart(goToCart) {
    if (!state.product || !canOrder(state.product)) return;
    const cart = readCart();
    const existing = cart.find(item => item.product_id === state.product.id);
    if (existing) {
      if (goToCart) location.assign('/?cart=1');
      else purchaseMessage(`${unitLabel(state.product)} đã có trong giỏ. Chọn món khác nếu bạn muốn mua thêm.`,true);
      return;
    }
    cart.push({product_id:state.product.id,quantity:1});
    try {
      localStorage.setItem('sentai-cart-v1', JSON.stringify(cart));
      localStorage.removeItem('sentai-order-pending-v1');
    } catch { purchaseMessage('Trình duyệt chưa cho phép lưu giỏ hàng. Hãy cho phép lưu dữ liệu trang web hoặc đặt mua từ trang cửa hàng.',true); return; }
    updateCartCount();
    renderPurchase(state.product);
    purchaseMessage(`Đã thêm ${unitLabel(state.product)} vào giỏ.`);
    if (goToCart) location.assign('/?cart=1');
    else notify('Đã thêm vào giỏ hàng.');
  }

  function renderOptions() {
    const variants = state.family.variants;
    const collections = [...new Set(variants.map(collectionName))];
    const currentCollection = collectionName(state.product);
    const select = $('#unit-collection');
    select.innerHTML = collections.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(name)}</option>`).join('');
    select.value = currentCollection;
    select.disabled = collections.length < 2;
    select.closest('.unit-collection-field').hidden = collections.length < 2;
    $('#unit-options').innerHTML = variants.filter(product => collectionName(product) === currentCollection).map(product => {
      const chosen = product.id === state.product.id;
      const sold = product.availability === 'sold_out';
      const actual = buildGallery(product)[0];
      const thumbnail = actual || buildSources(product)[0];
      const status = sold ? 'Đã bán' : hasPrice(product) ? money(product.price_vnd) : 'Hỏi giá';
      return `<button type="button" class="unit-option${sold ? ' sold' : ''}" data-unit="${escapeHTML(product.id)}" aria-pressed="${chosen}" aria-label="Chọn ${escapeHTML(unitLabel(product))}, ${escapeHTML(status)}, ${escapeHTML(product.condition || 'chưa có mô tả tình trạng')}"><span class="unit-option-photo">${thumbnail ? `<img src="${escapeHTML(thumbnail.url)}" alt="" loading="lazy">${actual ? '' : '<span class="unit-image-source">Danh mục</span>'}` : '<span class="thumbnail-fallback" aria-hidden="true">◇</span>'}<span class="unit-selected-check" aria-hidden="true">✓</span></span><span class="unit-option-heading"><strong>${escapeHTML(unitLabel(product))}</strong></span><span class="unit-option-price">${escapeHTML(status)}</span></button>`;
    }).join('');
  }
  function selectUnit(id, {historyMode = 'push', focus = false} = {}) {
    const product = state.family?.variants.find(item => item.id === id);
    if (!product) return;
    loadSequence++;
    if (historyMode !== 'none') history[historyMode === 'replace' ? 'replaceState' : 'pushState']({unit:id},'',unitURL(product));
    renderProduct(product,state.shop);
    if (focus) [...document.querySelectorAll('[data-unit]')].find(button => button.dataset.unit === id)?.focus({preventScroll:true});
  }
  function renderProduct(product, shop) {
    for (const video of document.querySelectorAll('#product-video-grid video')) video.pause();
    if (photoDialog.open) photoDialog.close();
    $('#zoom-photo').replaceChildren();
    state.product = product;
    state.shop = shop || {};
    const actual = buildGallery(product);
    state.sources = buildSources(product);
    state.actualPhotos = actual.length > 0;
    state.gallery = actual.length ? actual : state.sources;
    state.videos = buildVideos(product);
    const modelName = state.family?.name || product.family_name || product.name;
    document.title = `${modelName} · ${unitLabel(product)} · Sentai Galaxy`;
    document.querySelector('meta[name="description"]').setAttribute('content', `${unitTitle(product)} — xem ảnh, video, tình trạng và phụ kiện của đúng món tại Sentai Galaxy.`);
    $('#breadcrumb-name').textContent = modelName;
    $('#product-title').textContent = modelName;
    $('#model-summary').textContent = `${state.family.variants.length} món`;
    const series = typeof product.series === 'string' ? product.series.trim() : '';
    $('#product-series').textContent = series || 'Sentai';
    $('#product-series').href = series ? `/?series=${encodeURIComponent(series)}#catalog` : '/#catalog';
    $('#selected-unit-title').textContent = unitLabel(product);
    $('#selected-unit-collection').textContent = `BST / lô: ${collectionName(product)}`;
    $('#product-sku').textContent = `Mã món: ${product.id}${product.sku ? ` · SKU: ${product.sku}` : ''}`;
    $('#product-price').textContent = hasPrice(product) ? money(product.price_vnd) : 'Liên hệ giá';
    const availability = $('#product-availability');
    availability.textContent = product.availability === 'sold_out' ? 'Đã bán' : product.availability === 'available' ? 'Còn hàng' : 'Cần xác nhận hàng';
    availability.className = `availability-pill ${product.availability === 'sold_out' ? 'sold' : product.availability === 'available' ? 'available' : 'unknown'}`;
    $('#facts-title').textContent = `Tình trạng · ${unitLabel(product)}`;
    $('#product-condition').textContent = product.condition || 'Chưa cập nhật tình trạng';
    $('#product-description').textContent = product.description || '';
    $('#product-description-block').hidden = !product.description;
    $('#manage-media-link').href = `/admin/products/${encodeURIComponent(product.id)}`;
    $('#manage-media-link').textContent = 'Thêm ảnh / video ↗';
    $('#photos-title').textContent = `Ảnh của ${unitLabel(product)}`;
    $('#gallery-owner').textContent = `${unitLabel(product)} · ${actual.length ? 'Ảnh thực tế' : state.sources.length ? 'Ảnh danh mục' : 'Chưa có ảnh'}`;
    $('#photo-provenance').textContent = actual.length ? `Ảnh tải lên riêng cho ${unitLabel(product)}.` : `${unitLabel(product)} chưa có ảnh thực tế tải lên.${state.sources.length ? ' Đang hiển thị ảnh từ danh mục; cần đối chiếu tình trạng trước khi mua.' : ''}`;
    $('#photo-provenance').classList.toggle('reference-only', !actual.length);
    $('#source-photos').hidden = !actual.length || !state.sources.length;
    $('#source-photos').open = false;
    $('#source-photo-grid').innerHTML = state.sources.map((entry,index) => `<button type="button" class="source-photo" data-source-photo="${index}" aria-label="Phóng to ảnh danh mục ${index+1}"><img src="${escapeHTML(entry.url)}" alt="Ảnh danh mục của ${escapeHTML(modelName)}" loading="lazy"></button>`).join('');
    $('#share-fallback').hidden = true;
    purchaseMessage('');
    renderOptions();
    renderThumbnails();
    showMedia(0);
    renderVideos();
    renderPurchase(product);
    renderContact();
    $('#product-state').hidden = true;
    $('#product-content').hidden = false;
    window.SentaiAnalytics?.view('product', product.id);
  }
  function showError(message, notFound = false) {
    const target = $('#product-state');
    target.hidden = false;
    $('#product-content').hidden = true;
    $('#mobile-purchase-bar').hidden = true;
    target.innerHTML = `<h1>${notFound ? 'Chưa tìm thấy sản phẩm' : 'Chưa mở được sản phẩm'}</h1><p>${escapeHTML(message)}</p><div class="retry-row">${notFound ? '' : '<button type="button" class="button primary" id="retry-product">Thử lại</button>'}<a class="button outline" href="/#catalog">Về bộ sưu tập</a></div>`;
    $('#retry-product')?.addEventListener('click', loadProduct);
  }
  async function loadProduct() {
    window.SentaiAnalytics?.clear();
    const sequence = ++loadSequence;
    let id;
    try { id = decodeURIComponent(location.pathname.match(/^\/products\/([^/]+)\/?$/)?.[1] || ''); } catch { id = ''; }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) { showError('Đường dẫn sản phẩm không hợp lệ. Hãy chọn một sản phẩm từ bộ sưu tập.',true); return; }
    const requestedUnit = new URLSearchParams(location.search).get('variant');
    if (requestedUnit && !/^[a-zA-Z0-9_-]{1,100}$/.test(requestedUnit)) { showError('Lựa chọn món không hợp lệ.',true); return; }
    for (const video of document.querySelectorAll('#product-video-grid video')) video.pause();
    $('#product-content').hidden = true;
    $('#mobile-purchase-bar').hidden = true;
    $('#product-state').hidden = false;
    $('#product-state').innerHTML = '<span class="spinner" aria-hidden="true"></span><p>Đang mở mảnh ghép của bạn…</p>';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(`/api/products/${encodeURIComponent(id)}${requestedUnit ? `?variant=${encodeURIComponent(requestedUnit)}` : ''}`, {signal:controller.signal});
      const data = await response.json().catch(() => ({}));
      if (sequence !== loadSequence) return;
      if (!response.ok) { showError(data.error || 'Sản phẩm không có trong danh mục hoặc chưa thể tải.', response.status === 404); return; }
      if (!data.product || typeof data.product.name !== 'string' || typeof data.product.id !== 'string') throw new Error('Dữ liệu sản phẩm không hợp lệ.');
      const family = data.family || {id:data.product.family_id || data.product.id,name:data.product.family_name || data.product.name,variants:[data.product]};
      if (!family || typeof family.name !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(family.id) || !Array.isArray(family.variants) || !family.variants.length || family.variants.some(unit => !unit || !/^[a-zA-Z0-9_-]{1,100}$/.test(unit.id) || typeof unit.name !== 'string' || (unit.family_id && unit.family_id !== family.id)) || !family.variants.some(unit => unit.id === data.product.id) || (requestedUnit && requestedUnit !== data.product.id)) throw new Error('Dữ liệu lựa chọn không hợp lệ.');
      state.family = family;
      renderProduct(data.product, data.shop);
      history.replaceState({unit:data.product.id},'',unitURL(data.product));
      if (state.videos.length && (new URLSearchParams(location.search).get('view') === 'video' || location.hash === '#product-videos')) requestAnimationFrame(() => {
        $('#product-videos').scrollIntoView({block:'start'});
        $('#videos-title').focus({preventScroll:true});
      });
    } catch {
      if (sequence === loadSequence) showError('Kết nối tới cửa hàng đang gián đoạn. Vui lòng thử tải lại.');
    } finally { clearTimeout(timeout); }
  }

  document.addEventListener('click', event => {
    const action = event.target.closest('[data-purchase]');
    if (action && !action.disabled) addToCart(action.dataset.purchase === 'buy');
  });
  let swipeStart = null;
  let suppressPhotoClickUntil = 0;
  $('#media-stage').addEventListener('touchstart', event => {
    swipeStart = event.touches.length === 1 ? {x:event.touches[0].clientX,y:event.touches[0].clientY} : null;
  }, {passive:true});
  $('#media-stage').addEventListener('touchend', event => {
    if (!swipeStart || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - swipeStart.x;
    const dy = event.changedTouches[0].clientY - swipeStart.y;
    swipeStart = null;
    if (state.gallery.length > 1 && Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      suppressPhotoClickUntil = Date.now() + 350;
      showMedia(state.selected + (dx < 0 ? 1 : -1));
    }
  }, {passive:true});
  $('#media-stage').addEventListener('touchcancel', () => { swipeStart = null; }, {passive:true});
  $('#media-stage').addEventListener('click', event => {
    if (Date.now() < suppressPhotoClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  $('#unit-collection').addEventListener('change', event => {
    const matches = state.family?.variants.filter(unit => collectionName(unit) === event.target.value) || [];
    const product = matches.find(unit => unit.availability !== 'sold_out') || matches[0];
    if (product) selectUnit(product.id);
  });
  $('#unit-options').addEventListener('click', event => {
    const button = event.target.closest('[data-unit]');
    if (button && button.dataset.unit !== state.product?.id) selectUnit(button.dataset.unit,{focus:true});
  });
  $('#unit-options').addEventListener('keydown', event => {
    const button = event.target.closest('[data-unit]');
    if (!button || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...document.querySelectorAll('[data-unit]')];
    const index = buttons.indexOf(button);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    selectUnit(buttons[next].dataset.unit,{focus:true});
  });
  $('#source-photo-grid').addEventListener('click', event => {
    const button = event.target.closest('[data-source-photo]');
    const entry = button && state.sources[Number(button.dataset.sourcePhoto)];
    if (!entry) return;
    photoOpener = button;
    $('#photo-dialog-title').textContent = `${unitTitle(state.product)} · Ảnh từ danh mục`;
    $('#zoom-photo').innerHTML = `<img src="${escapeHTML(entry.url)}" alt="Ảnh danh mục, chưa xác nhận ảnh thực tế của ${escapeHTML(unitLabel(state.product))}">`;
    photoDialog.showModal();
    document.body.classList.add('modal-open');
  });
  $('#media-prev').addEventListener('click', () => showMedia(state.selected - 1));
  $('#media-next').addEventListener('click', () => showMedia(state.selected + 1));
  $('#media-thumbnails').addEventListener('click', event => {
    const button = event.target.closest('[data-media-index]');
    if (button) showMedia(Number(button.dataset.mediaIndex));
  });
  $('#media-thumbnails').addEventListener('keydown', event => {
    if (!event.target.closest('[data-media-index]') || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    showMedia(event.key === 'Home' ? 0 : event.key === 'End' ? state.gallery.length - 1 : state.selected + (event.key === 'ArrowRight' ? 1 : -1), true);
  });
  $('#close-photo').addEventListener('click', () => photoDialog.close());
  photoDialog.addEventListener('click', event => {
    if (event.target !== photoDialog) return;
    const bounds = photoDialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) photoDialog.close();
  });
  photoDialog.addEventListener('close', () => {
    document.body.classList.remove('modal-open');
    if (photoOpener?.isConnected) photoOpener.focus({preventScroll:true});
  });
  $('#share-product').addEventListener('click', async () => {
    if (!state.product) return;
    const url = unitURL(state.product).href;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      notify(`Đã sao chép liên kết chọn đúng ${unitLabel(state.product)}.`);
    } catch {
      $('#share-fallback').hidden = false;
      $('#share-url').value = url;
      $('#share-url').focus();
      $('#share-url').select();
      notify('Chọn và sao chép liên kết bên dưới.');
    }
  });
  document.addEventListener('error', event => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) return;
    if (image.closest('.media-thumbnail')) {
      const fallback = document.createElement('span');
      fallback.className = 'thumbnail-fallback';
      fallback.textContent = '◇';
      image.replaceWith(fallback);
    } else if (image.closest('#media-stage')) {
      $('#media-stage').innerHTML = '<div class="media-unavailable"><span aria-hidden="true">◇</span><p>Chưa tải được ảnh. Hãy chọn ảnh khác hoặc tải lại trang.</p></div>';
    }
  },true);
  window.addEventListener('storage', event => {
    if (event.key === 'sentai-cart-v1') { updateCartCount(); if (state.product) renderPurchase(state.product); }
  });
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('variant');
    if (location.pathname === `/products/${state.family?.id}` && state.family?.variants.some(unit => unit.id === id)) selectUnit(id,{historyMode:'none'});
    else loadProduct();
  });
  updateCartCount();
  loadProduct();
})();
