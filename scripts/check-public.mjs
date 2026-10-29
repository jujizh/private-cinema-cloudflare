// SPDX-License-Identifier: Apache-2.0
// Heuristic snapshot check, NOT a Git-history or comprehensive secret audit.
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const ignored = new Set(['node_modules', '.git', '.wrangler', 'build-output', 'bin', 'obj', 'dist']);
const privateFiles = /^(?:\.dev\.vars(?:\..+)?|\.env(?:\..+)?|local-deploy-audit\.json)$/;
const forbiddenExtensions = /\.(?:exe|dll|pdb|zip|mkv|mp4|webm|m4a|mp3|wav|pem|pfx|key)$/i;
const personal = new RegExp(['ji' + 'ahao', '\\b' + 'Sa' + 'na' + '\\b', '\\b' + 'An' + 'na' + '\\b', 'ju' + 'jizh', 'mofang' + 'net', 'wxid' + '_'].join('|'), 'i');
const absoluteUserPath = /[A-Z]:[\\/]Users[\\/][^\s"'<>]+/i;
const privateKey = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/;
const findings = [];
let count = 0;
async function walk(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(folder, entry.name), relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) { findings.push(`${relative}: unexpected symbolic link`); continue; }
    if (entry.isDirectory()) { await walk(full); continue; }
    if (privateFiles.test(entry.name) && !entry.name.endsWith('.example')) { findings.push(`${relative}: private configuration`); continue; }
    if (forbiddenExtensions.test(entry.name)) { findings.push(`${relative}: binary/media/credential artifact`); continue; }
    const source = await readFile(full, 'utf8'); count++;
    if (personal.test(source)) findings.push(`${relative}: legacy personal branding`);
    if (absoluteUserPath.test(source)) findings.push(`${relative}: local user path`);
    if (privateKey.test(source)) findings.push(`${relative}: private key marker`);
    for (const match of source.matchAll(/\b(?:APP_AUTH_SECRET|ADMIN_PASSWORD|CF_REALTIME_APP_SECRET|TURN_KEY_API_TOKEN)\s*[:=]\s*["']?([^"'\s,;}]+)/g)) {
      if (!match[1].startsWith('REPLACE_')) findings.push(`${relative}: possible literal credential assignment (value omitted)`);
    }
  }
}
await walk(root);
const config = JSON.parse(await readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
if (config.account_id || config.routes?.length) findings.push('wrangler.jsonc: account/domain must be supplied by deployer');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (pkg.license !== 'Apache-2.0') findings.push('package.json: license mismatch');
for (const file of ['LICENSE','NOTICE','DISCLAIMER.md','THIRD_PARTY_NOTICES.md','DEPLOY.md']) await readFile(path.join(root, file));
if (findings.length) { console.error(findings.join('\n')); process.exitCode = 1; }
else console.log(`PASS: ${count} source/docs files checked; no detected legacy branding/private artifacts. Git history and cloud account not scanned.`);
