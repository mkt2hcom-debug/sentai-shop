'use strict';

const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const formatMoney = (value) => value == null ? 'Chưa có giá' : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(value);
const formatDate = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa rõ ngày' : date.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'short', timeStyle: 'short' });
};
const normalize = (value) => String(value ?? '').toLocaleLowerCase('vi').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
const statuses = { pending: 'Chờ xác nhận', confirmed: 'Đã xác nhận', shipping: 'Đang giao', completed: 'Hoàn tất', cancelled: 'Đã hủy' };
const availabilities = { unknown: 'Cần xác nhận', available: 'Còn hàng', sold_out: 'Đã bán / hết hàng' };
const state = { products: [], orders: [], productId: null, orderId: null, enabled: true, setupAllowed: false, activeTab: 'orders', generation: 0 };
let authBusy = false;
let recoveryRequested = false;
let recoveryToken = '';
// A recovery secret stays in this document's memory, never in requests for HTML,
// browser storage, subsequent navigation, or history entries.
{
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('reset')) {
    recoveryRequested = true;
    const token = fragment.get('reset');
    if (/^[A-Za-z0-9_-]{43}$/.test(token || '')) recoveryToken = token;
    history.replaceState(null, '', location.pathname + location.search);
  }
}

function clearAuthPasswords() {
  for (const id of ['password','setup-password','setup-password-confirm','reset-password','reset-password-confirm']) {
    const input = $(`#${id}`);
    input.value = '';
    input.type = 'password';
  }
  for (const button of document.querySelectorAll('[data-toggle-password]')) {
    button.textContent = 'Hiện';
    button.setAttribute('aria-pressed','false');
    button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^Ẩn/,'Hiện'));
  }
}

function continueToProduct() {
  const next = new URLSearchParams(location.search).get('next');
  if (next && (['/admin/prices','/admin/analytics'].includes(next) || /^\/admin\/products\/[a-zA-Z0-9_-]+$/.test(next))) {
    location.assign(next);
    return true;
  }
  return false;
}

function badge(value, labels) {
  const safeValue = Object.hasOwn(labels, value) ? value : 'unknown';
  return `<span class="badge ${safeValue}">${escapeHTML(labels[value] || 'Chưa xác định')}</span>`;
}

