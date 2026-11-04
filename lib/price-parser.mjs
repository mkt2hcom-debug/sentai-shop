// This parser records evidence for a human price review. It never changes shop prices.
const MAX_TEXT = 24_000;
const MAX_KEYWORD = 160;
const MAX_PRICE = 1_000_000_000;

function fold(value) {
  // Preserve offsets outside Latin text (e.g. Hangul before a price).
  return String(value ?? '').replace(/\p{Script=Latin}/gu, char => char.normalize('NFD'))
    .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

export function normalizeKeyword(value) {
  return fold(String(value ?? '').slice(0, MAX_KEYWORD)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(value) {
  return new Set(fold(value).match(/[\p{L}\p{N}]+/gu) || []);
}

function matches(value, required) {
  const present = tokens(value);
  return required.length > 0 && required.every(word => present.has(word));
}

function decimal(value) {
  return Number(value.replace(',', '.'));
}

function explicitAmount(value) {
  let number = value.replace(/[\s\u00a0]/g, '');
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(number)) number = number.replace(/[.,]/g, '');
  else if (/^\d+[.,]\d{1,2}$/.test(number)) number = number.replace(',', '.');
  else if (!/^\d+$/.test(number)) return null;
  return Number(number);
}

function nearbyKind(before, after, line) {
  // Only cues immediately before an amount change its kind: “850k bao ship” is a sale.
  const context = before.slice(-65);
  const cue = /\b(coc|dat coc|tra truoc|ship|van chuyen|phi giao|combo|ca lo|tron combo|gia|ban)\b/g;
  const lastCue = [...context.matchAll(cue)].at(-1)?.[1];
  if (lastCue && /coc|tra truoc/.test(lastCue)) return 'deposit';
  if (lastCue && /ship|van chuyen|phi giao/.test(lastCue)) return 'shipping';
  if (/\b(?:combo|ca lo|tron combo)\b/.test(line)) return 'combo';
  if (/^\s*(?:tien\s+)?coc\b/.test(after)) return 'deposit';
  return 'sale';
}

function findCandidates(text) {
  const normalized = fold(text);
  const patterns = [
    { re: /(?<![a-z0-9])(?<amount>\d+(?:[.,]\d{1,3})?)[ \t\u00a0]*(?:trieu|tr)(?:[ \t\u00a0]*(?<tail>\d{1,3})(?:[ \t\u00a0]*(?<tailUnit>k|nghin|ngan))?)?(?:[ \t\u00a0]*(?:dong|vnd|d|₫))?(?![a-z0-9])/g,
      amount: m => decimal(m.groups.amount) * 1_000_000 + (m.groups.tail ? Number(m.groups.tail) * (m.groups.tailUnit ? 1_000 : 10 ** (6 - m.groups.tail.length)) : 0) },
    { re: /(?<![a-z0-9])(?<amount>\d+(?:[.,]\d{1,3})?)[ \t\u00a0]*(?:k|nghin|ngan)(?:[ \t\u00a0]*(?:dong|vnd|d|₫))?(?![a-z0-9])/g,
      amount: m => (/^\d{1,3}[.,]\d{3}$/.test(m.groups.amount) ? Number(m.groups.amount.replace(/[.,]/g, '')) : decimal(m.groups.amount)) * 1_000 },
    { re: /(?<![a-z0-9])(?<amount>\d{1,3}(?:[.,\u00a0 ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)[ \t\u00a0]*(?:vnd|vndong|dong|d|₫)(?![a-z0-9])/g,
      amount: m => explicitAmount(m.groups.amount) },
    // Unitless numbers need an explicit price label. “850” alone is ambiguous, not 850k.
    { re: /\b(?:gia(?: ban)?|gia pass|pass gia)\s*[:=\-]?\s*(?<amount>\d{1,3}(?:[.,\u00a0 ]\d{3})+|\d{5,})(?![\d.,a-z])/g,
      amount: m => explicitAmount(m.groups.amount), unitless: true },
  ];
  const found = [];
  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern.re)) {
      const start = match.index;
      const end = start + match[0].length;
      if (found.some(item => start < item.end && end > item.start)) continue;
      // Exclude telephone / SKU labels even when someone appends a currency-looking letter.
      const lineStart = normalized.lastIndexOf('\n', start - 1) + 1;
      const prefix = normalized.slice(lineStart, start);
      if (/\b(?:sdt|dt|tel|phone|zalo|sku|ma sp|ma san pham)\s*[:=\-]?\s*$/.test(prefix)) continue;
      const value = pattern.amount(match);
      if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PRICE) continue;
      if (pattern.unitless && value < 1_000) continue;
      const lineEndAt = normalized.indexOf('\n', end);
      const lineEnd = lineEndAt === -1 ? normalized.length : lineEndAt;
      const line = normalized.slice(lineStart, lineEnd);
      found.push({ start, end, lineStart, lineEnd, price_vnd: value,
        raw: text.slice(start, end).trim(),
        kind: nearbyKind(prefix, normalized.slice(end, lineEnd), line),
        excerpt: text.slice(Math.max(lineStart, start - 100), Math.min(lineEnd, end + 100)).trim() });
    }
  }
  return found.sort((a, b) => a.start - b.start).slice(0, 100);
}

