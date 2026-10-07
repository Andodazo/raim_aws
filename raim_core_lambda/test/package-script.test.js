'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// function.zip に voice-config.json が入っていないと、声のプロファイル
// （人格ごとの声・12感情の声の変化）が読めず、既定の声になる。
// 2026-10 に実際に抜けていた（CloudWatch に voice-config.json unavailable）。
test('npm run package は voice-config.json を zip に入れる', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const script = String(pkg.scripts?.package || '');

  for (const entry of ['index.js', 'lib', 'voice-config.json', 'node_modules']) {
    assert.ok(script.split(/\s+/).includes(entry), `${entry} が package に入っていない`);
  }
});

test('voice-config.json がリポジトリにある', () => {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'voice-config.json')));
});