async function api(path, options = {}) {
  const response = await window.SentaiAdmin.fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && !['/api/admin/login','/api/admin/reset'].includes(path)) showLogin(state.enabled);
    const error = new Error(body.error || `Không thể hoàn tất yêu cầu (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showLogin(enabled) {
  state.generation += 1;
  state.enabled = enabled;
  state.products = [];
  state.orders = [];
  state.productId = null;
  state.orderId = null;
  $('#orders-table').replaceChildren();
  $('#products-table').replaceChildren();
  $('#order-detail').replaceChildren();
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('#boot-status').hidden = true;
  $('#dashboard').hidden = true;
  $('#logout').hidden = true;
  $('#login-section').hidden = false;
  $('#disabled-message').hidden = recoveryRequested || enabled || state.setupAllowed;
  $('#login-form').hidden = recoveryRequested || !enabled;
  $('#setup-form').hidden = recoveryRequested || enabled || !state.setupAllowed;
  $('#reset-form').hidden = !recoveryRequested || !recoveryToken;
  $('#back-to-login').hidden = !recoveryRequested;
  $('#forgot-password').hidden = !recoveryRequested && !enabled;
  $('#login-title').textContent = recoveryRequested ? 'Đặt lại mật khẩu' : !enabled && state.setupAllowed ? 'Tạo tài khoản quản trị' : 'Đăng nhập quản trị';
  $('#login-description').textContent = recoveryRequested ? 'Chọn tài khoản và mật khẩu mới cho chủ cửa hàng.' : !enabled && state.setupAllowed ? 'Thiết lập tài khoản chủ cửa hàng trên máy này.' : 'Tài khoản dành cho chủ cửa hàng.';
  $('#login-error').textContent = recoveryRequested && !recoveryToken ? 'Liên kết khôi phục không hợp lệ. Tạo liên kết mới theo hướng dẫn bên dưới.' : '';
  if (recoveryRequested && !recoveryToken) $('#forgot-password').open = true;
  clearAuthPasswords();
}

function showDashboard() {
  $('#boot-status').hidden = true;
  $('#login-section').hidden = true;
  $('#dashboard').hidden = false;
  $('#logout').hidden = false;
  clearAuthPasswords();
}

function message(text, kind = '') {
  const node = $('#dashboard-message');
  node.textContent = text;
  node.className = `notice ${kind}`;
  node.hidden = !text;
}

function renderStats() {
  $('#stat-products').textContent = state.products.length.toLocaleString('vi-VN');
  const models = new Set(state.products.map(product => product.family_id || product.id)).size;
  $('#stat-prices').textContent = `${models} mẫu · ${state.products.filter((product) => product.price_vnd == null).length} món chưa có giá`;
  $('#stat-pending').textContent = state.orders.filter((order) => order.status === 'pending').length.toLocaleString('vi-VN');
  $('#stat-orders').textContent = state.orders.length.toLocaleString('vi-VN');
  $('#stat-revenue').textContent = formatMoney(state.orders.filter((order) => order.status === 'completed').reduce((sum, order) => sum + Number(order.total || 0), 0));
  $('#orders-count').textContent = state.orders.length;
  $('#products-count').textContent = state.products.length;
}

function renderOrders() {
  const query = normalize($('#order-search').value.trim());
  const filter = $('#order-status-filter').value;
  const orders = state.orders.filter((order) => (!filter || order.status === filter) && normalize(`${order.order_number} ${order.customer_name} ${order.customer_phone}`).includes(query));
  $('#orders-table').innerHTML = orders.map((order) => `<tr role="row"><td role="cell"><strong>${escapeHTML(order.order_number)}</strong><small>${escapeHTML(formatDate(order.created_at))}</small></td><td role="cell"><strong>${escapeHTML(order.customer_name)}</strong><small>${escapeHTML(order.customer_phone)}</small></td><td role="cell" class="money-cell"><strong>${escapeHTML(formatMoney(order.total))}</strong><small>${(order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0)} sản phẩm</small></td><td role="cell">${badge(order.status, statuses)}</td><td role="cell"><button class="row-action" data-order="${escapeHTML(order.id)}" aria-label="Xem đơn ${escapeHTML(order.order_number)}">Xem đơn ↗</button></td></tr>`).join('');
  $('#orders-empty').hidden = orders.length > 0;
}

function imageMarkup(product) {
  const image = product.images?.[0];
  if (typeof image !== 'string' || !/^\/(?:images\/products\/[a-zA-Z0-9_.-]+|media\/[a-f0-9-]{36}\/(?:image|poster)\.webp)$/.test(image)) return '<span class="product-thumb product-placeholder" aria-hidden="true">◇</span>';
  return `<img class="product-thumb" src="${escapeHTML(image)}" alt="" loading="lazy" width="53" height="55">`;
}

function renderProducts() {
  const query = normalize($('#product-search').value.trim());
  const filter = $('#product-stock-filter').value;
  const products = state.products.filter((product) => (!filter || (filter === 'unpriced' ? product.price_vnd == null : product.availability === filter)) && normalize(`${product.name} ${product.family_name || ''} ${product.unit_label || ''} ${product.collection_name || ''} ${product.condition || ''} ${product.id} ${product.sku || ''} ${product.series}`).includes(query));
  $('#products-table').innerHTML = products.map((product) => {
    const unit = product.unit_label || 'Món hàng';
    const name = product.family_name || product.name;
    const owner = `${name} — ${unit} (${product.id})`;
    return `<tr role="row"><td role="cell"><div class="product-cell">${imageMarkup(product)}<div><strong>${escapeHTML(name)}</strong><span class="unit-table-label">${escapeHTML(unit)}</span><small>Mã món: ${escapeHTML(product.id)}${product.sku ? `<br>SKU: ${escapeHTML(product.sku)}` : ''}</small></div></div></td><td role="cell" class="series-cell"><strong>${escapeHTML(product.collection_name || product.series || 'Chưa xếp BST')}</strong><small>${escapeHTML(product.condition || 'Chưa mô tả tình trạng')}</small></td><td role="cell" class="money-cell"><strong>${escapeHTML(formatMoney(product.price_vnd))}</strong><small>Cho món này</small></td><td role="cell">${badge(product.availability, availabilities)}</td><td role="cell"><div class="product-row-actions"><button class="row-action" data-product="${escapeHTML(product.id)}" aria-label="Chỉnh sửa ${escapeHTML(owner)}">Chỉnh sửa món</button><a class="row-action" href="/admin/products/${encodeURIComponent(product.id)}" aria-label="Quản lý ảnh và video ${escapeHTML(owner)}">Ảnh / video ↗</a></div></td></tr>`;
  }).join('');
  $('#products-empty').hidden = products.length > 0;
}

async function loadData() {
  const generation = ++state.generation;
  const button = $('#refresh');
  button.disabled = true;
  message('Đang tải dữ liệu cửa hàng…');
  try {
    const [products, orders] = await Promise.all([api('/api/admin/products'), api('/api/admin/orders')]);
    if (generation !== state.generation) return;
    state.products = products.products || [];
    state.orders = orders.orders || [];
    renderStats();
    renderProducts();
    renderOrders();
    $('#updated-at').textContent = `Cập nhật lúc ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}`;
    message('');
  } catch (error) {
    if (generation !== state.generation) return;
    message(`Không tải được dữ liệu. ${error.message} Hãy chọn “Làm mới dữ liệu” để thử lại.`, 'error');
  } finally {
    button.disabled = false;
  }
}

function setTab(name, focus = false) {
  state.activeTab = name;
  for (const tab of ['orders', 'products']) {
    const active = tab === name;
    $(`#tab-${tab}`).setAttribute('aria-selected', String(active));
    $(`#tab-${tab}`).tabIndex = active ? 0 : -1;
    $(`#panel-${tab}`).hidden = !active;
  }
  if (focus) $(`#tab-${name}`).focus();
}

function openProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  state.productId = id;
  $('#product-name').textContent = `${product.family_name || product.name} — ${product.unit_label || 'Món hàng'}`;
  $('#product-sku').textContent = `Mã món: ${product.id} · SKU: ${product.sku || 'Chưa có'} · ${product.series || ''}`;
  $('#product-unit-label').value = product.unit_label || 'Món hàng';
  $('#product-collection').value = product.collection_label || '';
  $('#product-condition').value = product.condition || '';
  $('#product-source-condition').textContent = product.source_condition || 'File danh mục chưa có mô tả tình trạng.';
  $('#product-price').value = product.price_vnd ?? '';
  $('#product-availability').value = product.availability || 'unknown';
  $('#product-error').textContent = '';
  $('#product-media-link').href = `/admin/products/${encodeURIComponent(id)}`;
  $('#product-dialog').showModal();
}

function renderOrderDetail(order) {
  $('#order-dialog-title').textContent = order.order_number;
  $('#order-detail').innerHTML = `<div class="order-meta">${badge(order.status, statuses)}<span>Đặt lúc ${escapeHTML(formatDate(order.created_at))}</span></div><dl class="customer-info"><div><dt>Khách hàng</dt><dd>${escapeHTML(order.customer_name)}</dd></div><div><dt>Số điện thoại</dt><dd>${escapeHTML(order.customer_phone)}</dd></div>${order.customer_email ? `<div class="wide"><dt>Email</dt><dd>${escapeHTML(order.customer_email)}</dd></div>` : ''}<div class="wide"><dt>Địa chỉ nhận hàng</dt><dd>${escapeHTML(order.customer_address)}</dd></div>${order.note ? `<div class="wide"><dt>Ghi chú của khách</dt><dd>${escapeHTML(order.note)}</dd></div>` : ''}</dl><div class="order-items">${(order.items || []).map((item) => `<div class="order-item"><div>${escapeHTML(item.family_name || item.product_name)}${item.unit_label ? `<small class="order-unit-label">${escapeHTML(item.unit_label)} · Mã món: ${escapeHTML(item.product_id)}</small>` : ''}${item.collection_label ? `<small>BST: ${escapeHTML(item.collection_label)}</small>` : ''}${item.condition_note ? `<small>Tình trạng khi đặt: ${escapeHTML(item.condition_note)}</small>` : ''}<small>${escapeHTML(item.quantity)} × ${escapeHTML(formatMoney(item.unit_price))}</small></div><strong>${escapeHTML(formatMoney(item.line_total ?? item.unit_price * item.quantity))}</strong></div>`).join('')}<div class="order-total"><span>Tổng tiền sản phẩm</span><strong>${escapeHTML(formatMoney(order.total))}</strong></div></div><p class="shipping-note">Thanh toán khi nhận hàng (COD). Phí vận chuyển được xác nhận riêng với khách hàng.</p>`;
  $('#order-status').value = order.status;
}

