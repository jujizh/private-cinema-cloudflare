// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { siteConfig, applySiteConfig } from '../public/site-config.js';
import { signToken, verifyToken, base64UrlDecode } from '../src/security.js';

test('public branding applies as text and defaults without embedding markup', () => {
  const title = { dataset: { siteText: 'title' }, textContent: '' };
  const tag = { dataset: { siteText: 'tagline' }, textContent: '' };
  const meta = {}, brand = { setAttribute(k, v) { this[k] = v; } };
  const fields = new Map(['roomTitle', 'guestName', 'inviteLabel'].map(id => [id, {}]));
  const doc = { querySelector: selector => selector === '.brand' ? brand : meta,
    querySelectorAll: () => [title, tag], getElementById: id => fields.get(id) };
  applySiteConfig(doc);
  assert.equal(doc.title, siteConfig.title);
  assert.equal(title.textContent, siteConfig.title);
  assert.equal(tag.textContent, siteConfig.tagline);
  assert.equal(meta.content, siteConfig.description);
  assert.equal(brand['aria-label'], `${siteConfig.title} home`);
  assert.equal(fields.get('roomTitle').value, siteConfig.defaultRoomTitle);
  assert.equal(fields.get('guestName').placeholder, siteConfig.guestPlaceholder);
});

test('neutral token issuer signs and verifies the open-source protocol', async () => {
  const key = 'test-only-key'.repeat(5);
  const signed = await signToken({ typ: 'invite', role: 'viewer', exp: Math.floor(Date.now()/1000) + 60 }, key);
  const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(signed.split('.')[0])));
  assert.equal(claims.iss, 'private-cinema');
  assert.equal((await verifyToken(signed, key)).role, 'viewer');
});