function isPriceOnlyLine(line, lineCandidates) {
  let remaining = fold(line);
  for (const candidate of lineCandidates) remaining = remaining.replace(fold(candidate.raw), ' ');
  remaining = remaining.replace(/\b(?:gia|ban|pass|con|fix|bao|freeship|ship|coc|dat|tra|truoc|fullbox|full|box|vnd|dong|chot|nhe|nha|a|only)\b/g, ' ');
  return !/[a-z0-9]/.test(remaining);
}

export function analyzePost(value, keyword) {
  const input = typeof value === 'string' ? value.normalize('NFC') : '';
  const text = input.slice(0, MAX_TEXT);
  const required = [...new Set(normalizeKeyword(keyword).split(' ').filter(Boolean))];
  const matched = matches(text, required);
  const flags = new Set();
  const empty = { matched, price_vnd: null, candidates: [], flags: [], condition: '' };
  if (!matched) return empty;
  if (input.length > MAX_TEXT) flags.add('truncated');
  const normalized = fold(text);
  const all = findCandidates(text);
  const lines = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    lines.push({ text: line, start: offset, end: offset + line.length, matches: matches(line, required) });
    offset += line.length + 1;
  }
  const associated = all.filter(candidate => {
    const index = lines.findIndex(line => candidate.start >= line.start && candidate.start <= line.end);
    if (index < 0) return false;
    const line = lines[index];
    if (line.matches) {
      const boundaries = [...line.text.matchAll(/[;|•]|,(?=\s)/g)];
      const localStart = candidate.start - line.start;
      const localEnd = candidate.end - line.start;
      const clauseStart = (boundaries.filter(match => match.index < localStart).at(-1)?.index ?? -1) + 1;
      const clauseEnd = boundaries.find(match => match.index >= localEnd)?.index ?? line.text.length;
      const clause = line.text.slice(clauseStart, clauseEnd);
      if (matches(clause, required)) return true;
      return isPriceOnlyLine(clause, all.filter(item => item.start >= line.start + clauseStart && item.end <= line.start + clauseEnd));
    }
    const previous = lines[index - 1];
    return previous?.matches && isPriceOnlyLine(line.text, all.filter(item => item.lineStart === candidate.lineStart));
  });
  const relatedText = lines.filter(line => line.matches || associated.some(item => item.lineStart === line.start)).map(line => line.text).join('\n');
  // Global intent headers can be on a separate line, such as “Cần mua\nDX ...”.
  // Conservatively retain these warnings even on a mixed-product post.
  const hasAny = pattern => pattern.test(normalized);
  if (hasAny(/\b(?:da ban|sold|da bay|het hang|da chot)\b/)) flags.add('sold');
  if (hasAny(/\b(?:can mua|tim mua|thu mua|muon mua|can tim|looking for|wtb)\b/)) flags.add('wanted');
  if (hasAny(/\b(?:inbox|ib|lien he|pm)\s*(?:de\s+)?(?:biet\s+)?(?:gia|bao gia)\b|\bgia\s*(?:inbox|ib|lien he|pm)\b/)) flags.add('contact_price');
  if (hasAny(/\b(?:combo|ca lo|tron combo)\b/)) flags.add('combo');
  if (hasAny(/\b(?:coc|dat coc|tra truoc)\b/)) flags.add('deposit');
  for (const candidate of associated) if (candidate.kind !== 'sale') flags.add(candidate.kind);
  // Repeated DX names on the same target line signal several products sharing the line.
  if (lines.some(line => line.matches && (fold(line.text).match(/\bdx\b/g) || []).length > 1)) flags.add('multiple_products');
  const sale = associated.filter(candidate => candidate.kind === 'sale');
  const prices = [...new Set(sale.map(candidate => candidate.price_vnd))];
  let price = prices.length === 1 ? prices[0] : null;
  if (prices.length > 1) flags.add('multiple_prices');
  if (!associated.length && all.length) flags.add('ambiguous_association');
  if (!all.length) flags.add('no_price');
  if (['wanted', 'combo', 'multiple_products', 'contact_price', 'truncated'].some(flag => flags.has(flag))) price = null;
  if (flags.has('deposit') && !associated.some(candidate => candidate.kind === 'deposit')) price = null;
  if (price === null || flags.has('sold')) flags.add('needs_review');
  const conditionMatches = relatedText.match(/(?:full\s?box|new\s?seal|new|mới nguyên seal|mới|đã qua sử dụng|used|thiếu[^\n,;.!]{0,45}|lỗi[^\n,;.!]{0,45}|đủ phụ kiện|không hộp|có hộp)/giu) || [];
  return {
    matched: true,
    price_vnd: price,
    candidates: all.map(({ raw, price_vnd, kind, excerpt }) => ({ raw, price_vnd, kind, excerpt })),
    flags: [...flags],
    condition: [...new Set(conditionMatches.map(part => part.trim()))].join('; ').slice(0, 240),
  };
}
