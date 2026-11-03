import { randomUUID } from 'node:crypto';
import type {
  AlbumWriteResult,
  ImmichClient,
} from '../../src/immich/immich.client.js';

/**
 * In-memory stand-in for the album parts of ImmichClient (unit and runner
 * tests). Counts write calls so tests can assert idempotency.
 */
export class MemoryImmich {
  readonly albums = new Map<string, { name: string; members: Set<string> }>();
  /** Asset ids Immich knows; adding an unknown id → `no_permission`. */
  knownAssets: Set<string> | null = null;
  calls = { create: 0, add: 0, remove: 0 };

  album(name: string) {
    return [...this.albums.values()].find((a) => a.name === name);
  }

  createAlbum(name: string, members: string[] = []): string {
    const id = randomUUID();
    this.albums.set(id, { name, members: new Set(members) });
    return id;
  }

  asClient(): ImmichClient {
    return this as unknown as ImmichClient;
  }

  async assertCompatible() {
    return { major: 3, minor: 3, patch: 5, version: 'v3.3.5' };
  }

  async findAlbum(name: string) {
    const entry = [...this.albums.entries()].find(([, a]) => a.name === name);
    return entry ? { id: entry[0], name } : null;
  }

  async findOrCreateAlbum(name: string) {
    const found = await this.findAlbum(name);
    if (found) return { ...found, created: false };
    this.calls.create++;
    return { id: this.createAlbum(name), name, created: true };
  }

  async listAlbumMemberIds(albumId: string) {
    return [...(this.albums.get(albumId)?.members ?? [])];
  }

  async addToAlbum(albumId: string, ids: string[]): Promise<AlbumWriteResult> {
    this.calls.add++;
    const album = this.albums.get(albumId)!;
    const r: AlbumWriteResult = { succeeded: [], unchanged: [], failed: [] };
    for (const id of ids) {
      if (this.knownAssets && !this.knownAssets.has(id))
        r.failed.push({ id, error: 'no_permission' });
      else if (album.members.has(id)) r.unchanged.push(id);
      else {
        album.members.add(id);
        r.succeeded.push(id);
      }
    }
    return r;
  }

  async removeFromAlbum(
    albumId: string,
    ids: string[],
  ): Promise<AlbumWriteResult> {
    this.calls.remove++;
    const album = this.albums.get(albumId)!;
    const r: AlbumWriteResult = { succeeded: [], unchanged: [], failed: [] };
    for (const id of ids)
      (album.members.delete(id) ? r.succeeded : r.unchanged).push(id);
    return r;
  }
}
