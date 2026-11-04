import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzePost, normalizeKeyword } from '../lib/price-parser.mjs';

test('Vietnamese prices retain explicit units and normalize to VND', () => {
  for (const [raw, expected] of [
    ['850k', 850000], ['1tr2', 1200000], ['1tr200', 1200000], ['1.2tr', 1200000],
    ['1,2 triệu', 1200000], ['1.200.000đ', 1200000], ['850000 VND', 850000],
    ['850 nghìn', 850000], ['1tr050', 1050000], ['1 200 000 đồng', 1200000],
    ['1tr2k', 1002000],
  ]) {
    const result = analyzePost(`DX Kiramaizin fullbox giá ${raw}`, 'DX Kiramaizin');
    assert.equal(result.matched, true, raw);
    assert.equal(result.price_vnd, expected, raw);
    assert.equal(result.candidates.length, 1, raw);
    assert.equal(result.condition, 'fullbox', raw);
  }
});

test('keyword matching ignores Vietnamese accents while retaining token boundaries and edition', () => {
  assert.equal(normalizeKeyword('  ĐỒ CHƠI —  Kiramaizin  '), 'do choi kiramaizin');
  assert.equal(analyzePost('Đồ chơi DX Kiramaizin giá 850k', 'do choi kiramaizin').matched, true);
  assert.equal(analyzePost('MiniPla Kiramaizin giá 850k', 'DX Kiramaizin').matched, false);
  assert.equal(analyzePost('DX KiramaizinExtra giá 850k', 'DX Kiramaizin').matched, false);
  assert.equal(analyzePost('DX Kiramaizin giá 850k', '').matched, false);
});

test('phones, dates, model numbers and unknown units do not turn into prices', () => {
  for (const body of [
    'DX Kiramaizin mã 850, ra mắt 2020, zalo 0326931693',
    'DX Kiramaizin 12/03/2026. SĐT: 0326931693',
    'DX Kiramaizin SKU: 12345K',
    'DX Kiramaizin giá 850',
    'DX Kiramaizin giá 2 tỷ',
  ]) {
    const result = analyzePost(body, 'DX Kiramaizin');
    assert.equal(result.price_vnd, null, body);
    assert.deepEqual(result.candidates, [], body);
    assert.ok(result.flags.includes('no_price'), body);
  }
  assert.equal(analyzePost('DX Kiramaizin giá 850.000', 'DX Kiramaizin').price_vnd, 850000);
  assert.equal(analyzePost('로봇 DX Kiramaizin giá 850k', 'DX Kiramaizin').price_vnd, 850000);
});

test('unrelated product prices are never selected for a matching product', () => {
  const separate = analyzePost('DX Kiramaizin fullbox\nDX Ryusoulger giá 900k', 'DX Kiramaizin');
  assert.equal(separate.price_vnd, null);
  assert.ok(separate.flags.includes('ambiguous_association'));
  const related = analyzePost('DX Kiramaizin fullbox\nGiá 850k bao ship\nDX Ryusoulger giá 900k', 'DX Kiramaizin');
  assert.equal(related.price_vnd, 850000);
  const sameLine = analyzePost('DX Kiramaizin fullbox, DX Ryusoulger giá 900k', 'DX Kiramaizin');
  assert.equal(sameLine.price_vnd, null);
  assert.ok(sameLine.flags.includes('multiple_products'));
  const noEdition = analyzePost('Kiramaizin fullbox, King Express giá 900k', 'Kiramaizin');
  assert.equal(noEdition.price_vnd, null);
  assert.ok(noEdition.flags.includes('ambiguous_association'));
});

test('shipping and deposits remain distinct from the sale price', () => {
  const sale = analyzePost('DX Kiramaizin giá 850k, ship 30k, cọc 200k', 'DX Kiramaizin');
  assert.equal(sale.price_vnd, 850000);
  assert.deepEqual(sale.candidates.map(item => item.kind), ['sale', 'shipping', 'deposit']);
  const deposit = analyzePost('DX Kiramaizin cọc 200k', 'DX Kiramaizin');
  assert.equal(deposit.price_vnd, null);
  assert.ok(deposit.flags.includes('deposit'));
  const freeShipping = analyzePost('DX Kiramaizin 850k bao ship', 'DX Kiramaizin');
  assert.equal(freeShipping.price_vnd, 850000);
  const depositHeader = analyzePost('Nhận cọc trước\nDX Kiramaizin 850k', 'DX Kiramaizin');
  assert.equal(depositHeader.price_vnd, null);
  assert.ok(depositHeader.flags.includes('deposit'));
});

test('unclear amounts and non-sale posts remain reviewable evidence', () => {
  const cases = [
    ['DX Kiramaizin giá 850k hoặc 900k', 'multiple_prices'],
    ['Cần mua DX Kiramaizin giá 850k', 'wanted'],
    ['Cần mua\nDX Kiramaizin giá 850k', 'wanted'],
    ['Combo DX Kiramaizin và King Express 1tr2', 'combo'],
    ['DX Kiramaizin inbox giá', 'contact_price'],
  ];
  for (const [text, flag] of cases) {
    const result = analyzePost(text, 'DX Kiramaizin');
    assert.equal(result.matched, true);
    assert.equal(result.price_vnd, null, text);
    assert.ok(result.flags.includes(flag), text);
    assert.ok(result.flags.includes('needs_review'), text);
  }
  const sold = analyzePost('DX Kiramaizin 850k đã bán', 'DX Kiramaizin');
  assert.equal(sold.price_vnd, 850000);
  assert.ok(sold.flags.includes('sold'));
  assert.ok(sold.flags.includes('needs_review'));
});

test('hostile or excessively long text stays bounded and prices stay within range', () => {
  const huge = analyzePost('DX Kiramaizin 850k\n' + 'a'.repeat(30000), 'DX Kiramaizin');
  assert.equal(huge.price_vnd, null);
  assert.ok(huge.flags.includes('truncated'));
  assert.equal(analyzePost('DX Kiramaizin 1001tr', 'DX Kiramaizin').price_vnd, null);
  assert.equal(analyzePost(null, 'DX Kiramaizin').matched, false);
});
