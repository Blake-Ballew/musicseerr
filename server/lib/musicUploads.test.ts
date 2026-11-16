import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  customReleases,
  safeName,
  trackFileName,
} from '@server/lib/musicUploads';

describe('custom music imports', () => {
  it('makes names safe for folders', () => {
    assert.equal(safeName('AC/DC: Live?'), 'AC_DC_ Live_');
    assert.equal(safeName('..'), '_');
    assert.equal(safeName('.hidden. '), 'hidden');
  });

  it('names track files with disc numbers only for multi-disc albums', () => {
    const t = { path: 'x/Song.FLAC', title: 'Song', track: 3, disc: 2 };
    assert.equal(trackFileName(t, 1), '03 - Song.flac');
    assert.equal(trackFileName(t, 2), '2-03 - Song.flac');
  });

  it('turns several singles into one release each', () => {
    const tracks = [
      { path: 'a.mp3', title: 'A', track: 1, disc: 1 },
      { path: 'b.mp3', title: 'B', track: 2, disc: 1 },
    ];
    const base = { artist: 'X', album: 'Ignored', tracks };
    assert.deepEqual(
      customReleases({ ...base, type: 'Single' }).map((r) => [
        r.title,
        r.tracks[0].track,
      ]),
      [
        ['A', 1],
        ['B', 1],
      ]
    );
    assert.equal(customReleases({ ...base, type: 'Album' }).length, 1);
  });
});
