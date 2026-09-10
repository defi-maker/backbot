import assert from 'node:assert/strict';
import axios from 'axios';
import WebSocket from 'ws';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import Markets from '../src/Backpack/Public/Markets.js';
import System from '../src/Backpack/Public/System.js';
import Trades from '../src/Backpack/Public/Trades.js';

// This check deliberately needs no .env or account credentials.
process.env.API_URL = 'https://api.backpack.exchange';
axios.defaults.timeout = 15000;

const db = await open({ filename: ':memory:', driver: sqlite3.Database });
console.log('SQLite:', (await db.get('SELECT sqlite_version() AS version')).version);
await db.close();

const checks = [
  ['status', () => System.getStatus(), value => value != null],
  ['time', () => System.getSystemTime(), value => Number(value) > 0],
  ['markets', () => Markets.getMarkets(), value => Array.isArray(value) && value.some(m => m.symbol === 'SOL_USDC_PERP')],
  ['ticker', () => Markets.getTicker('SOL_USDC_PERP'), value => value?.symbol === 'SOL_USDC_PERP'],
  ['klines', () => Markets.getKLines('SOL_USDC_PERP', '5m', 5), value => Array.isArray(value) && value.length > 0 && value[0].close != null],
  ['markPrices', () => Markets.getAllMarkPrices('SOL_USDC_PERP'), value => Array.isArray(value) && value[0]?.markPrice != null],
  ['trades', () => Trades.getRecentTrades('SOL_USDC_PERP', 1), value => Array.isArray(value) && value.length > 0],
];
const results = await Promise.allSettled(checks.map(async ([name, run, valid]) => {
  assert.ok(valid(await run()), `${name}: invalid or unavailable API response`);
  console.log(`${name}: OK`);
}));
for (const result of results) {
  if (result.status === 'rejected') {
    console.error(result.reason.message);
    process.exitCode = 1;
  }
}

try {
  await new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://ws.backpack.exchange', { handshakeTimeout: 15000 });
    const finish = error => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Public WebSocket timed out')), 20000);
    ws.on('error', finish);
    ws.on('close', () => finish(new Error('Public WebSocket closed before receiving a price')));
    ws.on('open', () => ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: ['markPrice.SOL_USDC_PERP'] })));
    ws.on('message', raw => {
      try {
        const message = JSON.parse(raw);
        if (message.stream === 'markPrice.SOL_USDC_PERP') {
          assert.ok(Number(message.data.p) > 0);
          finish();
        }
      } catch (error) { finish(error); }
    });
  });
  console.log('public WebSocket: OK');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