function openOrder(id) {
  const order = state.orders.find((item) => String(item.id) === id);
  if (!order) return;
  state.orderId = id;
  renderOrderDetail(order);
  $('#order-error').textContent = '';
  $('#order-dialog').showModal();
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;
  const button = event.submitter || $('#login-form button[type="submit"]');
  authBusy = true;
  button.disabled = true;
  $('#login-error').textContent = '';
  try {
    const username = $('#username').value.trim().toLowerCase();
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ username, password: $('#password').value }) });
    $('#username').value = username;
    clearAuthPasswords();
    state.enabled = true;
    state.setupAllowed = false;
    if (continueToProduct()) return;
    showDashboard();
    await loadData();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    authBusy = false;
    button.disabled = false;
  }
});

$('#setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;
  const password = $('#setup-password').value;
  const confirm = $('#setup-password-confirm').value;
  $('#login-error').textContent = '';
  if (Array.from(password).length < 15 || Array.from(password).length > 128 || password !== confirm) {
    $('#login-error').textContent = Array.from(password).length < 15 || Array.from(password).length > 128 ? 'Mật khẩu cần từ 15 đến 128 ký tự.' : 'Hai mật khẩu chưa trùng nhau.';
    return;
  }
  const button = event.submitter || $('#setup-form button[type="submit"]');
  authBusy = true;
  button.disabled = true;
  try {
    const username = $('#setup-username').value.trim().toLowerCase();
    await api('/api/admin/setup', { method: 'POST', body: JSON.stringify({ username, password }) });
    $('#username').value = username;
    clearAuthPasswords();
    state.enabled = true;
    state.setupAllowed = false;
    if (continueToProduct()) return;
    showDashboard();
    setTab('products');
    await loadData();
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally { authBusy = false; button.disabled = false; }
});

$('#reset-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy || !recoveryToken) return;
  const password = $('#reset-password').value;
  const confirm = $('#reset-password-confirm').value;
  $('#login-error').textContent = '';
  if (Array.from(password).length < 15 || Array.from(password).length > 128 || password !== confirm) {
    $('#login-error').textContent = Array.from(password).length < 15 || Array.from(password).length > 128 ? 'Mật khẩu cần từ 15 đến 128 ký tự.' : 'Hai mật khẩu chưa trùng nhau.';
    return;
  }
  const button = event.submitter || $('#reset-form button[type="submit"]');
  authBusy = true;
  button.disabled = true;
  $('#back-to-login').disabled = true;
  try {
    const username = $('#reset-username').value.trim().toLowerCase();
    await api('/api/admin/reset', {method:'POST',body:JSON.stringify({token:recoveryToken,username,password})});
    recoveryToken = '';
    recoveryRequested = false;
    $('#username').value = username;
    clearAuthPasswords();
    state.enabled = true;
    state.setupAllowed = false;
    if (continueToProduct()) return;
    showDashboard();
    await loadData();
    message('Đã đổi mật khẩu. Tài khoản: ' + username + '.', 'success');
  } catch (error) {
    if ([401,410].includes(error.status)) {
      recoveryToken = '';
      showLogin(state.enabled);
      $('#forgot-password').open = true;
    }
    $('#login-error').textContent = error.message;
  } finally {
    authBusy = false;
    button.disabled = false;
    $('#back-to-login').disabled = false;
  }
});

