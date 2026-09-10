import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';

// Strategy modules load dotenv on import. Keep tests independent of real credentials.
dotenv.config = () => ({ parsed: {} });
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
process.env.BACKPACK_API_SECRET = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url').toString('base64');
process.env.BACKPACK_API_KEY = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64');
const { default: Stream } = await import('../src/TrailingStop/TrailingStopStream.js');
const { default: Grid } = await import('../src/Grid/Grid.js');
const { default: Cache } = await import('../src/Controllers/CacheController.js');
const { default: Futures } = await import('../src/Backpack/Authenticated/Futures.js');

test('REST position snapshot uses signed net quantity instead of exposure including orders', async t => {
  t.mock.method(Cache.prototype, 'get', async () => ({ fee: 0 }));
  t.mock.method(Futures, 'getOpenPositions', async () => [{ symbol: 'SOL_USDC_PERP', netQuantity: '-2', netExposureQuantity: '9', markPrice: '100', entryPrice: '101', netExposureNotional: '900', pnlRealized: '0', pnlUnrealized: '2' }]);
  t.mock.method(Stream, 'syncMarkPriceSubscriptions', () => {});
  await Stream.updatePositions();
  assert.equal(Stream.positions.SOL_USDC_PERP.qty, -2);
  assert.equal(Stream.positions.SOL_USDC_PERP.isLong, false);
});

test('WebSocket position fields map consistently to REST positions', async t => {
  t.mock.method(Cache.prototype, 'get', async () => ({ fee: 0 }));
  t.mock.method(Stream, 'updateStops', async () => {});
  t.mock.method(Stream, 'syncMarkPriceSubscriptions', () => {});
  await Stream.onPositionUpdate({ e: 'positionUpdated', s: 'SOL_USDC_PERP', q: '-2', Q: '9', B: '101', b: '102', M: '100', p: '0', P: '2', n: '900' });
  assert.equal(Stream.positions.SOL_USDC_PERP.qty, -2);
  assert.equal(Stream.positions.SOL_USDC_PERP.entryPrice, 101);
  assert.equal(Stream.positions.SOL_USDC_PERP.isLong, false);
});

test('closing the last position unsubscribes its mark price stream', async () => {
  const messages = [];
  Stream.positions = { SOL_USDC_PERP: { qty: 2 } };
  Stream.activeStops = { SOL_USDC_PERP: [] };
  Stream.subscribedSymbols = new Set(['SOL_USDC_PERP']);
  Stream.wsPublic = { readyState: WebSocket.OPEN, send: raw => messages.push(JSON.parse(raw)) };
  await Stream.onPositionUpdate({ e: 'positionClosed', s: 'SOL_USDC_PERP', q: '0' });
  assert.deepEqual(Stream.positions, {});
  assert.deepEqual(Stream.activeStops, {});
  assert.deepEqual(messages, [{ method: 'UNSUBSCRIBE', params: ['markPrice.SOL_USDC_PERP'] }]);
  Stream.wsPublic = null;
});

async function localServer(t, owner, socketKey) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  process.env.WS_URL = `ws://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const client = owner[socketKey];
    client?.removeAllListeners();
    client?.terminate();
    owner[socketKey] = null;
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    delete process.env.WS_URL;
  });
  return server;
}

test('public reconnect resubscribes existing positions and schedules one retry', { timeout: 5000 }, async t => {
  const server = await localServer(t, Stream, 'wsPublic');
  Stream.positions = { SOL_USDC_PERP: { qty: 2 } };
  Stream.subscribedSymbols = new Set(['SOL_USDC_PERP']);
  const message = new Promise(resolve => server.once('connection', socket => socket.once('message', raw => resolve(JSON.parse(raw)))));
  Stream.connectPublic();
  assert.deepEqual(await message, { method: 'SUBSCRIBE', params: ['markPrice.SOL_USDC_PERP'] });
  const socket = Stream.wsPublic;
  Stream.connectPublic();
  assert.equal(Stream.wsPublic, socket);
  const closed = once(socket, 'close');
  socket.close();
  await closed;
  assert.ok(Stream.publicReconnectTimer);
  clearTimeout(Stream.publicReconnectTimer);
  assert.equal(Stream.wsPublic, null);
});

test('grid reacts to the official orderCancelled WebSocket event', { timeout: 5000 }, async t => {
  const server = await localServer(t, Grid, 'wsPrivate');
  let handled;
  const done = new Promise(resolve => { handled = resolve; });
  t.mock.method(Grid, 'handleOrderFill', async data => handled(data));
  server.once('connection', socket => socket.once('message', raw => {
    const subscription = JSON.parse(raw);
    assert.deepEqual(subscription.params, ['account.positionUpdate', 'account.orderUpdate']);
    socket.send(JSON.stringify({ stream: 'account.orderUpdate', data: { e: 'orderCancelled', s: 'SOL_USDC_PERP' } }));
  }));
  Grid.connectPrivate();
  assert.equal((await done).e, 'orderCancelled');
});
