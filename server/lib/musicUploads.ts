import JellyfinAPI from '@server/api/jellyfin';
import MusicBrainz from '@server/api/musicbrainz';
import type {
  MusicAlbumResult,
  MusicArtistResult,
} from '@server/api/musicbrainz/interfaces';
import LidarrAPI from '@server/api/servarr/lidarr';
import { lidarrScanner } from '@server/lib/scanners/lidarr';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { getHostname } from '@server/utils/getHostname';
import { randomUUID } from 'crypto';
import type { Dirent } from 'fs';
import { createWriteStream, promises as fs } from 'fs';
import { parseFile } from 'music-metadata';
import {
  ByteVector,
  Picture,
  PictureType,
  File as TagFile,
} from 'node-taglib-sharp';
import path from 'path';
import sharp from 'sharp';
import type { Readable } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Album uploads (your own CD rips and purchases). Files land in an inbox
 * folder that Lidarr can also see; once the album is identified, Lidarr
 * imports them into the library like a finished download.
 */

export const AUDIO_EXTENSIONS = [
  '.flac',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.opus',
  '.wav',
  '.aiff',
  '.ape',
  '.wv',
];
const EXTRA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.cue', '.log'];
const LOSSY_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.ogg', '.opus'];
const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024;

export type UploadStatus =
  | 'uploading'
  | 'analyzing'
  | 'ready'
  | 'importing'
  | 'imported'
  | 'needs-review'
  | 'failed';

export interface UploadIssue {
  level: 'error' | 'warning';
  message: string;
}

export interface UploadTrack {
  path: string;
  title?: string;
  artist?: string;
  disc?: number;
  track?: number;
  duration?: number;
  format: string;
  lossless: boolean;
}

export interface UploadCandidate {
  id: string;
  title: string;
  artistName: string;
  artistId: string;
  year: string;
  type: string;
  trackCounts: number[];
  trackCountMatches: boolean;
  exact: boolean;
}

export interface MusicUpload {
  id: string;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: number; displayName: string };
  status: UploadStatus;
  files: { path: string; size: number }[];
  totalBytes?: number;
  album?: {
    artist?: string;
    title?: string;
    year?: string;
    trackCount: number;
    discCount: number;
    format: string;
  };
  tracks?: UploadTrack[];
  issues?: UploadIssue[];
  candidates?: UploadCandidate[];
  selectedId?: string;
  /** The last custom import form, so a retry starts from it */
  custom?: CustomImport;
  result?: {
    message: string;
    importedTracks?: number;
    leftoverFiles?: { path: string; reasons: string[] }[];
  };
}

const configDir = () =>
  process.env.CONFIG_DIRECTORY ?? path.join(__dirname, '../../config');

const manifestDir = () => path.join(configDir(), 'uploads');

/** Inbox as MusicSeerr sees it. Must be set, and shared with Lidarr. */
export const uploadDir = () => process.env.MUSIC_UPLOAD_DIR || null;

/** The same inbox as Lidarr sees it (only differs if mounted elsewhere) */
const lidarrUploadDir = () =>
  process.env.LIDARR_UPLOAD_DIR || process.env.MUSIC_UPLOAD_DIR || '';

export const uploadsConfigured = () => !!uploadDir();

const albumDir = (id: string) => path.join(uploadDir() ?? '', id);

const manifestPath = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    throw new Error('Invalid upload id');
  }
  return path.join(manifestDir(), `${id}.json`);
};

const save = async (upload: MusicUpload) => {
  upload.updatedAt = new Date().toISOString();
  await fs.mkdir(manifestDir(), { recursive: true });
  await fs.writeFile(manifestPath(upload.id), JSON.stringify(upload, null, 2));
  return upload;
};

export const getUpload = async (id: string): Promise<MusicUpload | null> => {
  try {
    return JSON.parse(await fs.readFile(manifestPath(id), 'utf-8'));
  } catch {
    return null;
  }
};

export const listUploads = async (): Promise<MusicUpload[]> => {
  let names: string[] = [];
  try {
    names = await fs.readdir(manifestDir());
  } catch {
    return [];
  }
  const uploads = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map((n) => getUpload(n.replace(/\.json$/, '')))
  );
  return uploads
    .filter((u): u is MusicUpload => !!u)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
};

