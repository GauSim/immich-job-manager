import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AssetResponseDto,
  ImmichClient,
} from '../../immich/immich.client.js';
import { MemoryFeatureCache } from '../../../test/support/memory-features.js';
import {
  decodeUserComment,
  lookupIosScreenshotTags,
  readUserComment,
} from './file-tag.js';

const fixture = (name: string) =>
  new Uint8Array(
    readFileSync(
      join(import.meta.dirname, '../../../test/fixtures/files', name),
    ),
  );

/** Serves the first 64 KiB of fixture files as Immich originals. */
function fakeImmich(files: Record<string, string>) {
  const reads: string[] = [];
  const immich = {
    readOriginalHead: async (id: string) => {
      reads.push(id);
      if (!files[id])
        throw new Error('Immich readOriginalHead failed with HTTP 404');
      const data = fixture(files[id]).slice(0, 65536);
      return { data, partial: false };
    },
  } as unknown as ImmichClient;
  return { immich, reads };
}

const asset = (id: string, checksum = `sum-${id}`) =>
  ({ id, checksum, originalFileName: `${id}.png` }) as AssetResponseDto;

describe('decodeUserComment', () => {
  it.each([
    [
      new Uint8Array([
        ...new TextEncoder().encode('ASCII\0\0\0'),
        ...new TextEncoder().encode('Screenshot'),
      ]),
      'Screenshot',
    ],
    [
      new Uint8Array([
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        ...new TextEncoder().encode('Screenshot\0\0'),
      ]),
      'Screenshot',
    ],
    ['Screenshot\0', 'Screenshot'],
    [undefined, undefined],
    [42, undefined],
  ])('%#', (input, expected) => {
    expect(decodeUserComment(input)).toBe(expected);
  });
});

describe('readUserComment (first 64 KiB of the original)', () => {
  const { immich } = fakeImmich({
    ascii: 'ios-screenshot.png',
    unicode: 'ios-screenshot-unicode.png',
    jpeg: 'jpeg-screenshot-tag.jpg',
    none: 'png-without-tag.png',
    reencoded: 'reencoded-screenshot.jpg',
    holiday: 'photo-with-other-comment.jpg',
  });

  it.each([
    ['ascii', 'Screenshot'],
    ['unicode', 'Screenshot'],
    ['jpeg', 'Screenshot'],
    ['none', undefined],
    ['reencoded', undefined],
    ['holiday', 'Holiday'],
  ])('%s → %s', async (id, expected) => {
    expect(await readUserComment(immich, id)).toBe(expected);
  });
});

describe('lookupIosScreenshotTags', () => {
  const log = {
    debug: () => {},
    info: () => {},
    warn: vi.fn(),
    error: () => {},
  };
  const signal = new AbortController().signal;

  it('reads files once, then answers from the cache until the checksum changes', async () => {
    const { immich, reads } = fakeImmich({
      a: 'ios-screenshot.png',
      b: 'png-without-tag.png',
    });
    const features = new MemoryFeatureCache();
    const deps = { immich, features: features.asCache(), signal, log };

    const first = await lookupIosScreenshotTags([asset('a'), asset('b')], deps);
    expect(first).toEqual({
      tagged: new Set(['a']),
      filesRead: 2,
      cacheHits: 0,
      failed: 0,
    });

    const second = await lookupIosScreenshotTags(
      [asset('a'), asset('b')],
      deps,
    );
    expect(second).toEqual({
      tagged: new Set(['a']),
      filesRead: 0,
      cacheHits: 2,
      failed: 0,
    });
    expect(reads).toEqual(['a', 'b']);

    const changed = await lookupIosScreenshotTags(
      [asset('a', 'new-checksum'), asset('b')],
      deps,
    );
    expect(changed).toMatchObject({ filesRead: 1, cacheHits: 1 });
    expect(reads).toEqual(['a', 'b', 'a']);
  });

  it('does not cache failed reads, so they are retried', async () => {
    const { immich, reads } = fakeImmich({});
    const features = new MemoryFeatureCache();
    const deps = { immich, features: features.asCache(), signal, log };
    expect(await lookupIosScreenshotTags([asset('x')], deps)).toMatchObject({
      failed: 1,
      filesRead: 0,
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringMatching(/Could not read x.png/),
    );
    await lookupIosScreenshotTags([asset('x')], deps);
    expect(reads).toEqual(['x', 'x']);
  });

  it('makes no calls for an empty list', async () => {
    const { immich, reads } = fakeImmich({});
    expect(
      await lookupIosScreenshotTags([], {
        immich,
        features: new MemoryFeatureCache().asCache(),
        signal,
        log,
      }),
    ).toMatchObject({
      filesRead: 0,
    });
    expect(reads).toEqual([]);
  });
});
