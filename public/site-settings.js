// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Shared public-text schema. Never allow cloud configuration or credentials.
export const SITE_SETTING_LIMITS = Object.freeze({
  title: 80, tagline: 140, description: 240, eyebrow: 100,
  heroTitle: 120, heroAccent: 120, introduction: 600,
  defaultHostName: 40, defaultRoomTitle: 100,
  guestPlaceholder: 100, invitePlaceholder: 100, localPlayerTitle: 80,
});

export function validateSiteSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Settings must be an object');
  const entries = Object.entries(input);
  for (const [key, value] of entries) {
    if (!Object.hasOwn(SITE_SETTING_LIMITS, key)) throw new TypeError(`Unsupported setting: ${key}`);
    if (typeof value !== 'string') throw new TypeError(`Setting ${key} must be text`);
    if (value.length > SITE_SETTING_LIMITS[key]) throw new TypeError(`Setting ${key} is too long (max ${SITE_SETTING_LIMITS[key]})`);
    if (['title', 'defaultHostName', 'defaultRoomTitle'].includes(key) && !value.trim()) throw new TypeError(`Setting ${key} cannot be empty`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new TypeError(`Setting ${key} contains control characters`);
  }
  return Object.fromEntries(entries.map(([key, value]) => [key, value.trim()]));
}
