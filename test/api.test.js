import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import axios from 'axios';
import { auth } from '../src/Backpack/Authenticated/Authentication.js';
import History from '../src/Backpack/Authenticated/History.js';
import Order from '../src/Backpack/Authenticated/Order.js';
import Markets from '../src/Backpack/Public/Markets.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const seed = privateKey.export({ format: 'jwk' }).d;
process.env.BACKPACK_API_SECRET = Buffer.from(seed, 'base64url').toString('base64');
process.env.BACKPACK_API_KEY = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
process.env.API_URL = 'https://api.backpack.exchange';
const originalAdapter = axios.defaults.adapter;
afterEach(() => { axios.defaults.adapter = originalAdapter; });

function captureRequest(data = []) {
  const requests = [];
  axios.defaults.adapter = async config => {
    requests.push(config);
    return { data, status: 200, statusText: 'OK', headers: {}, config };
  };
  return requests;
}

function verifyRequest(config, instruction, parameters) {
  const headers = config.headers;
  const payload = `instruction=${instruction}${parameters ? `&${parameters}` : ''}&timestamp=${headers['X-Timestamp']}&window=${headers['X-Window']}`;
  assert.ok(verify(null, Buffer.from(payload), publicKey, Buffer.from(headers['X-Signature'], 'base64')));
}

test('Ed25519 authentication matches the official cancellation signing example', () => {
  const headers = auth({ instruction: 'orderCancel', params: { symbol: 'BTC_USDT', orderId: 28 }, timestamp: 1614550000000, window: 5000 });
  verifyRequest({ headers }, 'orderCancel', 'orderId=28&symbol=BTC_USDT');
  assert.equal(headers['X-Timestamp'], '1614550000000');
});

test('position history uses the replacement route, instruction and filters', async () => {
  const rows = [{ symbol: 'SOL_USDC_PERP', cumulativePnlRealized: '1.25', unrealizedPnl: '0' }];
  const requests = captureRequest(rows);
  assert.deepEqual(await History.getPositionHistory({ symbol: 'SOL_USDC_PERP', state: 'Closed', limit: 100, sortDirection: 'Desc' }), rows);
  assert.equal(requests[0].url, `${process.env.API_URL}/wapi/v1/history/position`);
  verifyRequest(requests[0], 'positionHistoryQueryAll', 'limit=100&sortDirection=Desc&state=Closed&symbol=SOL_USDC_PERP');
});

test('interest history sends asset/source and no removed type/sources fields', async () => {
  const requests = captureRequest();
  await History.getInterestHistory({ asset: 'USDC', symbol: 'SOL_USDC_PERP', source: 'UnrealizedPnl', positionId: '42' });
  assert.deepEqual(requests[0].params, { asset: 'USDC', symbol: 'SOL_USDC_PERP', source: 'UnrealizedPnl', positionId: '42' });
  verifyRequest(requests[0], 'interestHistoryQueryAll', 'asset=USDC&positionId=42&source=UnrealizedPnl&symbol=SOL_USDC_PERP');
});

test('borrow position history sends side without throwing', async () => {
  const requests = captureRequest();
  await History.getBorrowPositionHistory('USDC', 'Borrow', 'Closed');
  assert.deepEqual(requests[0].params, { symbol: 'USDC', side: 'Borrow', state: 'Closed' });
  verifyRequest(requests[0], 'borrowPositionHistoryQueryAll', 'side=Borrow&state=Closed&symbol=USDC');
});

test('array market filters use repeated keys and sign each transmitted value', async () => {
  const requests = captureRequest();
  await History.getFillHistory(null, null, null, null, null, null, null, ['PERP', 'SPOT']);
  await History.getOrderHistory(null, null, null, null, ['PERP', 'SPOT']);
  await History.getPositionHistory({ marketType: ['PERP', 'SPOT'] });
  const instructions = ['fillHistoryQueryAll', 'orderHistoryQueryAll', 'positionHistoryQueryAll'];
  requests.forEach((config, index) => {
    assert.equal(new URL(axios.getUri(config)).search, '?marketType=PERP&marketType=SPOT');
    verifyRequest(config, instructions[index], 'marketType=PERP&marketType=SPOT');
  });
});

test('borrow sources remain a comma-separated string, not an array filter', async () => {
  const requests = captureRequest();
  await History.getBorrowHistory('USDC', null, null, null, null, null, ['Adl', 'AutoBorrow']);
  const url = new URL(axios.getUri(requests[0]));
  assert.equal(url.searchParams.get('sources'), 'Adl,AutoBorrow');
  verifyRequest(requests[0], 'borrowHistoryQueryAll', 'sources=Adl,AutoBorrow&symbol=USDC');
});

test('clientId zero works for order lookup and cancellation', async () => {
  const requests = captureRequest({ id: '42' });
  await Order.getOpenOrder('SOL_USDC_PERP', null, 0);
  await Order.cancelOpenOrder('SOL_USDC_PERP', null, 0);
  assert.equal(requests[0].params.clientId, 0);
  assert.deepEqual(JSON.parse(requests[1].data), { symbol: 'SOL_USDC_PERP', clientId: 0 });
  verifyRequest(requests[0], 'orderQuery', 'clientId=0&symbol=SOL_USDC_PERP');
  verifyRequest(requests[1], 'orderCancel', 'clientId=0&symbol=SOL_USDC_PERP');
});

test('ambiguous or absent order identifiers never send a request', async t => {
  t.mock.method(console, 'error', () => {});
  const requests = captureRequest();
  for (const method of ['getOpenOrder', 'cancelOpenOrder']) {
    assert.equal(await Order[method]('SOL_USDC_PERP'), null);
    assert.equal(await Order[method]('SOL_USDC_PERP', '42', 0), null);
  }
  assert.equal(requests.length, 0);
});

test('kline query uses Unix seconds and the requested candle interval', async t => {
  t.mock.method(Date, 'now', () => 1750000000000);
  const requests = captureRequest();
  await Markets.getKLines('SOL_USDC_PERP', '5m', 20);
  assert.deepEqual(requests[0].params, { symbol: 'SOL_USDC_PERP', interval: '5m', startTime: 1749994000, endTime: 1750000000 });
});

test('weekly and monthly candles use weeks and UTC calendar months', async t => {
  const now = Date.parse('2026-03-31T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const requests = captureRequest();
  await Markets.getKLines('SOL_USDC_PERP', '1w', 2);
  await Markets.getKLines('SOL_USDC_PERP', '1month', 1);
  assert.equal(requests[0].params.startTime, now / 1000 - 2 * 604800);
  assert.equal(requests[1].params.startTime, Date.parse('2026-02-01T00:00:00Z') / 1000);
});