export const createUpload = async (user: {
  id: number;
  displayName: string;
}) => {
  const id = randomUUID();
  // Lidarr runs as a different user and needs to move these files out
  await fs.mkdir(albumDir(id), { recursive: true, mode: 0o777 });
  await fs.chmod(albumDir(id), 0o777);
  const now = new Date().toISOString();
  return save({
    id,
    createdAt: now,
    updatedAt: now,
    createdBy: { id: user.id, displayName: user.displayName },
    status: 'uploading',
    files: [],
  });
};

/** Keep only a safe relative path such as "CD1/01 - Song.flac" */
const safeRelativePath = (relative: string) => {
  const parts = relative
    .replace(/\\/g, '/')
    .split('/')
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length === 0) {
    throw new Error('Invalid file name');
  }
  return parts.join('/');
};

export const isAllowedFile = (name: string) => {
  const ext = path.extname(name).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext) || EXTRA_EXTENSIONS.includes(ext);
};

export const saveFile = async (
  upload: MusicUpload,
  relative: string,
  body: Readable,
  declaredSize: number
) => {
  if (upload.status !== 'uploading' && upload.status !== 'ready') {
    throw new Error('This upload is no longer accepting files');
  }
  if (!isAllowedFile(relative)) {
    throw new Error('Only audio files, cover images, .cue and .log files');
  }
  if (declaredSize > MAX_FILE_BYTES) {
    throw new Error('File is too large');
  }
  const rel = safeRelativePath(relative);
  const target = path.join(albumDir(upload.id), rel);
  let dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o777 });
  while (dir.startsWith(albumDir(upload.id)) && dir !== albumDir(upload.id)) {
    await fs.chmod(dir, 0o777);
    dir = path.dirname(dir);
  }
  await pipeline(body, createWriteStream(target, { mode: 0o666 }));
  await fs.chmod(target, 0o666);
  const { size } = await fs.stat(target);

  const fresh = (await getUpload(upload.id)) ?? upload;
  fresh.files = [
    ...fresh.files.filter((f) => f.path !== rel),
    { path: rel, size },
  ];
  return save(fresh);
};

const normalise = (s = '') =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const similarity = (a = '', b = '') => {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.8;
  const xs = new Set(x.split(' '));
  const ys = y.split(' ');
  const shared = ys.filter((w) => xs.has(w)).length;
  return shared / Math.max(xs.size, ys.length);
};

