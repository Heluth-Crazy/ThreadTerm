import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizePin, peerEndpoint } from './peer-transport.js';
import type { MachineInfo } from '../../renderer/src/machineTypes.js';

export interface CredentialStorage { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }
interface StoredMachine { id: string; name: string; color: string; endpoint: string; pin: string; encryptedCredential: string }
export const LOCAL_MACHINE: MachineInfo = { id: 'local', name: 'This PC', color: '#8b8b98', state: 'local' };
export class MachineRegistry {
  private entries: StoredMachine[] = [];
  constructor(private readonly path: string, private readonly storage: CredentialStorage) {
    if (!existsSync(path)) return;
    try { this.load(); } catch (error) {
      // A damaged registry must not keep the app from starting. Keep the file for inspection; pair again.
      this.entries = [];
      const aside = `${path}.invalid-${Date.now()}`;
      try { renameSync(path, aside); } catch { /* the next save replaces it */ }
      console.warn(`Ignored an unreadable computer registry (${error instanceof Error ? error.message : String(error)}); moved to ${aside}`);
    }
  }
  private load(): void {
    const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
    if (!Array.isArray(value)) throw new Error('Invalid computer registry');
    const ids = new Set<string>();
    for (const entry of value) {
      if (!entry || typeof entry !== 'object' || !/^[a-f0-9-]{36}$/.test(entry.id) || ids.has(entry.id) || typeof entry.encryptedCredential !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(entry.encryptedCredential)) throw new Error('Invalid computer registry');
      this.validate(entry); ids.add(entry.id);
      this.entries.push({ id: entry.id, name: entry.name, color: entry.color, endpoint: entry.endpoint, pin: normalizePin(entry.pin), encryptedCredential: entry.encryptedCredential });
    }
  }
  list(): MachineInfo[] { return [{ ...LOCAL_MACHINE }, ...this.entries.map(({ id, name, color }) => ({ id, name, color, state: 'disconnected' as const }))]; }
  assertEncryptionAvailable(): void {
    if (!this.storage.isEncryptionAvailable()) throw new Error('Cannot add a computer: encrypted credential storage is unavailable. Enable your operating system’s secure storage and try again.');
  }
  add(input: { name: string; color: string; endpoint: string; pin: string }, credential: string, changedIdentityIds: ReadonlySet<string> = new Set()): MachineInfo {
    this.assertEncryptionAvailable(); this.validate(input);
    const stale = this.entries.find(entry => changedIdentityIds.has(entry.id) && peerEndpoint(entry.endpoint).href === peerEndpoint(input.endpoint).href);
    const entry: StoredMachine = { ...input, name: input.name.trim(), pin: normalizePin(input.pin), id: randomUUID(), encryptedCredential: this.storage.encryptString(credential).toString('base64') };
    if (stale) { entry.id = stale.id; entry.name = stale.name; entry.color = stale.color; }
    const next = stale ? this.entries.map(item => item.id === stale.id ? entry : item) : [...this.entries, entry]; this.save(next); this.entries = next;
    return { id: entry.id, name: entry.name, color: entry.color, state: 'disconnected' };
  }
  profile(id: string) {
    const entry = this.entries.find(item => item.id === id);
    if (!entry) throw new Error('Computer is unavailable');
    return { kind: 'peer' as const, endpoint: entry.endpoint, pin: entry.pin, credential: () => { this.assertEncryptionAvailable(); return this.storage.decryptString(Buffer.from(entry.encryptedCredential, 'base64')); } };
  }
  remove(id: string): void { const next = this.entries.filter(entry => entry.id !== id); this.save(next); this.entries = next; }
  private validate(input: { name: string; color: string; endpoint: string; pin: string }): void {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f]/.test(input.name) || typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.color)) throw new Error('Choose a computer name and color');
    peerEndpoint(input.endpoint); normalizePin(input.pin);
  }
  private save(entries: StoredMachine[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(`${this.path}.next`, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    renameSync(`${this.path}.next`, this.path);
  }
}
