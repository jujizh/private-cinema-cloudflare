// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { CinemaDirectory } from '../src/directory.js';
import { signToken } from '../src/security.js';
import { validateSiteSettings } from '../public/site-settings.js';
import { siteConfig, siteDefaults, useSiteSettings, loadSiteSettings, applySiteConfig } from '../public/site-config.js';

function fixture() {
  const data = new Map([['rooms', { existing: { title: 'Do not change' } }]]);
  const ctx = { storage: { get: async k => structuredClone(data.get(k)), put: async (k,v) => data.set(k,structuredClone(v)), delete: async k => data.delete(k) } };
  const directory = new CinemaDirectory(ctx);
  const env = { APP_AUTH_SECRET: 'REPLACE_TEST_ONLY_SETTING_KEY'.repeat(3), DIRECTORY: {
    idFromName: name => name, get: () => ({ fetch: (url, init) => directory.fetch(new Request(url, init)) }),
  } };
  return { data, ctx, env, request: (path, init={}) => worker.fetch(new Request(`https://test.example${path}`, init), env) };
}
async function ownerCookie(env, role='owner', typ='admin') {
  const token = await signToken({ typ, role, exp:Math.floor(Date.now()/1000)+60 }, env.APP_AUTH_SECRET);
  return `cinema_admin=${encodeURIComponent(token)}`;
}

test('site settings schema accepts plain text and rejects secrets, unknown fields and malformed values', () => {
  assert.deepEqual(validateSiteSettings({title:'  Test Cinema  ',tagline:''}),{title:'Test Cinema',tagline:''});
  for (const value of [null, [], 'text', {title:''}, {title:'x'.repeat(81)}, {defaultHostName:12}, {APP_AUTH_SECRET:'REPLACE_TEST_VALUE'}, {workerName:'not-allowed'}, {title:'bad\u0000name'}, JSON.parse('{"__proto__":"not-allowed"}')]) assert.throws(()=>validateSiteSettings(value));
});

test('only an authenticated owner can update or reset global settings', async () => {
  const f=fixture();
  const publicResponse=await f.request('/api/site-settings');
  assert.equal(publicResponse.status,200);
  assert.deepEqual(await publicResponse.json(),{settings:{},configured:false});
  assert.equal(publicResponse.headers.get('Cache-Control'),'no-store');
  assert.equal((await f.request('/api/admin/site-settings',{method:'PUT',body:'{"title":"No"}'})).status,401);
  assert.equal((await f.request('/api/admin/site-settings',{method:'DELETE'})).status,401);
  for (const [role,typ] of [['host','invite'],['viewer','invite'],['owner','invite']]) {
    assert.equal((await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:await ownerCookie(f.env,role,typ)},body:'{"title":"No"}'})).status,401);
  }
  const cookie=await ownerCookie(f.env);
  assert.equal((await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:cookie,Origin:'https://other.example'},body:'{"title":"No"}'})).status,403);
  assert.equal((await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:cookie},body:'{"APP_AUTH_SECRET":"No"}'})).status,400);
  assert.equal(f.data.has('siteSettings'),false);
});

test('settings survive a new Directory instance and reset does not delete rooms', async () => {
  const f=fixture(),cookie=await ownerCookie(f.env);
  const settings={title:'A new cinema',defaultHostName:'Owner',tagline:'One room'};
  const saved=await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(settings)});
  assert.equal(saved.status,200);
  assert.deepEqual((await saved.json()).settings,settings);
  const fresh=new CinemaDirectory(f.ctx);
  assert.deepEqual((await (await fresh.fetch(new Request('https://directory/site-settings'))).json()).settings,settings);
  assert.deepEqual((await (await f.request('/api/site-settings')).json()).settings,settings);
  assert.equal((await f.request('/api/admin/site-settings',{headers:{Cookie:cookie}})).status,200);
  assert.equal((await f.request('/api/admin/site-settings',{method:'DELETE',headers:{Cookie:cookie}})).status,200);
  assert.deepEqual(await (await f.request('/api/site-settings')).json(),{settings:{},configured:false});
  assert.deepEqual(f.data.get('rooms'),{existing:{title:'Do not change'}});
});

test('oversized or malformed setting payloads cannot alter stored values', async () => {
  const f=fixture(),cookie=await ownerCookie(f.env);
  const tooLarge=await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:cookie},body:JSON.stringify({title:'x'.repeat(13000)})});
  assert.equal(tooLarge.status,413);
  assert.equal((await f.request('/api/admin/site-settings',{method:'PUT',headers:{Cookie:cookie},body:'{'})).status,400);
  assert.equal(f.data.has('siteSettings'),false);
});

test('client merges overrides, keeps markup inert and preserves an edited room title', async () => {
  try {
    await loadSiteSettings(async()=>new Response(JSON.stringify({settings:{title:'<img src=x onerror=alert(1)>',defaultRoomTitle:'New default'},configured:true})));
    const element={dataset:{siteText:'title'},textContent:''},room={value:'Unsaved screening title',dataset:{}};
    const doc={querySelector:()=>null,querySelectorAll:()=>[element],getElementById:id=>id==='roomTitle'?room:null};
    applySiteConfig(doc);
    assert.equal(element.textContent,'<img src=x onerror=alert(1)>');
    assert.equal(room.value,'Unsaved screening title');
    assert.equal(siteConfig.tagline,siteDefaults.tagline);
    assert.equal(await loadSiteSettings(async()=>{throw new Error('Offline')}),false);
    assert.equal(siteConfig.defaultRoomTitle,'New default');
    useSiteSettings({}); assert.equal(siteConfig.title,siteDefaults.title);
  } finally { useSiteSettings({}); }
});
