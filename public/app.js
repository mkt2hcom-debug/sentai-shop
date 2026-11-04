'use strict';

(() => {
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const money = value => new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(value);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const icons = {
    bag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 7h14l1 14H4L5 7Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/></svg>',
    cube: '<svg viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m40 10 25 15v30L40 70 15 55V25l25-15Z"/><path d="m15 25 25 15 25-15M40 40v30M28 17l25 15"/></svg>'
  };
  const storage = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Shopping remains available with in-memory state. */ } },
    remove(key) { try { localStorage.removeItem(key); } catch { /* Storage can be disabled by the browser. */ } }
  };
  const storedCart = storage.get('sentai-cart-v1', []);
  const state = {
    products: [], families: [], series: '', query: '', availability: 'all', sort: 'default', visible: 16,
    cart: Array.isArray(storedCart) ? storedCart.filter(item => item && typeof item.product_id === 'string' && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 20) : [],
    heroId: null, loaded: false, toastTimer: null, submitting: false, pending: storage.get('sentai-order-pending-v1', null), shop: {}
  };
  const productDialog = $('#product-dialog');
  const cartDialog = $('#cart-dialog');
  let checkoutDraft = {};
  let lastFocusedElement = null;

  function imageURL(path) {
    return typeof path === 'string' && (/^\/images\/products\/[a-zA-Z0-9_.-]+$/.test(path) || /^\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:image|poster)\.webp$/i.test(path)) ? path : '';
  }
  function imagesOf(product) { return (Array.isArray(product.images) ? product.images : []).map(imageURL).filter(Boolean); }
  function imageMarkup(product, className = '', lazy = true, index = 0) {
    const url = imagesOf(product)[index];
    return url ? `<img src="${escapeHTML(url)}" alt="${escapeHTML(product.name)}" ${lazy ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async"${className ? ` class="${escapeHTML(className)}"` : ''}>` : `<div class="image-placeholder ${escapeHTML(className)}">${icons.cube}<span>Chưa có hình ảnh</span></div>`;
  }
  function shortSeries(series) { return String(series || 'Bộ sưu tập Sentai').replace(/^[\w\s]+?Sentai\s+/i, ''); }
  function normalize(value) { return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase(); }
  function canOrder(product) { return product && product.availability !== 'sold_out' && Number.isSafeInteger(product.price_vnd) && product.price_vnd > 0; }
  function hasPrice(product) { return Number.isSafeInteger(product.price_vnd) && product.price_vnd > 0; }
  function priceText(product) { return hasPrice(product) ? money(product.price_vnd) : 'Liên hệ báo giá'; }
  function availabilityText(product) { return product.availability === 'sold_out' ? 'Đã bán' : product.availability === 'available' ? 'Có thể đặt mua' : 'Xác nhận tình trạng khi đặt'; }
  function productById(id) { return state.products.find(product => product.id === id); }
  function detailURL(product) {
    const familyId = typeof product.family_id === 'string' && /^[\w-]+$/.test(product.family_id) ? product.family_id : product.id;
    return `/products/${encodeURIComponent(familyId)}?variant=${encodeURIComponent(product.id)}`;
  }
  function unitDescription(product) {
    return [product.unit_label || 'Món hàng', product.collection_name || product.collection_label || product.series].filter(Boolean).join(' · ');
  }
  function normalizeCart(cart) {
    const unique = new Map();
    for (const item of Array.isArray(cart) ? cart : []) {
      if (!item || typeof item.product_id !== 'string' || !Number.isInteger(item.quantity) || item.quantity < 1 || !canOrder(productById(item.product_id))) continue;
      unique.set(item.product_id, {product_id:item.product_id, quantity:1});
    }
    return [...unique.values()];
  }
  function contactLink() {
    if (typeof state.shop.zalo_url === 'string') {
      try {
        const url = new URL(state.shop.zalo_url);
        if (url.protocol === 'https:' && url.hostname === 'zalo.me') return { href: url.href, label: 'Liên hệ báo giá qua Zalo', external: true };
      } catch { /* Invalid contact links are never displayed. */ }
    }
    const phone = state.shop.contact_phone;
    if (typeof phone === 'string' && /^[+\d\s().-]{9,20}$/.test(phone)) return { href: `tel:${phone.replace(/[^+\d]/g, '')}`, label: `Gọi báo giá: ${phone}`, external: false };
    return null;
  }
  function orderAction(product) {
    if (canOrder(product)) return `<button class="button primary" data-add="${escapeHTML(product.id)}">Thêm vào giỏ hàng ${icons.bag}</button><p class="detail-note">Đơn hàng cần được cửa hàng xác nhận. Phí vận chuyển sẽ được thông báo trước khi giao.</p>`;
    if (product.availability === 'sold_out') return '<button class="button outline" disabled>Sản phẩm đã bán</button><p class="detail-note">Sản phẩm này hiện không nhận yêu cầu đặt mua.</p>';
    const contact = contactLink();
    if (contact) return `<a class="button primary" href="${escapeHTML(contact.href)}"${contact.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(contact.label)} <span aria-hidden="true">↗</span></a><p class="detail-note">Liên hệ cửa hàng để xác nhận giá bán và tình trạng sản phẩm này.</p>`;
    return '<button class="button outline" disabled>Giá đang được cập nhật</button><p class="detail-note">Vui lòng quay lại khi cửa hàng bổ sung giá bán cho sản phẩm này.</p>';
  }
  function renderContact() {
    const container = $('#shop-contact');
    const contact = contactLink();
    container.hidden = !contact;
    if (contact) {
      const phone = state.shop.contact_phone;
      const phoneLink = typeof phone === 'string' && /^[+\d\s().-]{9,25}$/.test(phone)
        ? `<a href="tel:${escapeHTML(phone.replace(/[^+\d]/g, ''))}">Điện thoại: ${escapeHTML(phone)}</a>` : '';
      container.innerHTML = `${phoneLink}${phoneLink && contact.external ? '<br>' : ''}${contact.external || !phoneLink ? `<a href="${escapeHTML(contact.href)}"${contact.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHTML(contact.label)} ↗</a>` : ''}`;
    }
  }

  function notify(message) {
    const toast = $('#toast');
    clearTimeout(state.toastTimer);
    toast.textContent = message;
    toast.classList.add('visible');
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3200);
  }
  function saveCart() {
    storage.set('sentai-cart-v1', state.cart);
    state.pending = null;
    storage.remove('sentai-order-pending-v1');
    updateCartCount();
  }
  function updateCartCount() {
    const count = state.cart.reduce((sum, item) => sum + item.quantity, 0);
    $('#cart-count').textContent = count;
    $('#open-cart').setAttribute('aria-label', `Mở giỏ hàng, ${count} sản phẩm`);
  }
  function addToCart(id) {
    const product = productById(id);
    if (!canOrder(product)) return notify('Sản phẩm này chưa thể đặt mua trực tiếp.');
    const item = state.cart.find(entry => entry.product_id === id);
    if (item) return notify('Món này đã có trong giỏ.');
    state.cart.push({ product_id: id, quantity: 1 });
    saveCart();
    notify(`Đã thêm ${product.family_name || product.name} · ${product.unit_label || 'Món hàng'} vào giỏ.`);
  }
  function cartItems() { return state.cart.map(item => ({ ...item, product: productById(item.product_id) })).filter(item => item.product); }
  function subtotal() { return cartItems().reduce((sum, item) => sum + (item.product.price_vnd || 0) * item.quantity, 0); }

  function openDialog(dialog) {
    lastFocusedElement = document.activeElement;
    if (productDialog.open) productDialog.close();
    if (cartDialog.open) cartDialog.close();
    dialog.showModal();
    document.body.classList.add('modal-open');
  }
  function closeDialog(dialog) { dialog.close(); }
  [productDialog, cartDialog].forEach(dialog => {
    dialog.addEventListener('click', event => {
      if (event.target === dialog && !state.submitting) {
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
      }
    });
    dialog.addEventListener('cancel', event => { if (state.submitting) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (!productDialog.open && !cartDialog.open) document.body.classList.remove('modal-open');
      if (lastFocusedElement?.isConnected) lastFocusedElement.focus({ preventScroll: true });
    });
  });

  function renderHero() {
    const hero = state.products.find(product => /five knight/i.test(product.name) && imagesOf(product).length) || state.products.find(product => hasPrice(product) && imagesOf(product).length) || state.products.find(product => imagesOf(product).length);
    $('#product-total').textContent = state.families.length;
    $('#series-total').textContent = new Set(state.products.map(product => product.series).filter(Boolean)).size;
    if (!hero) return;
    state.heroId = hero.id;
    $('#hero-image-wrap').innerHTML = imageMarkup(hero, '', false);
    $('#hero-series').textContent = shortSeries(hero.series);
    $('#hero-name').textContent = hero.family_name || hero.name;
    $('#hero-product').disabled = false;
    $('#hero-product').setAttribute('aria-label', `Xem chi tiết ${hero.name}`);
  }
  function renderChips() {
    const seriesCounts = new Map();
    state.families.forEach(family => {
      for (const series of new Set(family.variants.map(product => product.series).filter(Boolean))) seriesCounts.set(series, (seriesCounts.get(series) || 0) + 1);
    });
    $('#collections').innerHTML = `<button class="chip ${state.series === '' ? 'selected' : ''}" data-series="" aria-pressed="${state.series === ''}">Tất cả mẫu <span class="chip-count">${state.families.length}</span></button>` + [...seriesCounts].map(([series, count]) => `<button class="chip ${state.series === series ? 'selected' : ''}" data-series="${escapeHTML(series)}" aria-pressed="${state.series === series}" title="${escapeHTML(series)}">${escapeHTML(shortSeries(series))}<span class="chip-count">${count}</span></button>`).join('');
  }
  function familyView(family, variants = family.variants) {
    const unsold = variants.filter(product => product.availability !== 'sold_out');
    const priced = unsold.filter(hasPrice);
    const representative = priced[0] || unsold[0] || variants[0];
    return {...family, matchingVariants:variants, representative, liveCount:unsold.length,
      price:priced.length ? Math.min(...priced.map(product => product.price_vnd)) : null,
      hasUnpriced:unsold.some(product => !hasPrice(product))};
  }
  function filteredProducts() {
    const query = normalize(state.query).trim();
    const results = state.families.flatMap(family => {
      const variants = family.variants.filter(product => {
        if (state.series && product.series !== state.series) return false;
        if (state.availability === 'priced' && !hasPrice(product)) return false;
        if (state.availability === 'quote' && hasPrice(product)) return false;
        if (state.availability === 'sold_out' && product.availability !== 'sold_out') return false;
        return !query || normalize([family.name, product.name, product.series, product.sku, product.description, product.condition, product.unit_label, product.collection_name].join(' ')).includes(query);
      });
      return variants.length ? [familyView(family, variants)] : [];
    });
    if (state.sort === 'name') results.sort((a, b) => a.name.localeCompare(b.name, 'vi'));
    else if (state.sort === 'price-asc' || state.sort === 'price-desc') results.sort((a, b) => {
      if (a.price === null) return b.price === null ? 0 : 1;
      if (b.price === null) return -1;
      return state.sort === 'price-asc' ? a.price - b.price : b.price - a.price;
    });
    return results;
  }
  function productCard(family) {
    const product = family.representative;
    const count = family.variants.length;
    const multiple = count > 1;
    const badge = !family.liveCount ? '<span class="product-badge sold">Đã bán</span>' : family.price === null ? '<span class="product-badge quote">Cần báo giá</span>' : '';
    const condition = multiple ? '' : product.condition || '';
    const url = detailURL(product);
    const videoUnits = family.matchingVariants.filter(unit => Array.isArray(unit.media) && unit.media.some(media => media.kind === 'video'));
    const videoCount = videoUnits.reduce((sum, unit) => sum + unit.media.filter(media => media.kind === 'video').length, 0);
    const amount = family.liveCount === 0 ? 'Đã bán' : family.price === null ? 'Hỏi giá' : `${multiple ? 'Từ ' : ''}${money(family.price)}`;
    const matchingNote = family.matchingVariants.length < count ? `${family.matchingVariants.length}/${count} món` : `${count} món`;
    const cover = imagesOf(product)[0];
    const coverLabel = Array.isArray(product.uploaded_images) && product.uploaded_images.includes(cover) ? `Ảnh ${product.unit_label || 'món hàng'}` : 'Ảnh danh mục';
    return `<article class="product-card" data-family="${escapeHTML(family.id)}"><a class="product-image-button" data-detail="${escapeHTML(product.id)}" href="${url}" aria-label="Xem các món ${escapeHTML(family.name)}">${badge}${imageMarkup({...product,name:family.name})}${videoCount ? `<span class="product-video-count">▶ ${videoCount}</span>` : ''}${cover ? `<span class="product-cover-source">${escapeHTML(coverLabel)}</span>` : ''}<span class="product-view">${multiple ? 'Chọn món' : 'Xem chi tiết'} ↗</span></a><div class="product-info"><a class="product-name" href="${url}">${escapeHTML(family.name)}</a><div class="product-card-meta"><p class="product-series" title="${escapeHTML(product.series)}">${escapeHTML(shortSeries(product.series))}</p><span class="product-unit-count">${escapeHTML(matchingNote)}</span></div>${condition ? `<p class="product-condition" title="${escapeHTML(condition)}">${escapeHTML(condition)}</p>` : ''}${family.hasUnpriced && family.price !== null ? '<p class="product-price-note">Có món cần báo giá</p>' : ''}${videoCount ? `<a class="product-video-link" href="${detailURL(videoUnits[0])}&view=video#product-videos">▶ Video ${escapeHTML(videoUnits[0].unit_label || '')}</a>` : ''}<div class="product-bottom"><span class="product-price ${family.price !== null ? '' : 'price-quote'}">${escapeHTML(amount)}</span>${multiple ? `<a class="choose-unit-link" href="${url}" aria-label="Chọn món ${escapeHTML(family.name)}">Chọn món <span aria-hidden="true">↗</span></a>` : canOrder(product) ? `<button class="add-button" data-add="${escapeHTML(product.id)}" aria-label="Thêm ${escapeHTML(family.name)} vào giỏ hàng" title="Thêm món này vào giỏ hàng">${icons.bag}<span>Thêm vào giỏ</span></button>` : `<a class="choose-unit-link" href="${url}" aria-label="Xem chi tiết ${escapeHTML(family.name)}">Xem món <span aria-hidden="true">↗</span></a>`}</div></div></article>`;
  }
  function renderProducts() {
    const products = filteredProducts();
    const grid = $('#product-grid');
    grid.setAttribute('aria-busy', 'false');
    grid.innerHTML = products.length ? products.slice(0, state.visible).map(productCard).join('') : '<div class="empty-state"><h3>Chưa tìm thấy mảnh ghép này</h3><p>Thử một tên khác hoặc bỏ bớt bộ lọc để khám phá thêm sản phẩm.</p><button class="button outline" data-clear-filters>Xem tất cả sản phẩm</button></div>';
    const units = products.reduce((sum, family) => sum + family.matchingVariants.length, 0);
    $('#catalog-total').textContent = `${products.length} mẫu · ${units} món`;
    $('#showing-count').textContent = products.length ? `${Math.min(products.length, state.visible)} / ${products.length} mẫu` : '';
    $('#load-more').hidden = state.visible >= products.length;
    const hasFilters = Boolean(state.series || state.query.trim() || state.availability !== 'all');
    $('#active-filters').hidden = !hasFilters;
    $('#filter-description').textContent = `${products.length} kết quả${state.query.trim() ? ` cho “${state.query.trim()}”` : ''}`;
  }
  function clearFilters() {
    state.series = ''; state.query = ''; state.availability = 'all'; state.sort = 'default'; state.visible = 16;
    const url = new URL(location.href);
    url.searchParams.delete('series');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
    $('#search-input').value = ''; $('#availability-filter').value = 'all'; $('#sort-filter').value = 'default';
    renderChips(); renderProducts();
  }

  function showProduct(id) {
    const product = productById(id);
    if (product) location.assign(detailURL(product));
  }

  function cartHeader(title, back = false) {
    return `<div class="cart-header">${back ? '<button class="icon-button" data-back-cart aria-label="Quay lại giỏ hàng">←</button>' : ''}<h2 id="cart-title">${escapeHTML(title)}</h2><button class="icon-button" data-close-cart aria-label="Đóng giỏ hàng">×</button></div>`;
  }
  function cartItemMarkup(item) {
    const product = item.product;
    return `<article class="cart-item" data-cart-unit="${escapeHTML(product.id)}">${imageMarkup(product, 'cart-item-image')}<div><h3><a href="${detailURL(product)}">${escapeHTML(product.family_name || product.name)}</a></h3><p class="cart-unit-label">${escapeHTML(unitDescription(product))}</p>${product.condition ? `<p class="cart-unit-condition">${escapeHTML(product.condition)}</p>` : ''}<p class="cart-item-price">${escapeHTML(priceText(product))}</p><div class="cart-item-controls"><span class="cart-single-unit">Số lượng: 1</span><button class="remove-item" data-remove="${escapeHTML(product.id)}" aria-label="Xóa ${escapeHTML(product.family_name || product.name)} ${escapeHTML(product.unit_label || '')} khỏi giỏ hàng">Xóa</button></div></div></article>`;
  }
  function renderCart() {
    const items = cartItems();
    cartDialog.innerHTML = cartHeader('Giỏ hàng') + (items.length ? `<div class="cart-body">${items.map(cartItemMarkup).join('')}</div><div class="cart-footer"><div class="totals-row"><span>Tạm tính</span><strong>${money(subtotal())}</strong></div><div class="totals-row shipping"><span>Phí vận chuyển</span><span>Xác nhận sau</span></div><button class="button primary" data-checkout>Tiếp tục đặt hàng <span aria-hidden="true">→</span></button><p class="fine-print">Shop xác nhận tình trạng và phí ship trước khi giao.</p></div>` : `<div class="cart-body"><div class="cart-empty"><div class="cart-empty-icon" aria-hidden="true">${icons.cube}</div><h3>Mảnh ghép tiếp theo là gì?</h3><p>Giỏ hàng của bạn vẫn đang chờ<br>những mô hình yêu thích.</p><button class="button primary" data-close-cart>Khám phá bộ sưu tập <span aria-hidden="true">↗</span></button></div></div>`);
  }
  function showCart() {
    if (!state.loaded) return notify('Bộ sưu tập đang tải. Vui lòng thử lại sau giây lát.');
    renderCart(); openDialog(cartDialog);
  }
  function changeQuantity(id, delta) {
    const item = state.cart.find(entry => entry.product_id === id);
    if (!item) return;
    if (delta >= 0) return notify('Mỗi lựa chọn là một món hàng cũ riêng. Chọn món khác trên trang chi tiết.');
    state.cart = state.cart.filter(entry => entry.product_id !== id);
    saveCart(); renderCart();
    const replacement = [...cartDialog.querySelectorAll('[data-quantity]')].find(button => button.dataset.quantity === id && Number(button.dataset.delta) === delta && !button.disabled);
    if (replacement) replacement.focus();
  }
  function renderCheckout() {
    if (!cartItems().length) return renderCart();
    cartDialog.innerHTML = cartHeader('Thông tin đặt hàng', true) + `<div class="checkout-body"><p class="checkout-intro">Shop sẽ gọi xác nhận đơn hàng.</p><form id="checkout-form"><label class="field"><span>Họ và tên *</span><input name="name" required minlength="2" maxlength="100" autocomplete="name" placeholder="Nguyễn Văn An" value="${escapeHTML(checkoutDraft.name || '')}"></label><label class="field"><span>Số điện thoại *</span><input name="phone" type="tel" required minlength="9" maxlength="20" autocomplete="tel" placeholder="Số điện thoại nhận hàng" value="${escapeHTML(checkoutDraft.phone || '')}"></label><label class="field"><span>Email <small>(không bắt buộc)</small></span><input name="email" type="email" maxlength="254" autocomplete="email" placeholder="ban@email.com" value="${escapeHTML(checkoutDraft.email || '')}"></label><label class="field"><span>Địa chỉ nhận hàng *</span><textarea name="address" required minlength="10" maxlength="500" autocomplete="street-address" placeholder="Số nhà, tên đường, phường/xã, tỉnh/thành phố">${escapeHTML(checkoutDraft.address || '')}</textarea></label><label class="field"><span>Ghi chú <small>(không bắt buộc)</small></span><textarea name="note" maxlength="1000" placeholder="Thông tin thêm cho cửa hàng…">${escapeHTML(checkoutDraft.note || '')}</textarea></label><div class="checkout-payment"><strong>Thanh toán khi nhận hàng (COD)</strong><p>Shop xác nhận tình trạng và phí ship trước khi giao.</p></div><div class="checkout-total"><span>Tạm tính · ${state.cart.reduce((sum, item) => sum + item.quantity, 0)} sản phẩm</span><strong>${money(subtotal())}</strong></div><p class="form-error" id="checkout-error" role="alert" hidden></p><button class="button primary" id="submit-order" type="submit">Gửi yêu cầu đặt mua <span aria-hidden="true">→</span></button></form></div>`;
    $('#checkout-form').addEventListener('submit', submitOrder);
    $('#checkout-form').addEventListener('input', () => { checkoutDraft = Object.fromEntries(new FormData($('#checkout-form'))); });
    $('[name="name"]', cartDialog).focus();
  }
  async function requestKey(payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    const fingerprint = [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (state.pending && state.pending.fingerprint === fingerprint && typeof state.pending.key === 'string') return state.pending.key;
    state.pending = { fingerprint, key: crypto.randomUUID() };
    storage.set('sentai-order-pending-v1', state.pending);
    return state.pending.key;
  }
  async function submitOrder(event) {
    event.preventDefault();
    if (state.submitting) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const customer = Object.fromEntries([...new FormData(form)].map(([key, value]) => [key, value.trim()]));
    checkoutDraft = customer;
    const errorElement = $('#checkout-error');
    errorElement.hidden = true;
    if (customer.name.length < 2 || customer.address.length < 10) {
      errorElement.textContent = 'Vui lòng nhập đầy đủ họ tên và địa chỉ nhận hàng.';
      errorElement.hidden = false; return;
    }
    if (!/^[+\d\s().-]{9,20}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 9) {
      errorElement.textContent = 'Vui lòng nhập số điện thoại hợp lệ (ít nhất 9 chữ số).';
      errorElement.hidden = false; $('[name="phone"]', form).focus(); return;
    }
    const payload = { customer, items: state.cart.map(item => ({ product_id: item.product_id, quantity: item.quantity })).sort((a, b) => a.product_id.localeCompare(b.product_id)) };
    if (!payload.items.length) return renderCart();
    const button = $('#submit-order');
    state.submitting = true;
    button.disabled = true; button.textContent = 'Đang gửi yêu cầu…';
    cartDialog.querySelectorAll('[data-close-cart], [data-back-cart]').forEach(control => { control.disabled = true; });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      payload.idempotency_key = await requestKey(payload);
      const response = await fetch('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      let result;
      try { result = await response.json(); } catch { throw new Error('Chưa đọc được phản hồi của cửa hàng. Vui lòng thử gửi lại.'); }
      if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : result.message || 'Chưa thể gửi yêu cầu. Vui lòng thử lại.');
      if (!result.order?.order_number) throw new Error('Cửa hàng chưa trả về mã đơn. Vui lòng thử gửi lại để kiểm tra.');
      state.cart = []; saveCart(); checkoutDraft = {};
      renderSuccess(result.order);
    } catch (error) {
      errorElement.textContent = error.name === 'AbortError' ? 'Kết nối đang chậm. Bạn có thể bấm gửi lại; cùng yêu cầu sẽ không tạo đơn trùng.' : error instanceof TypeError ? 'Không kết nối được cửa hàng. Kiểm tra kết nối rồi thử gửi lại.' : error.message;
      errorElement.hidden = false;
      errorElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      button.disabled = false; button.innerHTML = 'Gửi lại yêu cầu <span aria-hidden="true">→</span>';
    } finally {
      clearTimeout(timeout); state.submitting = false;
      cartDialog.querySelectorAll('[data-close-cart], [data-back-cart]').forEach(control => { control.disabled = false; });
    }
  }
  function renderSuccess(order) {
    cartDialog.innerHTML = cartHeader('Đã nhận yêu cầu') + `<div class="success-body"><div class="success-icon" aria-hidden="true">✓</div><h3>Thêm một mảnh ghép mới!</h3><p>Yêu cầu đặt mua của bạn đã được lưu.<br>Cửa hàng sẽ liên hệ để xác nhận sản phẩm<br>và thông tin giao hàng.</p><div class="order-receipt"><div><span>Mã đơn hàng</span><strong>${escapeHTML(order.order_number)}</strong></div><div><span>Trạng thái</span><strong>Chờ xác nhận</strong></div><div><span>Tiền sản phẩm</span><strong>${money(Number(order.subtotal ?? order.total ?? 0))}</strong></div><div><span>Phí vận chuyển</span><strong>Xác nhận sau</strong></div><div><span>Thanh toán</span><strong>Khi nhận hàng (COD)</strong></div></div><p>Hãy lưu lại mã đơn để tiện đối chiếu với cửa hàng.</p><button class="button primary" data-close-cart>Tiếp tục khám phá <span aria-hidden="true">↗</span></button></div>`;
    $('[data-close-cart]', cartDialog).focus();
  }

  async function loadCatalog() {
    const grid = $('#product-grid');
    grid.setAttribute('aria-busy', 'true');
    grid.innerHTML = '<div class="loading-state"><span class="spinner"></span><p>Đang mở bộ sưu tập của bạn…</p></div>';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/api/catalog', { signal: controller.signal });
      if (!response.ok) throw new Error('Không tải được danh sách sản phẩm.');
      const data = await response.json();
      if (!Array.isArray(data.products)) throw new Error('Dữ liệu sản phẩm chưa sẵn sàng.');
      state.products = data.products.filter(product => product && typeof product.id === 'string' && typeof product.name === 'string');
      // Group membership is assigned on the server. Do not guess from numbered names here.
      const families = Array.isArray(data.families) ? data.families : state.products.map(product => ({id:product.id,name:product.name,series:product.series,variants:[product]}));
      state.families = families.filter(family => family && typeof family.id === 'string' && typeof family.name === 'string' && Array.isArray(family.variants))
        .map(family => ({...family,variants:family.variants.map(product => productById(product.id)).filter(Boolean)})).filter(family => family.variants.length);
      const requestedSeries = new URL(location.href).searchParams.get('series');
      if (requestedSeries && state.products.some(product => product.series === requestedSeries)) state.series = requestedSeries;
      state.loaded = true;
      state.shop = data.metadata?.shop || {};
      renderContact();
      const previousCart = JSON.stringify(state.cart);
      state.cart = normalizeCart(state.cart);
      if (previousCart !== JSON.stringify(state.cart)) {
        saveCart();
        notify('Giỏ hàng đã được cập nhật: mỗi món hàng cũ có số lượng một chiếc.');
      } else storage.set('sentai-cart-v1', state.cart);
      updateCartCount(); renderHero(); renderChips(); renderProducts();
      const currentURL = new URL(location.href);
      if (currentURL.searchParams.get('cart') === '1') {
        showCart();
        currentURL.searchParams.delete('cart');
        history.replaceState(null, '', currentURL.pathname + currentURL.search + currentURL.hash);
      }
      window.SentaiAnalytics?.view('home');
    } catch {
      grid.setAttribute('aria-busy', 'false');
      grid.innerHTML = '<div class="empty-state"><h3>Bộ sưu tập đang tạm gián đoạn</h3><p>Chưa kết nối được với cửa hàng. Vui lòng thử tải lại sau ít phút.</p><button class="button primary" data-retry>Tải lại bộ sưu tập</button></div>';
      $('#catalog-total').textContent = 'Chưa thể tải sản phẩm';
    } finally { clearTimeout(timeout); }
  }

  document.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.hasAttribute('data-detail')) showProduct(button.dataset.detail);
    else if (button.hasAttribute('data-add')) addToCart(button.dataset.add);
    else if (button.hasAttribute('data-series')) {
      state.series = button.dataset.series; state.visible = 16;
      const url = new URL(location.href);
      if (state.series) url.searchParams.set('series', state.series); else url.searchParams.delete('series');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      renderChips(); renderProducts();
    }
    else if (button.hasAttribute('data-close-product')) closeDialog(productDialog);
    else if (button.hasAttribute('data-close-cart') && !state.submitting) closeDialog(cartDialog);
    else if (button.hasAttribute('data-checkout')) renderCheckout();
    else if (button.hasAttribute('data-back-cart') && !state.submitting) renderCart();
    else if (button.hasAttribute('data-remove')) { state.cart = state.cart.filter(item => item.product_id !== button.dataset.remove); saveCart(); renderCart(); }
    else if (button.hasAttribute('data-quantity')) changeQuantity(button.dataset.quantity, Number(button.dataset.delta));
    else if (button.hasAttribute('data-clear-filters')) clearFilters();
    else if (button.hasAttribute('data-retry')) loadCatalog();
    else if (button.hasAttribute('data-image-index')) {
      const product = productById(button.dataset.productId);
      if (!product) return;
      $('#detail-main-image').innerHTML = imageMarkup(product, '', false, Number(button.dataset.imageIndex));
      productDialog.querySelectorAll('[data-image-index]').forEach(thumb => { thumb.classList.toggle('selected', thumb === button); thumb.setAttribute('aria-pressed', String(thumb === button)); });
    }
  });
  document.addEventListener('error', event => {
    if (event.target instanceof HTMLImageElement) {
      const image = event.target;
      const fallback = document.createElement('div');
      fallback.className = `image-placeholder ${image.className}`;
      fallback.innerHTML = `${icons.cube}<span>Chưa tải được ảnh</span>`;
      image.replaceWith(fallback);
    }
  }, true);
  $('#open-cart').addEventListener('click', showCart);
  $('#hero-product').addEventListener('click', () => { if (state.heroId) showProduct(state.heroId); });
  $('#load-more').addEventListener('click', () => { state.visible += 16; renderProducts(); });
  $('#clear-filters').addEventListener('click', clearFilters);
  $('#search-input').addEventListener('input', event => { state.query = event.target.value; state.visible = 16; if (state.loaded) renderProducts(); });
  $('#availability-filter').addEventListener('change', event => { state.availability = event.target.value; state.visible = 16; if (state.loaded) renderProducts(); });
  $('#sort-filter').addEventListener('change', event => { state.sort = event.target.value; if (state.loaded) renderProducts(); });
  $('#focus-search').addEventListener('click', () => { $('#catalog').scrollIntoView({ behavior: 'smooth' }); $('#search-input').focus({ preventScroll: true }); });
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !productDialog.open && !cartDialog.open && !/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) {
      event.preventDefault(); $('#catalog').scrollIntoView({ behavior: 'smooth' }); $('#search-input').focus({ preventScroll: true });
    }
  });
  window.addEventListener('storage', event => {
    if (event.key !== 'sentai-cart-v1' || !state.loaded || state.submitting) return;
    state.cart = normalizeCart(storage.get('sentai-cart-v1', []));
    state.pending = null;
    storage.remove('sentai-order-pending-v1');
    updateCartCount();
    if (cartDialog.open && !$('#checkout-form')) renderCart();
  });
  updateCartCount(); loadCatalog();
})();
