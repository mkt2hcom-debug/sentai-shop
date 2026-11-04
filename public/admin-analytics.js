'use strict';

(() => {
  const $ = selector => document.querySelector(selector);
  const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
  const number = value => new Intl.NumberFormat('vi-VN').format(Number(value) || 0);
  const vnDate = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0,10);
  const addDays = (date, amount) => new Date(Date.parse(`${date}T00:00:00Z`) + amount * 86400000).toISOString().slice(0,10);
  const dateLabel = value => { const pieces = String(value).split('-'); return pieces.length === 3 ? `${pieces[2]}/${pieces[1]}/${pieces[0]}` : pieces.length === 2 ? `${pieces[1]}/${pieces[0]}` : String(value); };
  const timestamp = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh',dateStyle:'short',timeStyle:'short'}); };
  const today = vnDate();
  const state = { authenticated:false, sequence:0, controller:null, data:null, period:0, searchTimer:null,
    filters:{from:addDays(today,-29),to:today,bucket:'day',group:'products',sort:'views',direction:'desc',search:'',limit:20,offset:0} };
  const enums = {bucket:['day','month','year'],group:['pages','products','units'],sort:['views','visits','last_view','name'],direction:['asc','desc']};
  const initial = new URLSearchParams(location.search);
  for (const key of ['from','to']) if (/^\d{4}-\d{2}-\d{2}$/.test(initial.get(key) || '')) state.filters[key] = initial.get(key);
  for (const [key, values] of Object.entries(enums)) if (values.includes(initial.get(key))) state.filters[key] = initial.get(key);
  state.filters.search = (initial.get('search') || '').slice(0,100);
  if (/^\d{1,6}$/.test(initial.get('offset') || '')) state.filters.offset = Number(initial.get('offset'));

  async function api(path, options = {}) {
    const response = await window.SentaiAdmin.fetch(path,{credentials:'same-origin',cache:'no-store',...options});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) showAuth();
      const error = new Error(body.error || `Không tải được dữ liệu (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return body;
  }
  function showAuth(session = {}) {
    state.authenticated = false;
    state.sequence++;
    state.controller?.abort();
    clearTimeout(state.searchTimer);
    clearTimeout(resizeTimer);
    state.data = null;
    $('#ranking-rows').replaceChildren();
    $('#chart').replaceChildren();
    $('#boot-status').hidden = true;
    $('#boot-error').hidden = true;
    $('#analytics-content').hidden = true;
    $('#logout').hidden = true;
    $('#auth-panel').hidden = false;
    $('#login-link').textContent = session.setup_allowed && !session.enabled ? 'Thiết lập quản trị →' : 'Đăng nhập quản trị →';
  }
  function syncControls() {
    const filters = state.filters;
    $('#date-from').value = filters.from;
    $('#date-to').value = filters.to;
    $('#ranking-search').value = filters.search;
    $('#ranking-sort').value = filters.sort;
    $('#sort-direction').textContent = filters.direction === 'asc' ? '↑' : '↓';
    $('#sort-direction').setAttribute('aria-label',filters.direction === 'asc' ? 'Đang sắp xếp tăng dần. Bấm để giảm dần.' : 'Đang sắp xếp giảm dần. Bấm để tăng dần.');
    $('#ranking-search').placeholder = filters.group === 'pages' ? 'Tìm trang…' : 'Tìm tên sản phẩm…';
    for (const key of ['bucket','group']) for (const button of document.querySelectorAll(`[data-${key}]`)) button.setAttribute('aria-pressed',String(button.dataset[key] === filters[key]));
    const current = vnDate();
    const ranges = {today:[current,current],week:[addDays(current,-6),current],month:[`${current.slice(0,7)}-01`,current],year:[`${current.slice(0,4)}-01-01`,current]};
    for (const button of document.querySelectorAll('[data-range]')) button.setAttribute('aria-pressed',String(ranges[button.dataset.range][0] === filters.from && ranges[button.dataset.range][1] === filters.to));
  }
  function validateDates(from, to) {
    const valid = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
    if (!valid(from) || !valid(to)) return 'Chọn ngày bắt đầu và kết thúc hợp lệ.';
    if (from > to) return 'Ngày bắt đầu phải trước hoặc bằng ngày kết thúc.';
    if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`))/86400000 + 1 > 3660) return 'Chọn khoảng thời gian tối đa 3.660 ngày.';
    return '';
  }
  async function load() {
    if (!state.authenticated) return;
    clearTimeout(state.searchTimer);
    const invalid = validateDates(state.filters.from,state.filters.to);
    $('#filter-error').textContent = invalid;
    $('#filter-error').hidden = !invalid;
    if (invalid) return;
    state.controller?.abort();
    const controller = new AbortController();
    state.controller = controller;
    const sequence = ++state.sequence;
    const query = new URLSearchParams(Object.entries(state.filters).map(([key,value]) => [key,String(value)]));
    $('#request-error').hidden = true;
    $('#loading-status').hidden = false;
    $('#analytics-results').setAttribute('aria-busy','true');
    $('#refresh-analytics').disabled = true;
    try {
      const data = await api(`/api/admin/analytics?${query}`,{signal:controller.signal});
      if (sequence !== state.sequence || !state.authenticated) return;
      state.data = data;
      state.period = Math.max(0,(data.timeline || []).length - 1);
      if (data.filters) state.filters = {...state.filters,...data.filters};
      syncControls();
      render();
      history.replaceState(null,'',`${location.pathname}?${new URLSearchParams(Object.entries(state.filters).map(([key,value]) => [key,String(value)]))}`);
    } catch (error) {
      if (error.name === 'AbortError' || sequence !== state.sequence || error.status === 401) return;
      $('#request-error-text').textContent = error.message;
      $('#request-error').hidden = false;
    } finally {
      if (sequence === state.sequence) {
        $('#loading-status').hidden = true;
        $('#analytics-results').setAttribute('aria-busy','false');
        $('#refresh-analytics').disabled = false;
      }
    }
  }
  function render() {
    const data = state.data;
    $('#analytics-results').hidden = false;
    $('#stat-page-views').textContent = number(data.summary?.page_views);
    $('#stat-product-views').textContent = number(data.summary?.product_views);
    $('#stat-visits').textContent = number(data.summary?.visits);
    const started = data.started_at ? new Date(data.started_at) : null;
    $('#measurement-start').textContent = `Giờ Việt Nam · UTC+7${started && !Number.isNaN(started.getTime()) ? ` · Ghi nhận từ ${started.toLocaleDateString('vi-VN',{timeZone:'Asia/Ho_Chi_Minh'})}` : ''}`;
    $('#chart-title').textContent = `Lượt xem theo ${{day:'ngày',month:'tháng',year:'năm'}[state.filters.bucket]}`;
    renderChart();
    renderRows();
  }
  function renderChart() {
    if (!state.data || !state.authenticated) return;
    const points = Array.isArray(state.data.timeline) ? state.data.timeline : [];
    const width = Math.max(240,$('#chart').clientWidth || 720), height = width < 500 ? 210 : 240, left = 44, right = 10, top = 14, bottom = 33;
    const plotWidth = width-left-right, plotHeight = height-top-bottom;
    state.chartGeometry = {width,left,plotWidth};
    const highest = Math.max(3,...points.map(point => Number(point.views) || 0));
    const max = highest < 5 ? highest : Math.ceil(highest / (10 ** Math.floor(Math.log10(highest)))) * 10 ** Math.floor(Math.log10(highest));
    const x = index => left + (index + .5) * plotWidth / Math.max(1,points.length);
    const y = value => top + plotHeight - (Math.max(0,Number(value) || 0)/max)*plotHeight;
    let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="analytics-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#a778f4" stop-opacity=".36"/><stop offset="100%" stop-color="#a778f4" stop-opacity=".02"/></linearGradient></defs>`;
    for (let index=0;index<4;index++) {
      const value = Math.round(max*index/3), py=y(value);
      svg += `<line x1="${left}" y1="${py}" x2="${width-right}" y2="${py}" stroke="#38304b" stroke-width="1" vector-effect="non-scaling-stroke"/><text x="${left-8}" y="${py+4}" text-anchor="end">${escapeHTML(number(value))}</text>`;
    }
    if (points.length <= 90) {
      const barWidth = Math.max(1,Math.min(26,plotWidth / Math.max(1,points.length)*.63));
      for (let index=0;index<points.length;index++) {
        const point=points[index], base=y(0), barX=x(index)-barWidth/2;
        svg += `<rect x="${barX}" y="${y(point.views)}" width="${barWidth}" height="${Math.max(0,base-y(point.views))}" rx="2" fill="#a778f4"/><rect x="${barX}" y="${y(point.product_views)}" width="${barWidth}" height="${Math.max(0,base-y(point.product_views))}" rx="2" fill="#6dd2dc" fill-opacity=".85"/>`;
      }
    } else {
      const line = key => points.map((point,index) => `${index?'L':'M'}${x(index)},${y(point[key])}`).join(' ');
      svg += `<path d="${line('views')} L${x(points.length-1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#analytics-area)"/><path d="${line('views')}" fill="none" stroke="#b185f5" stroke-width="2" vector-effect="non-scaling-stroke"/><path d="${line('product_views')}" fill="none" stroke="#6dd2dc" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
    }
    const ticks = [...new Set(width < 500 ? [0,Math.floor((points.length-1)/2),points.length-1] : [0,Math.floor((points.length-1)/3),Math.floor(2*(points.length-1)/3),points.length-1])].filter(index => index>=0 && points[index]);
    const labels = ticks.map(index => {
      const parts = String(points[index].period).split('-');
      const text = parts.length === 3 ? `${parts[2]}/${parts[1]}` : dateLabel(points[index].period);
      const labelWidth = Math.max(28,text.length*6.5);
      const center = Math.max(left+labelWidth/2,Math.min(width-right-labelWidth/2,x(index)));
      return {index,text,center,start:center-labelWidth/2,end:center+labelWidth/2};
    });
    const visibleLabels = [];
    // Reserve both ends, then keep middle labels only when there is room.
    for (const label of [labels[0],labels.at(-1),...labels.slice(1,-1)]) {
      if (!label || visibleLabels.some(other => other.index === label.index || !(label.end+12 <= other.start || other.end+12 <= label.start))) continue;
      visibleLabels.push(label);
    }
    for (const label of visibleLabels.sort((a,b) => a.index-b.index)) svg += `<text data-axis-period x="${label.center}" y="${height-8}" text-anchor="middle">${escapeHTML(label.text)}</text>`;
    svg += `<line id="chart-cursor" x1="0" y1="${top}" x2="0" y2="${y(0)}" stroke="#efe0ff" stroke-dasharray="4 4" stroke-opacity=".7" vector-effect="non-scaling-stroke"/></svg>`;
    $('#chart').innerHTML = svg;
    $('#chart-empty').hidden = points.some(point => Number(point.views)>0);
    selectPeriod(state.period);
  }
  function selectPeriod(index) {
    const points = state.data?.timeline || [];
    state.period = Math.max(0,Math.min(points.length-1,index));
    const point = points[state.period];
    $('#previous-period').disabled = !point || state.period <= 0;
    $('#next-period').disabled = !point || state.period >= points.length-1;
    if (!point) { $('#chart-readout').textContent = 'Chưa có dữ liệu'; return; }
    $('#chart-readout').innerHTML = `<strong>${escapeHTML(dateLabel(point.period))}</strong><br><span>${number(point.views)} lượt xem</span> · <span>${number(point.product_views)} sản phẩm</span> · <span>${number(point.visits)} phiên</span>`;
    const geometry = state.chartGeometry || {left:44,plotWidth:666};
    const x = geometry.left+(state.period+.5)*geometry.plotWidth/Math.max(1,points.length);
    $('#chart-cursor')?.setAttribute('x1',String(x));
    $('#chart-cursor')?.setAttribute('x2',String(x));
    $('#chart').setAttribute('aria-label',`Biểu đồ lượt xem theo ${{day:'ngày',month:'tháng',year:'năm'}[state.filters.bucket]}. ${dateLabel(point.period)}: ${number(point.views)} lượt xem, ${number(point.product_views)} trang sản phẩm, ${number(point.visits)} phiên. Dùng mũi tên trái và phải để chọn kỳ.`);
  }
  function safePath(row) {
    if (row.path === '/') return '/';
    if (typeof row.path === 'string' && /^\/products\/[a-zA-Z0-9_-]+(?:\?variant=[a-zA-Z0-9_-]+)?$/.test(row.path)) return row.path;
    return '';
  }
  function renderRows() {
    const rows = Array.isArray(state.data.rows) ? state.data.rows : [];
    const total = Number(state.data.total_rows) || 0;
    const offset = Number(state.filters.offset) || 0, limit=Number(state.filters.limit) || 20;
    $('#ranking-count').textContent = `${number(total)} kết quả`;
    $('#ranking-rows').innerHTML = rows.map((row,index) => {
      const path = safePath(row);
      const title = path ? `<a href="${escapeHTML(path)}" target="_blank" rel="noopener noreferrer">${escapeHTML(row.name || row.path)} ↗</a>` : `<strong>${escapeHTML(row.name || row.path)}</strong>`;
      const sub = state.filters.group === 'units' ? row.product_id || '' : row.page_type === 'home' ? 'Trang chủ' : 'Trang sản phẩm';
      return `<tr role="row"><td role="cell"><div class="rank-name"><span class="rank-number">${number(offset+index+1)}</span><div>${title}<small>${escapeHTML(sub)}</small></div></div></td><td role="cell"><span class="rank-mobile-label">Lượt xem</span><span class="rank-value">${number(row.views)}</span></td><td role="cell"><span class="rank-mobile-label">Phiên</span><span class="rank-value">${number(row.visits)}</span></td><td role="cell"><span class="rank-mobile-label">Gần nhất</span>${escapeHTML(timestamp(row.last_view))}</td></tr>`;
    }).join('');
    $('#ranking-empty').hidden = rows.length>0;
    $('#ranking-pagination').hidden = total<=limit;
    $('#page-count').textContent = total ? `${number(offset+1)}–${number(Math.min(total,offset+rows.length))} / ${number(total)}` : '0 kết quả';
    $('#previous-page').disabled = offset<=0;
    $('#next-page').disabled = offset+limit>=total;
  }
  function changed() { state.filters.offset=0; syncControls(); load(); }
  $('#date-form').addEventListener('submit',event => {
    event.preventDefault();
    const from=$('#date-from').value,to=$('#date-to').value,error=validateDates(from,to);
    $('#filter-error').textContent=error;$('#filter-error').hidden=!error;
    if(error)return;
    state.filters.from=from;state.filters.to=to;changed();
  });
  for(const button of document.querySelectorAll('[data-range]')) button.addEventListener('click',() => {
    const now=vnDate(),range=button.dataset.range;
    state.filters.to=now;
    state.filters.from=range==='today'?now:range==='week'?addDays(now,-6):range==='month'?`${now.slice(0,7)}-01`:`${now.slice(0,4)}-01-01`;
    state.filters.bucket=range==='year'?'month':'day';changed();
  });
  for(const button of document.querySelectorAll('[data-bucket]')) button.addEventListener('click',() => {state.filters.bucket=button.dataset.bucket;changed();});
  for(const button of document.querySelectorAll('[data-group]')) button.addEventListener('click',() => {state.filters.group=button.dataset.group;changed();});
  $('#ranking-search').addEventListener('input',() => {clearTimeout(state.searchTimer);state.controller?.abort();state.sequence++;state.filters.search=$('#ranking-search').value.trim();state.filters.offset=0;state.searchTimer=setTimeout(load,300);});
  $('#ranking-sort').addEventListener('change',() => {state.filters.sort=$('#ranking-sort').value;state.filters.direction=state.filters.sort==='name'?'asc':'desc';changed();});
  $('#sort-direction').addEventListener('click',() => {state.filters.direction=state.filters.direction==='asc'?'desc':'asc';changed();});
  $('#previous-page').addEventListener('click',() => {state.filters.offset=Math.max(0,state.filters.offset-state.filters.limit);load();});
  $('#next-page').addEventListener('click',() => {state.filters.offset+=state.filters.limit;load();});
  $('#previous-period').addEventListener('click',() => selectPeriod(state.period-1));
  $('#next-period').addEventListener('click',() => selectPeriod(state.period+1));
  $('#chart').addEventListener('click',event => {const bounds=$('#chart').getBoundingClientRect(),geometry=state.chartGeometry;if(!geometry)return;selectPeriod(Math.floor(((event.clientX-bounds.left)/bounds.width*geometry.width-geometry.left)/geometry.plotWidth*(state.data?.timeline?.length || 0)));});
  $('#chart').addEventListener('keydown',event => {if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();selectPeriod(event.key==='Home'?0:event.key==='End'?(state.data?.timeline?.length||1)-1:state.period+(event.key==='ArrowRight'?1:-1));}});
  $('#refresh-analytics').addEventListener('click',load);
  $('#retry-request').addEventListener('click',load);
  $('#retry-boot').addEventListener('click',boot);
  $('#logout').addEventListener('click',async () => {
    $('#logout').disabled=true;
    try {await api('/api/admin/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});showAuth();}
    catch(error){$('#request-error-text').textContent=error.message;$('#request-error').hidden=false;}
    finally{$('#logout').disabled=false;}
  });
  async function boot() {
    $('#boot-error').hidden=true;$('#boot-status').hidden=false;
    try {
      const session=await api('/api/admin/session');
      if(!session.authenticated)return showAuth(session);
      state.authenticated=true;$('#boot-status').hidden=true;$('#auth-panel').hidden=true;$('#analytics-content').hidden=false;$('#logout').hidden=false;
      syncControls();await load();
    } catch(error){if(error.status===401)return;$('#boot-status').hidden=true;$('#boot-error-text').textContent=error.message;$('#boot-error').hidden=false;}
  }
  let resizeTimer,chartWidth=0;
  new ResizeObserver(entries => {
    const width=entries[0].contentRect.width;
    if(width===chartWidth || width===0)return;
    chartWidth=width;
    clearTimeout(resizeTimer);
    if(state.data)resizeTimer=setTimeout(renderChart,80);
  }).observe($('#chart'));
  boot();
})();
