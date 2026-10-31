import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, lstat, realpath, readFile, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const fail = () => Object.assign(new Error('Browser profile storage is unavailable.'), { code: 'BROWSER_PROFILE_UNAVAILABLE' });
const within = (root, path) => { const r = relative(root, path); return !isAbsolute(r) && r !== '..' && !r.startsWith(`..${sep}`); };
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Private encrypted browser state. Never place this directory in the repository. */
export class BrowserProfileVault {
  constructor({ root, keyBase64, workspaceRoot }) {
    if (!isAbsolute(root ?? '') || !isAbsolute(workspaceRoot ?? '') || within(resolve(workspaceRoot), resolve(root))) throw fail();
    if (typeof keyBase64 !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(keyBase64)) throw fail();
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32 || key.toString('base64') !== keyBase64) throw fail();
    this.root = resolve(root); this.key = key; this.maxBytes = 2 * 1024 * 1024;
  }
  async ready() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail();
    const canonical = await realpath(this.root);
    // Reject junction aliases rather than accidentally writing through a workspace link.
    if (relative(this.root, canonical) !== '') throw fail();
  }
  name(owner, profileId) {
    if (typeof owner !== 'string' || !owner || owner.length > 256 || !validId(profileId)) throw fail();
    return createHash('sha256').update(JSON.stringify([owner, profileId])).digest('hex') + '.state.enc';
  }
  aad(owner, profileId) { return Buffer.from(JSON.stringify(['micro-dsh-browser-profile-v1', owner, profileId])); }
  async load(owner, profileId) {
    await this.ready();
    const path = resolve(this.root, this.name(owner, profileId));
    let data;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > this.maxBytes * 2) throw fail();
      data = JSON.parse(await readFile(path, 'utf8'));
    } catch (cause) { if (cause.code === 'ENOENT') return undefined; throw fail(); }
    try {
      if (data.version !== 1 || !/^[a-f0-9]{24}$/.test(data.iv) || !/^[a-f0-9]{32}$/.test(data.tag)) throw fail();
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(data.iv, 'hex'));
      decipher.setAAD(this.aad(owner, profileId)); decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
      const plain = Buffer.concat([decipher.update(Buffer.from(data.ciphertext, 'base64')), decipher.final()]);
      if (plain.length > this.maxBytes) throw fail();
      const state = JSON.parse(plain.toString('utf8'));
      if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) throw fail();
      return state;
    } catch { throw fail(); }
  }
  async save(owner, profileId, state) {
    await this.ready();
    const plain = Buffer.from(JSON.stringify(state));
    if (plain.length > this.maxBytes || !Array.isArray(state?.cookies) || !Array.isArray(state?.origins)) throw fail();
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(owner, profileId));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const payload = JSON.stringify({ version: 1, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: ciphertext.toString('base64') });
    const path = resolve(this.root, this.name(owner, profileId));
    const temp = path + '.' + randomBytes(12).toString('hex') + '.tmp';
    let file;
    try {
      file = await open(temp, 'wx', 0o600); await file.writeFile(payload); await file.sync(); await file.close(); file = undefined;
      await rename(temp, path);
    } catch { throw fail(); }
    finally { await file?.close().catch(() => {}); await unlink(temp).catch(() => {}); }
  }
  close() { this.key.fill(0); }
}
