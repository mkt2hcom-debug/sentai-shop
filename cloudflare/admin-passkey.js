'use strict';
(() => {
  // Read and scrub the secret before any other page script starts. Never put it
  // in storage, an HTML request, a query string, or a console message.
  const fragment = new URLSearchParams(location.hash.slice(1));
  let access = fragment.get('access');
  if (fragment.has('access')) history.replaceState(null, '', location.pathname + location.search);
  let bootstrapError = '', busy = false;
  async function api(path, body, authenticated = false, method = 'POST') {
    const options = { method, credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const result = authenticated ? await window.SentaiAdmin.fetch(path, options) : await fetch(path, options);
    const data = await result.json().catch(() => ({}));
    if (!result.ok) throw new Error(data.error || 'Chưa hoàn tất thao tác. Vui lòng thử lại.');
    return data;
  }
  const ready = (async () => {
    if (!access) return;
    try { await api('/api/admin/access', { token: access }); }
    catch (error) { bootstrapError = error.message; }
    finally { access = null; }
  })();
  function node(tag, text, className) {
    const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element;
  }
  function friendly(error) {
    return error?.name === 'NotAllowedError' || error?.name === 'AbortError' ? 'Bạn đã hủy xác minh hoặc thiết bị chưa sẵn sàng. Hãy thử lại.' : error?.message || 'Chưa xác minh được passkey.';
  }
  async function action(button, message, work) {
    if (busy) return;
    busy = true; button.disabled = true; message.textContent = '';
    try { await work(); } catch (error) { message.textContent = friendly(error); }
    finally { busy = false; button.disabled = button.dataset.full === 'true'; }
  }
  function renderLogin(session = {}) {
    for (const id of ['login-form', 'setup-form', 'reset-form', 'forgot-password', 'back-to-login', 'access-login']) { const element = document.getElementById(id); if (element) element.hidden = true; }
    const description = document.getElementById('login-description');
    if (description) description.textContent = 'Dùng vân tay, khuôn mặt hoặc mã khóa thiết bị.';
    let container = document.getElementById('passkey-login');
    if (!container) { container = node('div'); container.id = 'passkey-login'; document.getElementById('login-section')?.append(container); }
    container.replaceChildren(); container.hidden = false;
    const button = node('button', 'Đăng nhập bằng passkey', 'button button-primary full-width'); button.type = 'button';
    button.disabled = !session.enabled || !window.PublicKeyCredential;
    const message = node('p', bootstrapError, 'form-error'); message.setAttribute('role', 'status');
    const help = node('details'); help.append(node('summary', 'Lần đầu hoặc đổi thiết bị?'));
    help.append(node('p', 'Trên máy quản lý cửa hàng, mở START-CLOUDFLARE-ADMIN.cmd. Sau khi đăng nhập, thêm passkey để dùng lần sau.'));
    if (!window.PublicKeyCredential) message.textContent = 'Trình duyệt này chưa hỗ trợ passkey. Dùng Chrome, Edge hoặc Safari bản mới.';
    button.addEventListener('click', () => action(button, message, async () => {
      const { startAuthentication } = await import('/vendor/simplewebauthn-browser.js');
      const { options } = await api('/api/admin/passkeys/authentication/options', {});
      const result = await startAuthentication({ optionsJSON: options });
      await api('/api/admin/passkeys/authentication/verify', { response: result });
      location.reload();
    }));
    container.append(button, message, help);
  }
  function renderDashboard() {
    const login = document.getElementById('passkey-login'); if (login) login.hidden = true;
    let container = document.getElementById('passkey-settings');
    if (container) return;
    container = node('details'); container.id = 'passkey-settings'; container.className = 'panel';
    container.append(node('summary', 'Khóa đăng nhập của bạn'));
    const list = node('div'), message = node('p', '', 'form-error'); message.setAttribute('role', 'status');
    const label = node('input'); label.type = 'text'; label.maxLength = 80; label.placeholder = 'Tên thiết bị, ví dụ Điện thoại'; label.setAttribute('aria-label', 'Tên passkey');
    const button = node('button', 'Thêm passkey', 'button button-outline'); button.type = 'button';
    const refresh = async () => {
      const data = await api('/api/admin/passkeys', undefined, true, 'GET');
      list.replaceChildren();
      for (const item of data.passkeys) {
        const row = node('p'); row.append(node('span', `${item.label} `));
        const remove = node('button', 'Xóa', 'button button-outline'); remove.type = 'button'; remove.setAttribute('aria-label', `Xóa passkey ${item.label}`);
        remove.addEventListener('click', () => {
          if (!confirm(`Xóa passkey “${item.label}”? Nếu xóa hết, cần mở START-CLOUDFLARE-ADMIN.cmd để đăng nhập lại.`)) return;
          action(remove, message, async () => { await api(`/api/admin/passkeys/${encodeURIComponent(item.credential_id)}`, undefined, true, 'DELETE'); await refresh(); });
        });
        row.append(remove); list.append(row);
      }
      button.dataset.full = String(data.passkeys.length >= 5);
      button.disabled = data.passkeys.length >= 5;
      if (!data.passkeys.length) { container.open = true; list.append(node('p', 'Thêm passkey để lần sau đăng nhập ngay trên thiết bị này.')); }
    };
    button.addEventListener('click', () => action(button, message, async () => {
      const { startRegistration } = await import('/vendor/simplewebauthn-browser.js');
      const { options } = await api('/api/admin/passkeys/registration/options', {}, true);
      const result = await startRegistration({ optionsJSON: options });
      await api('/api/admin/passkeys/registration/verify', { response: result, label: label.value.trim() }, true);
      label.value = ''; await refresh(); message.textContent = 'Đã thêm passkey.';
    }));
    container.append(list, label, button, message); document.getElementById('dashboard')?.prepend(container);
    refresh().catch(error => { message.textContent = friendly(error); });
  }
  window.SentaiPasskey = Object.freeze({ ready, renderLogin, renderDashboard });
})();
