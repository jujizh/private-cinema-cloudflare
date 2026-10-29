// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Private Cinema contributors.
// Open-source snapshot prepared 2026-10-29; see CHANGELOG.md.
// Public branding only: never put passwords, API tokens or account IDs here.
import { validateSiteSettings } from './site-settings.js?v=2.4.1-host-settings-20261029';

export const siteDefaults = Object.freeze({
  title: "Private Cinema",
  tagline: "One screen. Any distance.",
  description: "An invitation-only private cinema for watching together.",
  eyebrow: "INVITATION ONLY · WATCH TOGETHER",
  heroTitle: "Your private",
  heroAccent: "screening room.",
  introduction: "Share one screen with the people you choose. No public room list, no movie file uploads, no strangers wandering in.",
  defaultHostName: "Host",
  defaultRoomTitle: "Movie night",
  guestPlaceholder: "Your nickname",
  invitePlaceholder: "Invitation label, e.g. Guest",
  localPlayerTitle: "Local movie / 本地电影",
});
export let siteConfig = siteDefaults;
export let siteSettingsConfigured = false;
export let siteSettingsLoadSucceeded = false;

export function useSiteSettings(settings, configured = false) {
  const checked = validateSiteSettings(settings);
  siteConfig = Object.freeze({ ...siteDefaults, ...checked });
  siteSettingsConfigured = Boolean(configured);
}

export async function loadSiteSettings(fetcher = fetch) {
  try {
    const response = await fetcher('/api/site-settings', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error('Settings are unavailable');
    const data = await response.json();
    useSiteSettings(data.settings, data.configured);
    siteSettingsLoadSucceeded = true;
    return true;
  } catch { siteSettingsLoadSucceeded = false; return false; } // Keep existing text; do not overwrite unread settings.
}

export function applySiteConfig(doc = document) {
  doc.title = siteConfig.title;
  const meta = doc.querySelector('meta[name="description"]');
  if (meta) meta.content = siteConfig.description;
  for (const element of doc.querySelectorAll('[data-site-text]')) {
    const value = siteConfig[element.dataset.siteText];
    if (typeof value === "string") element.textContent = value;
  }
  const brand = doc.querySelector('.brand');
  if (brand) { brand.setAttribute('aria-label', `${siteConfig.title} home`); brand.setAttribute('title', siteConfig.title); }
  for (const [id, property, key] of [
    ['roomTitle', 'value', 'defaultRoomTitle'],
    ['guestName', 'placeholder', 'guestPlaceholder'],
    ['inviteLabel', 'placeholder', 'invitePlaceholder'],
  ]) {
    const element = doc.getElementById(id);
    if (element && (property !== 'value' || !element.value || element.value === siteDefaults[key] || element.value === element.dataset?.siteDefault)) {
      element[property] = siteConfig[key];
      if (property === 'value' && element.dataset) element.dataset.siteDefault = siteConfig[key];
    }
  }
}
