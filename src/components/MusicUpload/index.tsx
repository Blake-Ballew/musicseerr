import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import RipGuide from '@app/components/MusicUpload/RipGuide';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowUpTrayIcon,
  CheckBadgeIcon,
  MagnifyingGlassIcon,
  MusicalNoteIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type {
  MusicUpload as Upload,
  UploadCandidate,
} from '@server/lib/musicUploads';
import axios from 'axios';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages('components.MusicUpload', {
  title: 'Upload Music',
  subtitle:
    'Add albums you own, like your CD rips and purchased downloads, to the library.',
  notConfigured: 'Uploads are not set up yet',
  notConfiguredBody:
    'Create a folder that both MusicSeerr and Lidarr can see, mount it into both containers, and set MUSIC_UPLOAD_DIR to it. The README explains how.',
  dropTitle: 'Drag an album folder here',
  dropOr: 'or',
  chooseFolder: 'Choose album folder',
  dropHint: 'One album at a time. FLAC is best, MP3 works too.',
  oneAlbumOnly:
    'That looks like more than one folder. Upload one album at a time (a 2-CD set counts as one album).',
  noMusicFiles: 'No music files found in what you dropped.',
  skipped: '{count} file(s) skipped because they are not music or artwork.',
  uploading: 'Uploading {done} of {total} files…',
  checking: 'Checking your files and finding the album…',
  uploadFailed: 'Upload failed: {message}',
  inYourFiles: 'In your files',
  tracks: '{count} tracks',
  discs: '{count} discs',
  showTracks: 'Show tracks',
  hideTracks: 'Hide tracks',
  unknownAlbum: 'Unknown album',
  unknownArtist: 'Unknown artist',
  problems: 'Fix these before adding',
  warnings: 'Worth checking',
  whichAlbum: 'Which album is this?',
  tagged: 'Exact match from tags',
  trackCountMatch: '{count} tracks, matches your upload',
  trackCountMismatch: 'This album has {counts} tracks; you uploaded {count}',
  noCandidates: 'No matching albums found. Try searching below.',
  searchPlaceholder: 'Search for the album, e.g. "Alestorm Black Sails"',
  search: 'Search',
  addToLibrary: 'Add to library',
  tryAgain: 'Try again',
  delete: 'Delete upload',
  importing:
    'Adding to the library… This can take a few minutes for a new artist.',
  imported: 'Added to the library',
  viewAlbum: 'View album',
  needsReview: 'Some files were not added',
  needsReviewHelp:
    'The files are still on the server. Check the album choice and try again, or open Lidarr → Wanted → Manual Import to sort them out by hand.',
  failed: 'Something went wrong',
  recent: 'Recent uploads',
  untitled: 'Untitled upload',
  by: '{date} by {name}',
  statusuploading: 'Not finished',
  statusanalyzing: 'Checking',
  statusready: 'Waiting for you',
  statusimporting: 'Adding',
  statusimported: 'Added',
  'statusneeds-review': 'Needs review',
  statusfailed: 'Failed',
  newUpload: 'Upload another album',
  backToUpload: '← Upload a different album',
});

const AUDIO = [
  'flac',
  'mp3',
  'm4a',
  'aac',
  'ogg',
  'opus',
  'wav',
  'aiff',
  'ape',
  'wv',
];
const EXTRAS = ['jpg', 'jpeg', 'png', 'cue', 'log'];

const extension = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';

interface PickedFile {
  file: File;
  path: string;
}

/** Read every file in a dropped folder (browsers hand them over lazily) */
const readEntry = async (
  entry: FileSystemEntry,
  prefix = ''
): Promise<PickedFile[]> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject)
    );
    return [{ file, path: prefix + entry.name }];
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns results in batches until it returns none
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject)
    );
    if (!batch.length) break;
    children.push(...batch);
  }
  const nested = await Promise.all(
    children.map((child) => readEntry(child, `${prefix}${entry.name}/`))
  );
  return nested.flat();
};

/** Drop the album folder's own name so paths are like "CD1/01 Song.flac" */
const stripRoot = (files: PickedFile[]) => {
  const roots = new Set(
    files.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : ''))
  );
  if (roots.size === 1 && !roots.has('')) {
    return files.map((f) => ({
      ...f,
      path: f.path.split('/').slice(1).join('/'),
    }));
  }
  return files;
};

const formatDuration = (seconds?: number) => {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};

const formatBytes = (bytes?: number) => {
  if (!bytes) return '';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes < 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
};