$('#back-to-login').addEventListener('click', () => {
  if (authBusy) return;
  recoveryToken = '';
  recoveryRequested = false;
  $('#forgot-password').open = false;
  showLogin(state.enabled);
});
for (const button of document.querySelectorAll('[data-toggle-password]')) {
  button.addEventListener('click', () => {
    const input = $(`#${button.dataset.togglePassword}`);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Ẩn' : 'Hiện';
    button.setAttribute('aria-pressed',String(visible));
    button.setAttribute('aria-label',button.getAttribute('aria-label').replace(/^(Hiện|Ẩn)/,visible ? 'Ẩn' : 'Hiện'));
  });
}

$('#logout').addEventListener('click', async () => {
  const button = $('#logout');
  button.disabled = true;
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
    showLogin(state.enabled);
  } catch (error) {
    message(`Không đăng xuất được. ${error.message}`, 'error');
  } finally {
    button.disabled = false;
  }
});

$('#refresh').addEventListener('click', loadData);
for (const tab of ['orders', 'products']) {
  $(`#tab-${tab}`).addEventListener('click', () => setTab(tab));
  $(`#tab-${tab}`).addEventListener('keydown', (event) => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      setTab(event.key === 'Home' ? 'orders' : event.key === 'End' ? 'products' : tab === 'orders' ? 'products' : 'orders', true);
    }
  });
}
$('#order-search').addEventListener('input', renderOrders);
$('#order-status-filter').addEventListener('change', renderOrders);
$('#product-search').addEventListener('input', renderProducts);
$('#product-stock-filter').addEventListener('change', renderProducts);
$('#products-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-product]');
  if (button) openProduct(button.dataset.product);
});
$('#orders-table').addEventListener('click', (event) => {
  const button = event.target.closest('[data-order]');
  if (button) openOrder(button.dataset.order);
});
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => document.getElementById(button.dataset.close).close());

$('#product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const priceText = $('#product-price').value.trim();
  const price = priceText === '' ? null : Number(priceText);
  if (price !== null && (!Number.isSafeInteger(price) || price <= 0 || price > 1000000000)) {
    $('#product-error').textContent = 'Vui lòng nhập đơn giá là số nguyên dương hợp lệ, hoặc để trống.';
    return;
  }
  button.disabled = true;
  $('#product-error').textContent = '';
  const id = state.productId;
  try {
    const product = state.products.find(item => item.id === id);
    const condition = $('#product-condition').value.trim();
    const response = await api(`/api/admin/products/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ price_vnd: price, availability: $('#product-availability').value,
      unit_label: $('#product-unit-label').value.trim(), collection_label: $('#product-collection').value.trim(),
      condition_note: condition === (product?.source_condition || '') ? null : condition }) });
    state.products = state.products.map((product) => product.id === id ? { ...product, ...response.product } : product);
    renderStats();
    renderProducts();
    $('#product-dialog').close();
    message('Đã lưu tên món, BST, tình trạng và giá của đúng món hàng.', 'success');
  } catch (error) {
    $('#product-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#order-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.submitter;
  const status = $('#order-status').value;
  const id = state.orderId;
  const current = state.orders.find((order) => String(order.id) === id);
  if (!current) return;
  if (status === current.status) {
    $('#order-error').textContent = 'Trạng thái chưa thay đổi.';
    return;
  }
  if (status === 'cancelled' && !window.confirm(`Hủy đơn ${current.order_number}?`)) return;
  button.disabled = true;
  $('#order-error').textContent = '';
  try {
    const response = await api(`/api/admin/orders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
    state.orders = state.orders.map((order) => String(order.id) === id ? { ...order, ...response.order } : order);
    renderStats();
    renderOrders();
    renderOrderDetail(state.orders.find((order) => String(order.id) === id));
    message(`Đã cập nhật đơn ${current.order_number}: ${statuses[status]}.`, 'success');
  } catch (error) {
    $('#order-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function boot() {
  try {
    const session = await api('/api/admin/session');
    state.enabled = Boolean(session.enabled);
    state.setupAllowed = Boolean(session.setup_allowed);
    if (recoveryRequested) { showLogin(state.enabled); return; }
    if (session.authenticated) {
      if (continueToProduct()) return;
      showDashboard();
      await loadData();
    } else showLogin(state.enabled);
  } catch (error) {
    showLogin(true);
    $('#login-error').textContent = `Không kết nối được máy chủ. ${error.message}`;
  }
}
boot();