const mostCommon = (values: (string | undefined)[]) => {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

const lucene = (s: string) => s.replace(/([+\-&|!(){}[\]^"~*?:\\/])/g, '\\$1');

const createMusicBrainz = () =>
  new MusicBrainz(
    process.env.FANART_API_KEY || undefined,
    process.env.LASTFM_API_KEY || undefined
  );

const toCandidate = (
  album: MusicAlbumResult,
  trackCount: number,
  exact: boolean
): UploadCandidate => {
  const trackCounts = [
    ...new Set(album.releases.map((r) => r.trackCount).filter((n) => n > 0)),
  ].sort((a, b) => a - b);
  return {
    id: album.id,
    title: album.title,
    artistName: album.artistName,
    artistId: album.artistId,
    year: album.firstReleaseDate?.slice(0, 4) ?? '',
    type: [album.primaryType, ...(album.secondaryTypes ?? [])]
      .filter(Boolean)
      .join(' + '),
    trackCounts,
    trackCountMatches: trackCounts.includes(trackCount),
    exact,
  };
};

/** Find albums matching an upload, best first */
export const findCandidates = async (
  query: { artist?: string; title?: string; text?: string },
  trackCount: number,
  releaseGroupId?: string
): Promise<UploadCandidate[]> => {
  const mb = createMusicBrainz();
  const candidates: UploadCandidate[] = [];

  // A pasted MusicBrainz album link or ID.
  // shortcut: only release-group IDs work, not /release/ edition links; add a release lookup if people paste those.
  const pastedId = query.text?.match(
    /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i
  )?.[0];
  releaseGroupId ??= pastedId;

  if (releaseGroupId) {
    try {
      candidates.push(
        toCandidate(await mb.getAlbum(releaseGroupId), trackCount, true)
      );
    } catch {
      // Fall through to searching
    }
  }

  const searches: string[] = [];
  if (pastedId) {
    // Nothing to search for
  } else if (query.text) {
    searches.push(query.text);
  } else if (query.title) {
    if (query.artist) {
      searches.push(
        `releasegroup:"${lucene(query.title)}" AND artist:"${lucene(query.artist)}"`
      );
    }
    searches.push(`${query.title} ${query.artist ?? ''}`.trim());
  }

  let results: MusicAlbumResult[] = [];
  for (const q of searches) {
    try {
      results = (await mb.searchAlbums({ query: q, limit: 10 }))
        .results as MusicAlbumResult[];
    } catch {
      results = [];
    }
    if (results.length) break;
  }

  const scored = results
    .filter((r) => !candidates.some((c) => c.id === r.id))
    .map((r) => ({
      album: r,
      score: query.text
        ? 1
        : similarity(r.title, query.title) * 2 +
          similarity(r.artistName, query.artist) +
          (r.primaryType === 'Album' ? 0.2 : 0),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Search indexes lag behind new releases, but the artist's discography doesn't
  const { artist, title } = query;
  if (
    artist &&
    title &&
    ![...candidates, ...scored.map((s) => s.album)].some(
      (a) => similarity(a.title, title) === 1
    )
  ) {
    try {
      const found = (
        (await mb.searchArtists({ query: artist, limit: 5 }))
          .results as MusicArtistResult[]
      ).find((a) => similarity(a.name, artist) === 1);
      if (found) {
        const albums = (await mb.getArtistAlbums(found.id)).filter(
          (a) =>
            similarity(a.title, title) === 1 &&
            !candidates.some((c) => c.id === a.id)
        );
        scored.unshift(...albums.map((album) => ({ album, score: 3 })));
      }
    } catch {
      // Keep whatever search found
    }
  }

  // Search results don't include releases; fetch them to compare track counts
  for (const { album } of scored) {
    try {
      candidates.push(
        toCandidate(await mb.getAlbum(album.id), trackCount, false)
      );
    } catch {
      candidates.push(toCandidate(album, trackCount, false));
    }
  }

  // Keep the exact (tagged) match first, then prefer matching track counts
  return [
    ...candidates.filter((c) => c.exact),
    ...candidates
      .filter((c) => !c.exact)
      .sort(
        (a, b) => Number(b.trackCountMatches) - Number(a.trackCountMatches)
      ),
  ];
};

const audioFiles = (upload: MusicUpload) =>
  upload.files.filter((f) =>
    AUDIO_EXTENSIONS.includes(path.extname(f.path).toLowerCase())
  );

export const analyzeUpload = async (id: string): Promise<MusicUpload> => {
  const upload = await getUpload(id);
  if (!upload) throw new Error('Upload not found');
  upload.status = 'analyzing';
  await save(upload);

  const issues: UploadIssue[] = [];
  const tracks: UploadTrack[] = [];
  const albums: (string | undefined)[] = [];
  const albumArtists: (string | undefined)[] = [];
  const years: (string | undefined)[] = [];
  const releaseGroupIds: (string | undefined)[] = [];
  let unreadable = 0;

  for (const file of audioFiles(upload)) {
    const ext = path.extname(file.path).toLowerCase();
    try {
      const meta = await parseFile(path.join(albumDir(id), file.path), {
        duration: true,
        skipCovers: true,
      });
      const c = meta.common;
      tracks.push({
        path: file.path,
        title: c.title,
        artist: c.artist,
        disc: c.disk?.no ?? undefined,
        track: c.track?.no ?? undefined,
        duration: meta.format.duration,
        format: ext.slice(1).toUpperCase(),
        lossless: meta.format.lossless ?? !LOSSY_EXTENSIONS.includes(ext),
      });
      albums.push(c.album);
      albumArtists.push(c.albumartist ?? c.artist);
      years.push(c.year ? String(c.year) : c.date?.slice(0, 4));
      releaseGroupIds.push(c.musicbrainz_releasegroupid);
    } catch {
      unreadable++;
    }
  }

  if (tracks.length === 0 && unreadable === 0) {
    issues.push({
      level: 'error',
      message: 'No music files were uploaded.',
    });
  }
  if (unreadable > 0) {
    issues.push({
      level: 'error',
      message: `${unreadable} file(s) couldn't be read. They may be damaged or not really music files.`,
    });
  }

  const distinctAlbums = new Set(
    albums.filter(Boolean).map((a) => normalise(a))
  );
  if (distinctAlbums.size > 1) {
    issues.push({
      level: 'error',
      message: `These files come from ${distinctAlbums.size} different albums (${[
        ...new Set(albums.filter(Boolean)),
      ]
        .slice(0, 3)
        .join(', ')}). Upload one album at a time.`,
    });
  }

  const missing = (key: keyof UploadTrack) =>
    tracks.filter((t) => t[key] === undefined || t[key] === '').length;
  const noAlbum = albums.filter((a) => !a).length;
  if (noAlbum > 0) {
    issues.push({
      level: 'error',
      message: `${noAlbum} file(s) have no album name in their tags. Rip with a standard ripper so the tags are filled in.`,
    });
  }
  if (albumArtists.some((a) => !a)) {
    issues.push({
      level: 'error',
      message: 'Some files have no artist in their tags.',
    });
  }
  if (missing('track') > 0) {
    issues.push({
      level: 'error',
      message: `${missing('track')} file(s) have no track number in their tags.`,
    });
  }
  if (missing('title') > 0) {
    issues.push({
      level: 'warning',
      message: `${missing('title')} file(s) have no song title in their tags.`,
    });
  }

  // Track numbering per disc: duplicates and gaps
  const discs = new Map<number, number[]>();
  for (const t of tracks) {
    if (t.track) {
      const disc = t.disc ?? 1;
      discs.set(disc, [...(discs.get(disc) ?? []), t.track]);
    }
  }
  for (const [disc, numbers] of discs) {
    const label = discs.size > 1 ? ` on disc ${disc}` : '';
    const dupes = numbers.filter((n, i) => numbers.indexOf(n) !== i);
    if (dupes.length) {
      issues.push({
        level: 'error',
        message: `Track ${[...new Set(dupes)].join(', ')}${label} appears more than once. If this is a multi-disc album, the disc numbers may be missing.`,
      });
    }
    const max = Math.max(...numbers);
    const gaps: number[] = [];
    for (let n = 1; n <= max; n++) {
      if (!numbers.includes(n)) gaps.push(n);
    }
    if (gaps.length) {
      issues.push({
        level: 'warning',
        message: `Track ${gaps.slice(0, 8).join(', ')}${label} seem to be missing. Upload the whole album if you have it.`,
      });
    }
  }

  const distinctArtists = new Set(tracks.map((t) => normalise(t.artist)));
  const albumArtist = mostCommon(albumArtists);
  if (distinctArtists.size > 3 && !/various/i.test(albumArtist ?? '')) {
    issues.push({
      level: 'warning',
      message:
        'Tracks are by many different artists. If this is a compilation or soundtrack, set the album artist to "Various Artists" in your ripper.',
    });
  }

  if (tracks.length && tracks.every((t) => !t.lossless)) {
    issues.push({
      level: 'warning',
      message:
        'These are compressed (lossy) files. They work, but ripping to FLAC keeps full CD quality.',
    });
  }

  const albumTitle = mostCommon(albums);
  const formats = [...new Set(tracks.map((t) => t.format))];
  upload.tracks = tracks.sort(
    (a, b) =>
      (a.disc ?? 1) - (b.disc ?? 1) ||
      (a.track ?? 999) - (b.track ?? 999) ||
      a.path.localeCompare(b.path)
  );
  upload.album = {
    artist: albumArtist,
    title: albumTitle,
    year: mostCommon(years),
    trackCount: tracks.length,
    discCount: Math.max(1, discs.size),
    format: formats.join(' + '),
  };
  upload.totalBytes = upload.files.reduce((sum, f) => sum + f.size, 0);
  upload.issues = issues;

  if (albumTitle) {
    upload.candidates = await findCandidates(
      { artist: albumArtist, title: albumTitle },
      tracks.length,
      mostCommon(releaseGroupIds)
    );
  } else {
    upload.candidates = [];
  }
  upload.selectedId = upload.candidates[0]?.id;
  if (!upload.candidates.length && albumTitle) {
    issues.push({
      level: 'warning',
      message:
        "We couldn't find this album automatically. Search for it below, or paste its MusicBrainz album link.",
    });
  }
  upload.status = 'ready';
  return save(upload);
};

export const searchForUpload = async (id: string, text: string) => {
  const upload = await getUpload(id);
  if (!upload) throw new Error('Upload not found');
  // The tagged artist/title still lets new albums be found via the discography
  const candidates = await findCandidates(
    { text, artist: upload.album?.artist, title: upload.album?.title },
    upload.album?.trackCount ?? audioFiles(upload).length
  );
  upload.candidates = candidates;
  upload.selectedId = candidates[0]?.id;
  return save(upload);
};

const defaultLidarr = () => {
  const settings = getSettings();
  return (
    settings.lidarr.find((l) => l.isDefault && !l.is4k) ?? settings.lidarr[0]
  );
};

const listFilesRecursive = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else {
      out.push(full);
    }
  }
  return out;
};

const runImport = async (upload: MusicUpload, candidate: UploadCandidate) => {
  const lidarrSettings = defaultLidarr();
  if (!lidarrSettings) {
    throw new Error('Lidarr is not set up');
  }
  const lidarr = new LidarrAPI({
    apiKey: lidarrSettings.apiKey,
    url: LidarrAPI.buildUrl(lidarrSettings, '/api/v1'),
  });

  // Lidarr only imports albums for artists it knows, so add the album
  // (and artist) first, without searching for downloads
  await lidarr.addAlbum({
    title: candidate.title,
    foreignAlbumId: candidate.id,
    qualityProfileId: lidarrSettings.activeProfileId,
    metadataProfileId: lidarrSettings.metadataProfileId,
    rootFolderPath: lidarrSettings.activeDirectory,
    tags: lidarrSettings.tags ?? [],
    monitored: true,
    searchNow: false,
    artist: {
      artistName: candidate.artistName,
      foreignArtistId: candidate.artistId,
      qualityProfileId: lidarrSettings.activeProfileId,
      metadataProfileId: lidarrSettings.metadataProfileId,
      rootFolderPath: lidarrSettings.activeDirectory,
      tags: lidarrSettings.tags ?? [],
      monitored: true,
    },
  });

  // A new artist takes a moment to finish loading its albums and tracks
  for (let i = 0; i < 30; i++) {
    const album = await lidarr.getAlbumByForeignId(candidate.id);
    if (album?.releases?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  const before = (await lidarr.getAlbumByForeignId(candidate.id))?.statistics
    ?.trackFileCount;
  const lidarrPath = path.posix.join(lidarrUploadDir(), upload.id);
  const command = await lidarr.importFolder(lidarrPath, candidate.id);

  const after = await lidarr.getAlbumByForeignId(candidate.id);
  const imported = (after?.statistics?.trackFileCount ?? 0) - (before ?? 0);

  const leftovers = (await listFilesRecursive(albumDir(upload.id))).filter(
    (f) => AUDIO_EXTENSIONS.includes(path.extname(f).toLowerCase())
  );

  if (leftovers.length === 0 && command.status === 'completed') {
    await fs.rm(albumDir(upload.id), { recursive: true, force: true });
    upload.status = 'imported';
    upload.result = {
      message: `Added ${imported > 0 ? imported : (upload.album?.trackCount ?? '')} tracks to the library.`,
      importedTracks: imported,
    };
    if (lidarrSettings.syncEnabled && !lidarrScanner.status().running) {
      lidarrScanner.run();
    }
    return;
  }

  let rejections: { path: string; reasons: string[] }[] = [];
  try {
    rejections = await lidarr.getImportRejections(lidarrPath, candidate.id);
  } catch {
    // Not fatal; the files are still there for manual import
  }
  upload.status = 'needs-review';
  upload.result = {
    message:
      imported > 0
        ? `Added ${imported} tracks, but ${leftovers.length} file(s) were not imported.`
        : 'Lidarr did not import these files.',
    importedTracks: imported,
    leftoverFiles: leftovers.map((f) => {
      const rel = path.relative(albumDir(upload.id), f).replace(/\\/g, '/');
      return {
        path: rel,
        reasons:
          rejections.find((r) => r.path.replace(/\\/g, '/').endsWith(rel))
            ?.reasons ?? [],
      };
    }),
  };
};

export const startImport = async (id: string, candidateId: string) => {
  const upload = await getUpload(id);
  if (!upload) throw new Error('Upload not found');
  if (upload.status === 'importing' || upload.status === 'imported') {
    throw new Error('This upload is already being added');
  }
  const candidate = upload.candidates?.find((c) => c.id === candidateId);
  if (!candidate) throw new Error('Choose an album first');

  upload.selectedId = candidate.id;
  upload.status = 'importing';
  upload.result = undefined;
  await save(upload);

  // Imports can take a few minutes; the page polls for the result
  runImport(upload, candidate)
    .catch((e) => {
      logger.error('Music upload import failed', {
        label: 'Music Upload',
        uploadId: id,
        errorMessage: e.message,
      });
      upload.status = 'failed';
      upload.result = { message: e.message };
    })
    .finally(() => save(upload));

  return upload;
};

export const deleteUpload = async (id: string) => {
  const upload = await getUpload(id);
  if (!upload) return;
  if (upload.status === 'importing') {
    throw new Error('Wait for the import to finish first');
  }
  if (uploadDir()) {
    await fs.rm(albumDir(id), { recursive: true, force: true });
  }
  await fs.rm(manifestPath(id), { force: true });
};

/*
 * Custom imports: music that isn't in MusicBrainz, so Lidarr can't take it.
 * The tags are rewritten from what the user typed and the files go into a
 * separate library folder that only Jellyfin reads.
 */

export interface CustomTrack {
  path: string;
  title: string;
  artist?: string;
  track: number;
  disc: number;
}

export interface CustomImport {
  artist: string;
  album: string;
  year?: string;
  genre?: string;
  /** "Single" with several tracks makes each track its own single */
  type: 'Album' | 'EP' | 'Single';
  /** An uploaded image file to use as the cover */
  cover?: string;
  tracks: CustomTrack[];
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png'];
const CUSTOM_TYPES = ['Album', 'EP', 'Single'];

export const customMusicDir = () => process.env.CUSTOM_MUSIC_DIR || null;

export const customConfigured = () => !!customMusicDir();

/** A file or folder name that's safe on Linux, SMB shares and Jellyfin */
export const safeName = (s: string) =>
  s
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120) || '_';

const isImage = (p: string) =>
  IMAGE_EXTENSIONS.includes(path.extname(p).toLowerCase());

/** Where an uploaded image is on disk, if it really is part of the upload */
export const uploadedImagePath = (upload: MusicUpload, relative: string) =>
  isImage(relative) && upload.files.some((f) => f.path === relative)
    ? path.join(albumDir(upload.id), relative)
    : null;

/** The albums or singles a custom import turns into */
export const customReleases = (c: CustomImport) =>
  c.type === 'Single' && c.tracks.length > 1
    ? c.tracks.map((t) => ({
        title: t.title,
        tracks: [{ ...t, track: 1, disc: 1 }],
      }))
    : [{ title: c.album, tracks: c.tracks }];

const cleanCustom = (upload: MusicUpload, input: unknown): CustomImport => {
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = (v: unknown, max = 200) =>
    typeof v === 'string' ? v.trim().slice(0, max) : '';
  const count = (v: unknown) => Math.max(1, Math.floor(Number(v)) || 1);
  const audio = new Set(audioFiles(upload).map((f) => f.path));

  const custom: CustomImport = {
    artist: text(raw.artist),
    album: text(raw.album),
    year: text(raw.year, 4) || undefined,
    genre: text(raw.genre, 60) || undefined,
    type: (CUSTOM_TYPES.includes(raw.type as string)
      ? raw.type
      : 'Album') as CustomImport['type'],
    cover: text(raw.cover, 500) || undefined,
    tracks: (Array.isArray(raw.tracks) ? raw.tracks : []).map(
      (t: Record<string, unknown>) => ({
        path: text(t?.path, 500),
        title: text(t?.title),
        artist: text(t?.artist) || undefined,
        track: count(t?.track),
        disc: count(t?.disc),
      })
    ),
  };

  if (!custom.artist) throw new Error('Enter the artist.');
  if (!custom.tracks.length) throw new Error('Choose at least one track.');
  if (custom.tracks.some((t) => !audio.has(t.path))) {
    throw new Error('A track is not part of this upload.');
  }
  if (new Set(custom.tracks.map((t) => t.path)).size !== custom.tracks.length) {
    throw new Error('A track is listed twice.');
  }
  if (custom.tracks.some((t) => !t.title)) {
    throw new Error('Every track needs a title.');
  }
  if (custom.year && !/^\d{4}$/.test(custom.year)) {
    throw new Error('The year must be 4 digits, like 2019.');
  }
  if (
    custom.cover &&
    (!isImage(custom.cover) ||
      !upload.files.some((f) => f.path === custom.cover))
  ) {
    throw new Error('The cover must be an uploaded JPG or PNG.');
  }
  for (const r of customReleases(custom)) {
    if (!r.title) throw new Error('Enter the album title.');
    const numbers = r.tracks.map((t) => `${t.disc}-${t.track}`);
    if (new Set(numbers).size !== numbers.length) {
      throw new Error('Two tracks have the same disc and track number.');
    }
  }
  return custom;
};

const releaseFolder = (c: CustomImport, title: string) =>
  path.join(
    customMusicDir() ?? '',
    safeName(c.artist),
    safeName(c.year ? `${title} (${c.year})` : title)
  );

export const trackFileName = (t: CustomTrack, discCount: number) =>
  `${discCount > 1 ? `${t.disc}-` : ''}${String(t.track).padStart(
    2,
    '0'
  )} - ${safeName(t.title)}${path.extname(t.path).toLowerCase()}`;

const jellyfinClient = () => {
  const { jellyfin } = getSettings();
  return jellyfin.apiKey && jellyfin.ip
    ? new JellyfinAPI(getHostname(), jellyfin.apiKey)
    : null;
};

/** Artist names already in Jellyfin, so one artist is spelled one way */
export const suggestArtists = async (term: string) =>
  (await jellyfinClient()
    ?.searchAlbumArtists(term)
    .catch(() => [])) ?? [];

/** Albums in Jellyfin (from either library folder) that match these */
const findDuplicates = async (c: CustomImport) => {
  const jf = jellyfinClient();
  const found: string[] = [];
  for (const r of customReleases(c)) {
    const albums = (await jf?.searchMusicAlbums(r.title).catch(() => [])) ?? [];
    if (
      albums.some(
        (a) =>
          normalise(a.name) === normalise(r.title) &&
          normalise(a.albumArtist) === normalise(c.artist)
      )
    ) {
      found.push(`${c.artist} – ${r.title}`);
    }
  }
  return found;
};

/** The cover as a JPEG, and whether it should replace the embedded art */
const loadCover = async (
  upload: MusicUpload,
  c: CustomImport,
  tracks: CustomTrack[]
) => {
  const images = upload.files.map((f) => f.path).filter(isImage);
  const chosen =
    c.cover ??
    images.find((p) => /^(cover|folder|front)\./i.test(path.basename(p))) ??
    images[0];
  let source: Buffer | undefined;
  if (chosen) {
    source = await fs.readFile(path.join(albumDir(upload.id), chosen));
  } else {
    // No image uploaded: keep each file's own art and copy it to cover.jpg
    for (const t of tracks) {
      const meta = await parseFile(
        path.join(albumDir(upload.id), t.path)
      ).catch(() => null);
      const picture = meta?.common.picture?.[0];
      if (picture) {
        source = Buffer.from(picture.data);
        break;
      }
    }
  }
  if (!source) return null;
  const data = await sharp(source)
    .rotate()
    .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { data, embed: !!chosen };
};

const writeTags = (
  file: string,
  c: CustomImport,
  album: string,
  t: CustomTrack,
  tracks: CustomTrack[],
  cover: { data: Buffer; embed: boolean } | null
) => {
  const f = TagFile.createFromPath(file);
  try {
    const tag = f.tag;
    tag.title = t.title;
    tag.performers = [t.artist || c.artist];
    tag.albumArtists = [c.artist];
    tag.album = album;
    tag.year = Number(c.year) || 0;
    tag.track = t.track;
    tag.trackCount = tracks.filter((x) => x.disc === t.disc).length;
    tag.disc = t.disc;
    tag.discCount = Math.max(...tracks.map((x) => x.disc));
    if (c.genre) tag.genres = [c.genre];
    if (cover?.embed) {
      tag.pictures = [
        Picture.fromFullData(
          ByteVector.fromByteArray(cover.data),
          PictureType.FrontCover,
          'image/jpeg',
          ''
        ),
      ];
    }
    f.save();
  } finally {
    f.dispose();
  }
};

const runCustomImport = async (upload: MusicUpload, c: CustomImport) => {
  const done: string[] = [];
  for (const [i, r] of customReleases(c).entries()) {
    const folder = releaseFolder(c, r.title);
    // Built in a hidden folder and renamed at the end, so a failure never
    // leaves half an album in the library
    const partial = path.join(
      path.dirname(folder),
      `.partial-${upload.id}-${i}`
    );
    await fs.mkdir(partial, { recursive: true, mode: 0o777 });
    try {
      const cover = await loadCover(upload, c, r.tracks);
      const discCount = Math.max(...r.tracks.map((t) => t.disc));
      for (const t of r.tracks) {
        const source = path.join(albumDir(upload.id), t.path);
        writeTags(source, c, r.title, t, r.tracks, cover);
        // Copy, not rename: the inbox and library are separate mounts
        const target = path.join(partial, trackFileName(t, discCount));
        await fs.copyFile(source, target);
        await fs.chmod(target, 0o666);
      }
      if (cover) {
        const coverPath = path.join(partial, 'cover.jpg');
        await fs.writeFile(coverPath, cover.data);
        await fs.chmod(coverPath, 0o666);
      }
      // Open permissions like the inbox, so the host user can merge later
      await fs.chmod(path.dirname(folder), 0o777);
      await fs.chmod(partial, 0o777);
      await fs.rename(partial, folder);
      done.push(folder);
    } catch (e) {
      await fs.rm(partial, { recursive: true, force: true });
      throw new Error(
        done.length
          ? `${e.message} (${done.length} of the singles were already added)`
          : e.message
      );
    }
  }

  const used = new Set(c.tracks.map((t) => t.path));
  const left = audioFiles(upload).filter((f) => !used.has(f.path)).length;
  if (left === 0) {
    await fs.rm(albumDir(upload.id), { recursive: true, force: true });
  }
  const names = done
    .map((d) => path.relative(customMusicDir() ?? '', d).replace(/\\/g, '/'))
    .join(', ');
  upload.status = 'imported';
  upload.selectedId = undefined;
  upload.result = {
    message: `Added ${c.tracks.length} tracks to ${names}.${
      left ? ` ${left} file(s) you didn't choose are still in the upload.` : ''
    }`,
    importedTracks: c.tracks.length,
  };

  try {
    await jellyfinClient()?.refreshLibraries();
  } catch (e) {
    logger.warn('Could not ask Jellyfin to scan', {
      label: 'Music Upload',
      errorMessage: e.message,
    });
  }
};

export class DuplicateError extends Error {
  constructor(public duplicates: string[]) {
    super(`Jellyfin already has ${duplicates.join(', ')}.`);
  }
}

export const startCustomImport = async (
  id: string,
  input: unknown,
  allowDuplicates: boolean
) => {
  if (!customConfigured()) {
    throw new Error('Set CUSTOM_MUSIC_DIR to use custom imports.');
  }
  const upload = await getUpload(id);
  if (!upload) throw new Error('Upload not found');
  if (upload.status === 'importing' || upload.status === 'imported') {
    throw new Error('This upload is already being added');
  }
  const custom = cleanCustom(upload, input);
  upload.custom = custom;
  await save(upload);

  for (const r of customReleases(custom)) {
    const folder = releaseFolder(custom, r.title);
    const exists = await fs.stat(folder).then(
      () => true,
      () => false
    );
    if (exists) {
      throw new Error(
        `${path
          .relative(customMusicDir() ?? '', folder)
          .replace(
            /\\/g,
            '/'
          )} is already in the custom library. Change the title or year, or remove that folder first.`
      );
    }
  }
  if (!allowDuplicates) {
    const duplicates = await findDuplicates(custom);
    if (duplicates.length) throw new DuplicateError(duplicates);
  }

  upload.status = 'importing';
  upload.result = undefined;
  await save(upload);

  // Copying a big album can take a while; the page polls for the result
  runCustomImport(upload, custom)
    .catch((e) => {
      logger.error('Custom music import failed', {
        label: 'Music Upload',
        uploadId: id,
        errorMessage: e.message,
      });
      upload.status = 'failed';
      upload.result = { message: e.message };
    })
    .finally(() => save(upload));

  return upload;
};