const statusBadge = (status: Upload['status']) =>
  status === 'imported'
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : status === 'needs-review' || status === 'ready'
        ? 'warning'
        : 'default';

const MusicUpload = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    bytes: number;
    totalBytes: number;
    checking: boolean;
  } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [showTracks, setShowTracks] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, mutate } = useSWR<{ configured: boolean; uploads: Upload[] }>(
    '/api/v1/music/uploads',
    {
      refreshInterval: (latest) =>
        latest?.uploads.some(
          (u) => u.status === 'importing' || u.status === 'analyzing'
        )
          ? 3000
          : 0,
    }
  );

  const active = data?.uploads.find((u) => u.id === activeId) ?? null;

  const errorMessage = (e: unknown) =>
    axios.isAxiosError(e)
      ? (e.response?.data?.message ?? e.message)
      : (e as Error).message;

  const startUpload = async (picked: PickedFile[]) => {
    const roots = new Set(
      picked.map((f) => (f.path.includes('/') ? f.path.split('/')[0] : ''))
    );
    if (roots.size > 1 && !roots.has('')) {
      addToast(intl.formatMessage(messages.oneAlbumOnly), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }

    const files = stripRoot(picked).filter((f) =>
      [...AUDIO, ...EXTRAS].includes(extension(f.path))
    );
    const skipped = picked.length - files.length;
    if (!files.some((f) => AUDIO.includes(extension(f.path)))) {
      addToast(intl.formatMessage(messages.noMusicFiles), {
        appearance: 'error',
        autoDismiss: true,
      });
      return;
    }
    if (skipped > 0) {
      addToast(intl.formatMessage(messages.skipped, { count: skipped }), {
        appearance: 'info',
        autoDismiss: true,
      });
    }

    const totalBytes = files.reduce((sum, f) => sum + f.file.size, 0);
    setProgress({
      done: 0,
      total: files.length,
      bytes: 0,
      totalBytes,
      checking: false,
    });
    setShowTracks(false);
    setSearchText('');

    try {
      const { data: upload } = await axios.post<Upload>(
        '/api/v1/music/uploads'
      );
      setActiveId(upload.id);
      let sent = 0;
      for (const [i, f] of files.entries()) {
        await axios.put(`/api/v1/music/uploads/${upload.id}/files`, f.file, {
          params: { path: f.path },
          headers: { 'Content-Type': 'application/octet-stream' },
          onUploadProgress: (e) =>
            setProgress((p) =>
              p ? { ...p, bytes: sent + (e.loaded ?? 0) } : p
            ),
        });
        sent += f.file.size;
        setProgress((p) => (p ? { ...p, done: i + 1, bytes: sent } : p));
      }
      setProgress((p) => (p ? { ...p, checking: true } : p));
      await axios.post(`/api/v1/music/uploads/${upload.id}/analyze`);
      await mutate();
    } catch (e) {
      addToast(
        intl.formatMessage(messages.uploadFailed, {
          message: errorMessage(e),
        }),
        { appearance: 'error', autoDismiss: true }
      );
      await mutate();
    } finally {
      setProgress(null);
    }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const entries = [...event.dataTransfer.items]
      .map((item) => item.webkitGetAsEntry())
      .filter((e): e is FileSystemEntry => !!e);
    const picked = (await Promise.all(entries.map((e) => readEntry(e)))).flat();
    if (picked.length) {
      startUpload(picked);
    }
  };

  const onPickFolder = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = [...(event.target.files ?? [])].map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    }));
    event.target.value = '';
    if (picked.length) {
      startUpload(picked);
    }
  };

  const select = (candidate: UploadCandidate) => {
    if (!active) return;
    mutate(
      (current) =>
        current && {
          ...current,
          uploads: current.uploads.map((u) =>
            u.id === active.id ? { ...u, selectedId: candidate.id } : u
          ),
        },
      { revalidate: false }
    );
  };

  const search = async () => {
    if (!active || !searchText.trim()) return;
    setBusy(true);
    try {
      await axios.post(`/api/v1/music/uploads/${active.id}/search`, {
        query: searchText,
      });
      await mutate();
    } catch (e) {
      addToast(errorMessage(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setBusy(false);
    }
  };

  const addToLibrary = async () => {
    if (!active?.selectedId) return;
    setBusy(true);
    try {
      await axios.post(`/api/v1/music/uploads/${active.id}/import`, {
        albumId: active.selectedId,
      });
      await mutate();
    } catch (e) {
      addToast(errorMessage(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (upload: Upload) => {
    setBusy(true);
    try {
      await axios.delete(`/api/v1/music/uploads/${upload.id}`);
      if (upload.id === activeId) setActiveId(null);
      await mutate();
    } catch (e) {
      addToast(errorMessage(e), { appearance: 'error', autoDismiss: true });
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return <LoadingSpinner />;
  }

  const errors = active?.issues?.filter((i) => i.level === 'error') ?? [];
  const warnings = active?.issues?.filter((i) => i.level === 'warning') ?? [];
  const selected = active?.candidates?.find((c) => c.id === active.selectedId);
  const canChoose =
    active?.status === 'ready' ||
    active?.status === 'needs-review' ||
    active?.status === 'failed';

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-6">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.title)}
        </Header>
      </div>

      {!data.configured && (
        <Alert type="error" title={intl.formatMessage(messages.notConfigured)}>
          {intl.formatMessage(messages.notConfiguredBody)}
        </Alert>
      )}

      <RipGuide defaultOpen={data.uploads.length === 0} />

      {data.configured && !active && (
        <div
          className={`mb-8 flex flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-12 text-center transition ${
            dragging
              ? 'border-indigo-400 bg-indigo-500/10'
              : 'border-gray-600 bg-gray-800/40'
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={progress ? undefined : onDrop}
        >
          {progress ? (
            <div className="w-full max-w-md">
              <p className="mb-3 text-gray-200">
                {progress.checking
                  ? intl.formatMessage(messages.checking)
                  : intl.formatMessage(messages.uploading, {
                      done: Math.min(progress.done + 1, progress.total),
                      total: progress.total,
                    })}
              </p>
              <div className="h-3 overflow-hidden rounded-full bg-gray-700">
                <div
                  className="h-full bg-indigo-500 transition-all"
                  style={{
                    width: `${
                      progress.checking
                        ? 100
                        : Math.round(
                            (progress.bytes / (progress.totalBytes || 1)) * 100
                          )
                    }%`,
                  }}
                />
              </div>
              <p className="mt-2 text-sm text-gray-400">
                {formatBytes(progress.bytes)} /{' '}
                {formatBytes(progress.totalBytes)}
              </p>
            </div>
          ) : (
            <>
              <ArrowUpTrayIcon className="mb-3 h-12 w-12 text-gray-400" />
              <p className="text-lg font-semibold text-white">
                {intl.formatMessage(messages.dropTitle)}
              </p>
              <p className="my-2 text-gray-400">
                {intl.formatMessage(messages.dropOr)}
              </p>
              <Button
                buttonType="primary"
                onClick={() => folderInput.current?.click()}
              >
                {intl.formatMessage(messages.chooseFolder)}
              </Button>
              <input
                ref={folderInput}
                type="file"
                className="hidden"
                multiple
                onChange={onPickFolder}
                {...{ webkitdirectory: '', directory: '' }}
              />
              <p className="mt-4 text-sm text-gray-400">
                {intl.formatMessage(messages.dropHint)}
              </p>
            </>
          )}
        </div>
      )}

      {active && (
        <div className="mb-8 rounded-xl bg-gray-800 p-5 ring-1 ring-gray-700">
          {active.status !== 'imported' && (
            <div className="-mt-1 mb-2 flex justify-end">
              <button
                type="button"
                className="text-sm text-indigo-400 hover:underline"
                onClick={() => setActiveId(null)}
              >
                {intl.formatMessage(messages.backToUpload)}
              </button>
            </div>
          )}
          <div className="grid gap-6 lg:grid-cols-5">
            {/* What the files say */}
            <div className="lg:col-span-2">
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
                {intl.formatMessage(messages.inYourFiles)}
              </h3>
              <p className="text-xl font-bold text-white">
                {active.album?.title ??
                  intl.formatMessage(messages.unknownAlbum)}
              </p>
              <p className="text-gray-300">
                {active.album?.artist ??
                  intl.formatMessage(messages.unknownArtist)}
                {active.album?.year ? ` · ${active.album.year}` : ''}
              </p>
              <p className="mt-1 text-sm text-gray-400">
                {intl.formatMessage(messages.tracks, {
                  count: active.album?.trackCount ?? active.files.length,
                })}
                {(active.album?.discCount ?? 1) > 1 &&
                  ` · ${intl.formatMessage(messages.discs, {
                    count: active.album?.discCount,
                  })}`}
                {active.album?.format ? ` · ${active.album.format}` : ''}
                {active.totalBytes
                  ? ` · ${formatBytes(active.totalBytes)}`
                  : ''}
              </p>
              {!!active.tracks?.length && (
                <button
                  type="button"
                  className="mt-2 text-sm text-indigo-400 hover:underline"
                  onClick={() => setShowTracks(!showTracks)}
                >
                  {intl.formatMessage(
                    showTracks ? messages.hideTracks : messages.showTracks
                  )}
                </button>
              )}
              {showTracks && (
                <ol className="mt-2 max-h-72 space-y-0.5 overflow-y-auto text-sm text-gray-300">
                  {active.tracks?.map((t) => (
                    <li key={t.path} className="flex gap-2">
                      <span className="w-10 flex-shrink-0 text-right text-gray-500">
                        {(active.album?.discCount ?? 1) > 1 && t.disc
                          ? `${t.disc}-`
                          : ''}
                        {t.track ?? '?'}
                      </span>
                      <span className="flex-1 truncate">
                        {t.title ?? t.path}
                      </span>
                      <span className="text-gray-500">
                        {formatDuration(t.duration)}
                      </span>
                    </li>
                  ))}
                </ol>
              )}

              {errors.length > 0 && (
                <div className="mt-4">
                  <Alert
                    type="error"
                    title={intl.formatMessage(messages.problems)}
                  >
                    <ul className="list-disc space-y-1 pl-4">
                      {errors.map((i) => (
                        <li key={i.message}>{i.message}</li>
                      ))}
                    </ul>
                  </Alert>
                </div>
              )}
              {warnings.length > 0 && (
                <div className="mt-4">
                  <Alert title={intl.formatMessage(messages.warnings)}>
                    <ul className="list-disc space-y-1 pl-4">
                      {warnings.map((i) => (
                        <li key={i.message}>{i.message}</li>
                      ))}
                    </ul>
                  </Alert>
                </div>
              )}
            </div>

            {/* Which album it is */}
            <div className="lg:col-span-3">
              {active.status === 'analyzing' ||
              active.status === 'uploading' ? (
                <LoadingSpinner />
              ) : active.status === 'importing' ? (
                <div className="flex h-full flex-col items-center justify-center py-10 text-center">
                  <LoadingSpinner />
                  <p className="text-gray-300">
                    {intl.formatMessage(messages.importing)}
                  </p>
                </div>
              ) : active.status === 'imported' ? (
                <div className="flex h-full flex-col items-center justify-center py-10 text-center">
                  <CheckBadgeIcon className="mb-2 h-14 w-14 text-green-500" />
                  <p className="text-lg font-bold text-white">
                    {intl.formatMessage(messages.imported)}
                  </p>
                  <p className="mb-4 text-gray-300">{active.result?.message}</p>
                  <div className="flex gap-2">
                    {active.selectedId && (
                      <Link href={`/music/album/${active.selectedId}`}>
                        <Button buttonType="ghost">
                          {intl.formatMessage(messages.viewAlbum)}
                        </Button>
                      </Link>
                    )}
                    <Button
                      buttonType="primary"
                      onClick={() => setActiveId(null)}
                    >
                      {intl.formatMessage(messages.newUpload)}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {(active.status === 'needs-review' ||
                    active.status === 'failed') && (
                    <div className="mb-4">
                      <Alert
                        type="error"
                        title={intl.formatMessage(
                          active.status === 'failed'
                            ? messages.failed
                            : messages.needsReview
                        )}
                      >
                        <p>{active.result?.message}</p>
                        {active.result?.leftoverFiles?.length ? (
                          <ul className="mt-2 list-disc space-y-1 pl-4">
                            {active.result.leftoverFiles
                              .slice(0, 8)
                              .map((f) => (
                                <li key={f.path}>
                                  {f.path}
                                  {f.reasons.length
                                    ? `: ${f.reasons.join('; ')}`
                                    : ''}
                                </li>
                              ))}
                          </ul>
                        ) : null}
                        {active.status === 'needs-review' && (
                          <p className="mt-2">
                            {intl.formatMessage(messages.needsReviewHelp)}
                          </p>
                        )}
                      </Alert>
                    </div>
                  )}

                  <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
                    {intl.formatMessage(messages.whichAlbum)}
                  </h3>
                  {active.candidates?.length ? (
                    <div className="space-y-2">
                      {active.candidates.map((c) => {
                        const isSelected = c.id === active.selectedId;
                        const count = active.album?.trackCount ?? 0;
                        return (
                          <button
                            type="button"
                            key={c.id}
                            disabled={!canChoose}
                            onClick={() => select(c)}
                            className={`flex w-full items-center gap-4 rounded-lg p-2 text-left ring-1 transition ${
                              isSelected
                                ? 'bg-indigo-500/20 ring-indigo-500'
                                : 'bg-gray-900/40 ring-gray-700 hover:ring-gray-500'
                            }`}
                          >
                            <img
                              src={`/api/v1/music/cover/${c.id}`}
                              alt=""
                              width={64}
                              height={64}
                              className="h-16 w-16 flex-shrink-0 rounded bg-gray-700 object-cover"
                              onError={(e) => {
                                e.currentTarget.style.visibility = 'hidden';
                              }}
                            />
                            <div className="min-w-0 flex-1">
                              <p className="truncate font-semibold text-white">
                                {c.title}
                              </p>
                              <p className="truncate text-sm text-gray-300">
                                {c.artistName}
                                {c.year ? ` · ${c.year}` : ''}
                                {c.type ? ` · ${c.type}` : ''}
                              </p>
                              <p
                                className={`text-xs ${
                                  c.trackCountMatches
                                    ? 'text-green-400'
                                    : 'text-yellow-400'
                                }`}
                              >
                                {c.trackCountMatches
                                  ? intl.formatMessage(
                                      messages.trackCountMatch,
                                      {
                                        count,
                                      }
                                    )
                                  : c.trackCounts.length
                                    ? intl.formatMessage(
                                        messages.trackCountMismatch,
                                        {
                                          counts: c.trackCounts.join(' or '),
                                          count,
                                        }
                                      )
                                    : ''}
                              </p>
                            </div>
                            {c.exact && (
                              <Badge badgeType="success">
                                {intl.formatMessage(messages.tagged)}
                              </Badge>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="text-gray-400">
                      {intl.formatMessage(messages.noCandidates)}
                    </p>
                  )}

                  {canChoose && (
                    <form
                      className="mt-3 flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        search();
                      }}
                    >
                      <input
                        type="text"
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        placeholder={intl.formatMessage(
                          messages.searchPlaceholder
                        )}
                        className="flex-1"
                      />
                      <Button type="submit" disabled={busy}>
                        <MagnifyingGlassIcon />
                        <span>{intl.formatMessage(messages.search)}</span>
                      </Button>
                    </form>
                  )}

                  <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <Button
                      buttonType="danger"
                      disabled={busy}
                      onClick={() => remove(active)}
                    >
                      <TrashIcon />
                      <span>{intl.formatMessage(messages.delete)}</span>
                    </Button>
                    <Button
                      buttonType="primary"
                      disabled={
                        busy || !selected || errors.length > 0 || !canChoose
                      }
                      onClick={addToLibrary}
                    >
                      <MusicalNoteIcon />
                      <span>
                        {intl.formatMessage(
                          active.status === 'ready'
                            ? messages.addToLibrary
                            : messages.tryAgain
                        )}
                      </span>
                    </Button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {data.uploads.length > 0 && (
        <>
          <h2 className="mb-3 text-lg font-bold text-white">
            {intl.formatMessage(messages.recent)}
          </h2>
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700">
            {data.uploads.map((u) => (
              <li
                key={u.id}
                className={`flex items-center gap-3 px-4 py-3 ${
                  u.id === activeId ? 'bg-gray-700/50' : ''
                }`}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => {
                    setActiveId(u.id);
                    setShowTracks(false);
                  }}
                >
                  <p className="truncate font-semibold text-white">
                    {u.album?.title
                      ? `${u.album.artist ?? ''} – ${u.album.title}`
                      : intl.formatMessage(messages.untitled)}
                  </p>
                  <p className="text-xs text-gray-400">
                    {intl.formatMessage(messages.by, {
                      date: intl.formatDate(u.createdAt, {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      }),
                      name: u.createdBy.displayName,
                    })}
                  </p>
                </button>
                <Badge badgeType={statusBadge(u.status)}>
                  {intl.formatMessage(
                    messages[`status${u.status}` as keyof typeof messages]
                  )}
                </Badge>
                {u.status !== 'importing' && (
                  <button
                    type="button"
                    className="text-gray-500 hover:text-red-400"
                    onClick={() => remove(u)}
                    disabled={busy}
                    aria-label={intl.formatMessage(messages.delete)}
                  >
                    <TrashIcon className="h-5 w-5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
};

export default MusicUpload;
