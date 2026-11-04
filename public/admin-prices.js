'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
  const money = value => Number.isSafeInteger(value) && value > 0 ? new Intl.NumberFormat('vi-VN', { style:'currency', currency:'VND', maximumFractionDigits:0 }).format(value) : 'Chưa xác định được giá';
  const date = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleString('vi-VN', { timeZone:'Asia/Ho_Chi_Minh', dateStyle:'short', timeStyle:'short' }) : 'Chưa rõ ngày';
  const state = { data:null, products:[], authenticated:false, loading:false, refreshWaiters:[], timer:null, sourceKey:'', referenceKey:'' };
  const jobLabels = { queued:'Đang chờ', running:'Đang tìm bài', completed:'Đã kết thúc', partial:'Kết quả một phần', needs_login:'Cần đăng nhập', failed:'Không lấy được bài' };
  const reviewLabels = { pending:'Cần kiểm tra', accepted:'Đã kiểm tra', ignored:'Bỏ qua' };
  const flagLabels = { needs_review:'Cần đối chiếu giá', ambiguous:'Nhiều mức giá', multiple_prices:'Nhiều mức giá', multiple_products:'Bài có nhiều sản phẩm', sold:'Có ghi đã bán', sold_out:'Có ghi đã bán', buying:'Bài tìm mua', wanted:'Bài tìm mua', deposit:'Có tiền cọc', shipping:'Có phí vận chuyển', combo:'Giá combo', contact_price:'Liên hệ để hỏi giá', no_price:'Chưa thấy giá rõ ràng', price_not_found:'Chưa thấy giá rõ ràng', no_local_price:'Giá chưa gắn rõ với món', ambiguous_association:'Giá chưa gắn rõ với món', variant_mismatch:'Cần kiểm tra phiên bản', article_text:'Nội dung cần đối chiếu bài gốc', truncated:'Nội dung chưa đầy đủ' };
  const kindLabels = { sale:'Giá bán', deposit:'Tiền cọc', shipping:'Phí vận chuyển', combo:'Giá combo', unknown:'Cần đối chiếu' };
  const activeJobs = () => (state.data?.scans || []).some(scan => ['queued','running'].includes(scan.status));

  function facebookURL(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !['facebook.com','www.facebook.com','m.facebook.com','web.facebook.com'].includes(url.hostname) || url.username || url.password || url.port) return '';
      if (!/^\/groups\/[a-zA-Z0-9._-]+(?:\/|$)/.test(url.pathname) && url.pathname !== '/permalink.php') return '';
      return url.href;
    } catch { return ''; }
  }
  function notice(text, kind = '') {
    $('#page-message').textContent = text;
    $('#page-message').className = `notice ${kind}`;
    $('#page-message').hidden = !text;
  }
  function toLogin() {
    clearTimeout(state.timer);
    state.authenticated = false;
    $('#prices-content').hidden = true;
    location.replace('/admin?next=%2Fadmin%2Fprices');
  }
  async function api(path, options = {}) {
    const response = await window.SentaiAdmin.fetch(path, { credentials:'same-origin', cache:'no-store', ...options, headers:{ 'Content-Type':'application/json', ...options.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) toLogin();
      throw new Error(body.error || `Không thể hoàn tất yêu cầu (${response.status}).`);
    }
    return body;
  }
  function optionList(node, list, placeholder) {
    const previous = node.value;
    node.innerHTML = `<option value="">${escapeHTML(placeholder)}</option>${list.map(item => `<option value="${escapeHTML(item.id)}">${escapeHTML(item.label)}</option>`).join('')}`;
    if ([...node.options].some(option => option.value === previous)) node.value = previous;
  }
  function filterSources(items, observations, idKey, labelKey) {
    const found = new Map(items.map(item => [item.id, item.label]));
    for (const item of observations) if (item[idKey] && !found.has(item[idKey])) found.set(item[idKey], item[labelKey] || 'Nguồn đã ngừng theo dõi');
    return [...found].map(([id,label]) => ({ id,label }));
  }
  function renderSources() {
    const groups = (state.data.groups || []).filter(group => group.active !== 0);
    const keywords = (state.data.keywords || []).filter(keyword => keyword.active !== 0);
    const observations = state.data.observations || [];
    const groupsList = groups.map(group => ({ id:group.id,label:group.name }));
    const keywordList = keywords.map(keyword => ({ id:keyword.id,label:keyword.keyword }));
    const sourceKey = JSON.stringify({ groups, keywords, filterGroups:filterSources(groupsList, observations, 'group_id','group_name'), filterKeywords:filterSources(keywordList, observations, 'keyword_id','keyword') });
    if (sourceKey !== state.sourceKey) {
      state.sourceKey = sourceKey;
      const selectedGroups = new Set([...document.querySelectorAll('input[name="scan-group"]:checked')].map(input => input.value));
      $('#group-list').innerHTML = groups.map(group => {
        const url = facebookURL(group.url);
        return `<li><div>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(group.name)} ↗</a>` : `<strong>${escapeHTML(group.name)}</strong>`}<small>${escapeHTML(group.url)}</small></div><button type="button" class="remove-source" data-remove-group="${escapeHTML(group.id)}" aria-label="Ngừng theo dõi nhóm ${escapeHTML(group.name)}">Ngừng theo dõi</button></li>`;
      }).join('');
      $('#keyword-list').innerHTML = keywords.map(keyword => `<li><div><strong>${escapeHTML(keyword.keyword)}</strong><small>${escapeHTML(keyword.product_name || 'Chưa gắn sản phẩm')}</small></div><button type="button" class="remove-source" data-remove-keyword="${escapeHTML(keyword.id)}" aria-label="Ngừng theo dõi từ khóa ${escapeHTML(keyword.keyword)}">Ngừng theo dõi</button></li>`).join('');
      $('#scan-groups').innerHTML = groups.length ? groups.map(group => `<label><input type="checkbox" name="scan-group" value="${escapeHTML(group.id)}" ${selectedGroups.has(group.id) ? 'checked' : ''}><span>${escapeHTML(group.name)}</span></label>`).join('') : '<p class="quiet-empty">Lưu nhóm ở bước 02 để chọn.</p>';
      for (const selector of ['#scan-keyword','#import-keyword']) optionList($(selector), keywordList, 'Chọn từ khóa');
      optionList($('#import-group'), groupsList, 'Chọn nhóm');
      optionList($('#filter-group'), filterSources(groupsList, observations, 'group_id','group_name'), 'Tất cả nhóm');
      optionList($('#filter-keyword'), filterSources(keywordList, observations, 'keyword_id','keyword'), 'Tất cả từ khóa');
      $('#groups-empty').hidden = groups.length > 0;
      $('#keywords-empty').hidden = keywords.length > 0;
    }
    $('#start-scan').disabled = !groups.length || !keywords.length || !state.data.collector?.available || Boolean(state.data.collector?.login_open);
  }
  function renderCollector() {
    const collector = state.data.collector || {};
    $('#collector-status').textContent = collector.login_open ? 'Cửa sổ Facebook đang mở. Hoàn tất đăng nhập rồi đóng cửa sổ để bắt đầu tìm.' : collector.message || (collector.available ? 'Bộ thu thập đã sẵn sàng. Đăng nhập Facebook trước lượt tìm đầu tiên.' : 'Bộ thu thập chưa sẵn sàng. Cần thiết lập trên máy chủ trước khi tìm tự động.');
    $('#facebook-login').disabled = !collector.available || Boolean(collector.busy) || Boolean(collector.login_open) || activeJobs();
    $('#facebook-login').textContent = collector.login_open ? 'Đang mở cửa sổ Facebook…' : 'Mở Facebook để đăng nhập ↗';
  }
  function renderScans() {
    const scans = state.data.scans || [];
    $('#scan-count').textContent = String(scans.length);
    $('#scans-empty').hidden = scans.length > 0;
    $('#scan-list').innerHTML = scans.slice(0,12).map(scan => {
      const status = Object.hasOwn(jobLabels, scan.status) ? scan.status : 'failed';
      const count = Math.max(0, Number(scan.post_count) || 0);
      const fallback = status === 'queued' ? 'Đang chờ đến lượt.' : status === 'running' ? 'Đang đọc kết quả tìm kiếm trong nhóm.' : status === 'needs_login' ? 'Mở Facebook trên máy này, đăng nhập rồi tạo lượt tìm mới.' : status === 'failed' ? 'Chưa lấy được dữ liệu. Kiểm tra quyền xem nhóm và thử lại.' : count ? `Đã ghi nhận ${count} bài phù hợp. Mở các kết quả bên dưới để đối chiếu.` : 'Lượt này chưa ghi nhận bài phù hợp. Điều này không có nghĩa nhóm không có bài bán sản phẩm.';
      return `<article class="scan-item"><div><strong>${escapeHTML(scan.keyword)} · ${escapeHTML(scan.group_name || 'Hội nhóm')}</strong><small>${escapeHTML(date(scan.created_at))} · ${count} bài lưu</small><small class="scan-description">${escapeHTML(scan.error || scan.message || fallback)}</small></div><span class="scan-status ${status}">${escapeHTML(jobLabels[status])}</span></article>`;
    }).join('');
  }
  function renderReferences(force = false) {
    const observations = state.data.observations || [];
    const filters = { group:$('#filter-group').value,keyword:$('#filter-keyword').value,review:$('#filter-review').value };
    const total = Math.max(observations.length, Number(state.data.observation_total) || 0);
    const key = JSON.stringify({ observations,filters,total });
    if (!force && key === state.referenceKey) return;
    state.referenceKey = key;
    const visible = observations.filter(item => (!filters.group || item.group_id === filters.group) && (!filters.keyword || item.keyword_id === filters.keyword) && (!filters.review || item.review_status === filters.review));
    $('#reference-count').textContent = `${visible.length} / ${observations.length}`;
    $('#references-limit').hidden = total <= observations.length;
    $('#references-limit').textContent = `Đang hiển thị ${observations.length} bài được cập nhật gần nhất trong ${total} bài đã lưu. Bộ lọc áp dụng cho những bài đang hiển thị.`;
    $('#references-empty').hidden = visible.length > 0;
    $('#references-empty').textContent = observations.length ? 'Chưa có bài phù hợp với bộ lọc này.' : 'Chưa có bài được lưu. Bắt đầu một lượt tìm hoặc dán nội dung bài phía dưới.';
    const opened = new Set([...document.querySelectorAll('.reference-content[open]')].map(node => node.dataset.reference));
    $('#reference-list').innerHTML = visible.map(item => {
      const review = Object.hasOwn(reviewLabels, item.review_status) ? item.review_status : 'pending';
      const url = facebookURL(item.post_url);
      const candidates = Array.isArray(item.candidates) ? item.candidates : [];
      const flags = [...new Set(Array.isArray(item.flags) ? item.flags : [])];
      const excerpt = candidates.find(candidate => candidate.price_vnd === item.price_vnd)?.excerpt || candidates[0]?.excerpt || '';
      const verifiedPrice = Number.isSafeInteger(item.price_vnd) && item.price_vnd > 0;
      return `<article class="reference-card ${review}"><div class="reference-top"><div><h3>${escapeHTML(item.product_name || item.keyword || 'Bài viết sản phẩm')}</h3><p>${escapeHTML(item.group_name || 'Hội nhóm')} · Từ khóa: ${escapeHTML(item.keyword)}</p></div><span class="reference-review ${review}">${escapeHTML(reviewLabels[review])}</span></div><p class="reference-price ${verifiedPrice ? '' : 'undetermined'}">${escapeHTML(money(item.price_vnd))}</p>${flags.length ? `<div class="reference-flags">${flags.map(flag => `<span>${escapeHTML(flagLabels[flag] || flag)}</span>`).join('')}</div>` : ''}${item.condition ? `<p class="muted">Tình trạng trong bài: ${escapeHTML(item.condition)}</p>` : ''}${excerpt ? `<blockquote class="price-excerpt">${escapeHTML(excerpt)}</blockquote>` : ''}${!verifiedPrice && candidates.length ? `<ul class="candidate-list">${candidates.map(candidate => `<li>${escapeHTML(kindLabels[candidate.kind] || 'Cần đối chiếu')}: ${escapeHTML(money(candidate.price_vnd))} <span>(${escapeHTML(candidate.raw)})</span></li>`).join('')}</ul>` : ''}<p class="reference-meta">Ngày đăng: ${escapeHTML(item.published_at ? date(item.published_at) : item.published_text || 'Chưa rõ ngày')}<br>Lưu lúc: ${escapeHTML(date(item.fetched_at))}</p><details class="reference-content" data-reference="${escapeHTML(item.id)}" ${opened.has(item.id) ? 'open' : ''}><summary>Xem nội dung đã lưu</summary><pre>${escapeHTML(item.text)}</pre></details><div class="reference-actions">${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Mở bài gốc ↗</a>` : '<span class="muted">Chưa có link bài hợp lệ</span>'}<div class="review-buttons">${review !== 'accepted' ? `<button type="button" class="button button-outline" data-review="accepted" data-observation="${escapeHTML(item.id)}">Đã kiểm tra</button>` : ''}${review !== 'ignored' ? `<button type="button" class="button button-outline" data-review="ignored" data-observation="${escapeHTML(item.id)}">Bỏ qua</button>` : ''}${review !== 'pending' ? `<button type="button" class="button button-outline" data-review="pending" data-observation="${escapeHTML(item.id)}">Kiểm tra lại</button>` : ''}</div></div></article>`;
    }).join('');
  }
  function schedulePoll() {
    clearTimeout(state.timer);
    if (state.authenticated && (activeJobs() || state.data?.collector?.login_open)) state.timer = setTimeout(() => refresh(true), 3000);
  }
  async function refresh(silent = false) {
    if (!state.authenticated) return;
    if (state.loading) {
      await new Promise(resolve => state.refreshWaiters.push(resolve));
      return refresh(silent);
    }
    state.loading = true;
    $('#refresh-prices').disabled = true;
    try {
      state.data = await api('/api/admin/prices');
      renderSources(); renderCollector(); renderScans(); renderReferences();
      $('#load-error').hidden = true;
      $('#prices-content').hidden = false;
      if (!silent) notice('');
    } catch (error) {
      if (!state.data) { $('#load-error-message').textContent = error.message; $('#load-error').hidden = false; }
      else notice(`Chưa làm mới được dữ liệu. ${error.message}`, 'error');
    } finally {
      state.loading = false;
      for (const resolve of state.refreshWaiters.splice(0)) resolve();
      $('#refresh-prices').disabled = false;
      schedulePoll();
    }
  }
  async function runAction(button, errorSelector, work) {
    if (button.disabled) return;
    button.disabled = true;
    if (errorSelector) $(errorSelector).textContent = '';
    try { await work(); }
    catch (error) { if (errorSelector) $(errorSelector).textContent = error.message; else notice(error.message, 'error'); }
    finally { button.disabled = false; if (state.data) { renderCollector(); renderSources(); } }
  }
  $('#group-form').addEventListener('submit', event => {
    event.preventDefault();
    runAction(event.submitter, '#group-error', async () => {
      await api('/api/admin/prices/groups', { method:'POST',body:JSON.stringify({ name:$('#group-name').value.trim(),url:$('#group-url').value.trim() }) });
      $('#group-form').reset(); await refresh(true); notice('Đã lưu hội nhóm.', 'success');
    });
  });
  $('#keyword-product').addEventListener('change', () => {
    const product = state.products.find(item => item.id === $('#keyword-product').value);
    if (product) $('#keyword-text').value = product.name.slice(0,120);
  });
  $('#keyword-form').addEventListener('submit', event => {
    event.preventDefault();
    runAction(event.submitter, '#keyword-error', async () => {
      const keyword = $('#keyword-text').value.trim();
      await api('/api/admin/prices/keywords', { method:'POST',body:JSON.stringify({ keyword,product_id:$('#keyword-product').value || null }) });
      $('#keyword-form').reset(); await refresh(true);
      const saved = state.data.keywords.find(item => item.keyword === keyword);
      if (saved) $('#scan-keyword').value = saved.id;
      notice('Đã lưu từ khóa sản phẩm.', 'success');
    });
  });
  for (const [selector, attribute, path] of [['#group-list','removeGroup','groups'],['#keyword-list','removeKeyword','keywords']]) {
    $(selector).addEventListener('click', event => {
      const button = event.target.closest('button');
      if (!button?.dataset[attribute]) return;
      runAction(button, null, async () => {
        await api(`/api/admin/prices/${path}/${encodeURIComponent(button.dataset[attribute])}`, { method:'DELETE' });
        await refresh(true); notice('Đã ngừng theo dõi. Các bài đã lưu vẫn được giữ lại.', 'success');
      });
    });
  }
  $('#scan-form').addEventListener('submit', event => {
    event.preventDefault();
    runAction(event.submitter, '#scan-error', async () => {
      const group_ids = [...document.querySelectorAll('input[name="scan-group"]:checked')].map(input => input.value);
      if (!group_ids.length || group_ids.length > 3) throw new Error('Chọn từ 1 đến 3 nhóm cho mỗi lượt tìm.');
      await api('/api/admin/prices/scans', { method:'POST',body:JSON.stringify({ group_ids,keyword_id:$('#scan-keyword').value,max_posts:Number($('#scan-limit').value) }) });
      await refresh(true); notice('Đã xếp lượt tìm. Bạn có thể theo dõi tiến trình và quay lại xem kết quả.', 'success');
    });
  });
  $('#facebook-login').addEventListener('click', event => runAction(event.currentTarget, null, async () => {
    await api('/api/admin/prices/login', { method:'POST',body:'{}' });
    await refresh(true); notice('Đăng nhập trong cửa sổ Facebook trên máy chạy website, rồi đóng cửa sổ đó.', 'success');
  }));
  $('#import-form').addEventListener('submit', event => {
    event.preventDefault();
    runAction(event.submitter, '#import-error', async () => {
      await api('/api/admin/prices/import', { method:'POST',body:JSON.stringify({ group_id:$('#import-group').value,keyword_id:$('#import-keyword').value,post_url:$('#import-url').value.trim(),text:$('#import-text').value.trim(),published_text:$('#import-date').value.trim() }) });
      $('#import-url').value = ''; $('#import-text').value = ''; $('#import-date').value = '';
      await refresh(true); notice('Đã phân tích và lưu bài để đối chiếu giá.', 'success');
    });
  });
  $('#reference-list').addEventListener('click', event => {
    const button = event.target.closest('[data-review]');
    if (!button) return;
    runAction(button, null, async () => {
      await api(`/api/admin/prices/observations/${encodeURIComponent(button.dataset.observation)}`, { method:'PATCH',body:JSON.stringify({ review_status:button.dataset.review }) });
      await refresh(true); notice('Đã cập nhật trạng thái kiểm tra tư liệu.', 'success');
    });
  });
  for (const selector of ['#filter-group','#filter-keyword','#filter-review']) $(selector).addEventListener('change', () => renderReferences());
  $('#refresh-prices').addEventListener('click', () => refresh());
  $('#retry-load').addEventListener('click', () => boot());
  $('#logout').addEventListener('click', event => runAction(event.currentTarget, null, async () => { await api('/api/admin/logout',{ method:'POST',body:'{}' }); toLogin(); }));
  window.addEventListener('pagehide', () => clearTimeout(state.timer));
  async function boot() {
    $('#boot-status').hidden = false;
    $('#load-error').hidden = true;
    try {
      const session = await api('/api/admin/session');
      if (!session.authenticated) { toLogin(); return; }
      state.authenticated = true;
      $('#logout').hidden = false;
      const products = await api('/api/admin/products');
      state.products = products.products || [];
      optionList($('#keyword-product'), state.products.map(product => ({ id:product.id,label:`${product.name}${product.series ? ` · ${product.series}` : ''}` })), 'Chưa gắn sản phẩm');
      await refresh();
    } catch (error) { $('#load-error-message').textContent = error.message; $('#load-error').hidden = false; }
    finally { $('#boot-status').hidden = true; }
  }
  boot();
})();
