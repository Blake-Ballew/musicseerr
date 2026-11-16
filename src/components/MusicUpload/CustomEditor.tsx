import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { MusicalNoteIcon, PhotoIcon } from '@heroicons/react/24/outline';
import type {
  CustomImport,
  CustomTrack,
  MusicUpload as Upload,
} from '@server/lib/musicUploads';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.MusicUpload.CustomEditor', {
  heading: 'Add with your own details',
  explain:
    'For music that isn’t in MusicBrainz. The files are re-tagged with what you enter here and go straight to Jellyfin, skipping Lidarr.',
  artist: 'Artist',
  artistHint: 'Pick a suggestion if the artist is already in your library.',
  type: 'Type',
  typeAlbum: 'Album',
  typeEP: 'EP',
  typeSingle: 'Single (several tracks become separate singles)',
  album: 'Album title',
  year: 'Year',
  genre: 'Genre',
  cover: 'Cover',
  chooseCover: 'Choose image',
  coverFromFiles: 'Using {name} from your files',
  coverEmbedded: 'No image chosen. Each file keeps the art it already has.',
  include: 'Include',
  disc: 'Disc',
  number: '#',
  title: 'Title',
  trackArtist: 'Artist (if different)',
  renumber: 'Number in this order',
  titlesFromNames: 'Titles from file names',
  duplicates: 'This looks like it’s already in Jellyfin',
  addAnyway: 'Add anyway',
  add: 'Add to library',
  back: 'Back to album matching',
});

interface Row extends CustomTrack {
  include: boolean;
  duration?: number;
}

const fileTitle = (p: string) =>
  (p.split('/').pop() ?? p)
    .replace(/\.[^.]+$/, '')
    .replace(/^[\d\s.\-_]+/, '')
    .trim() || p;

const initialRows = (upload: Upload): Row[] => {
  const saved = new Map(upload.custom?.tracks.map((t) => [t.path, t]));
  return (upload.tracks ?? []).map((t, i) => ({
    path: t.path,
    duration: t.duration,
    include: !upload.custom || saved.has(t.path),
    title: saved.get(t.path)?.title ?? t.title ?? fileTitle(t.path),
    artist:
      saved.get(t.path)?.artist ??
      (t.artist && t.artist !== upload.album?.artist ? t.artist : ''),
    track: saved.get(t.path)?.track ?? t.track ?? i + 1,
    disc: saved.get(t.path)?.disc ?? t.disc ?? 1,
  }));
};

const formatDuration = (seconds?: number) =>
  seconds
    ? `${Math.floor(seconds / 60)}:${Math.round(seconds % 60)
        .toString()
        .padStart(2, '0')}`
    : '';

const CustomEditor = ({
  upload,
  onSaved,
  onBack,
  onError,
}: {
  upload: Upload;
  onSaved: () => Promise<unknown>;
  onBack: () => void;
  onError: (e: unknown) => void;
}) => {
  const intl = useIntl();
  const coverInput = useRef<HTMLInputElement>(null);
  const [artist, setArtist] = useState(
    upload.custom?.artist ?? upload.album?.artist ?? ''
  );
  const [album, setAlbum] = useState(
    upload.custom?.album ?? upload.album?.title ?? ''
  );
  const [year, setYear] = useState(
    upload.custom?.year ?? upload.album?.year ?? ''
  );
  const [genre, setGenre] = useState(upload.custom?.genre ?? '');
  const [type, setType] = useState<CustomImport['type']>(
    upload.custom?.type ??
      ((upload.tracks?.length ?? 0) === 1 ? 'Single' : 'Album')
  );
  const images = upload.files
    .map((f) => f.path)
    .filter((p) => /\.(jpe?g|png)$/i.test(p));
  const [cover, setCover] = useState<string | undefined>(
    upload.custom?.cover ??
      images.find((p) => /^(cover|folder|front)\./i.test(p)) ??
      images[0]
  );
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => initialRows(upload));
  const [duplicates, setDuplicates] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(
    () => () => {
      if (coverPreview) URL.revokeObjectURL(coverPreview);
    },
    [coverPreview]
  );

  const { data: artistSuggestions } = useSWR<string[]>(
    artist.trim().length >= 2
      ? `/api/v1/music/uploads/artists?q=${encodeURIComponent(artist.trim())}`
      : null
  );

  const included = rows.filter((r) => r.include);
  // Several tracks marked Single become one single each
  const singles = type === 'Single' && included.length > 1;

  const update = (path: string, change: Partial<Row>) =>
    setRows((current) =>
      current.map((r) => (r.path === path ? { ...r, ...change } : r))
    );

  const renumber = () => {
    const perDisc = new Map<number, number>();
    setRows((current) =>
      current.map((r) => {
        if (!r.include) return r;
        const n = (perDisc.get(r.disc) ?? 0) + 1;
        perDisc.set(r.disc, n);
        return { ...r, track: n };
      })
    );
  };

  const pickCover = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
    const name = `custom-cover-${Date.now()}.${ext}`;
    setBusy(true);
    try {
      await axios.put(`/api/v1/music/uploads/${upload.id}/files`, file, {
        params: { path: name },
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      setCover(name);
      setCoverPreview(URL.createObjectURL(file));
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (allowDuplicates = false) => {
    setBusy(true);
    try {
      await axios.post(`/api/v1/music/uploads/${upload.id}/custom`, {
        allowDuplicates,
        release: {
          artist,
          album,
          year,
          genre,
          cover,
          type,
          tracks: included.map(({ path, title, artist, track, disc }) => ({
            path,
            title,
            artist,
            track: singles ? 1 : track,
            disc: singles ? 1 : disc,
          })),
        },
      });
      setDuplicates([]);
      await onSaved();
    } catch (e) {
      if (axios.isAxiosError(e) && e.response?.status === 409) {
        setDuplicates(e.response.data.duplicates ?? []);
      } else {
        onError(e);
      }
    } finally {
      setBusy(false);
    }
  };

  const label = 'mb-1 block text-sm font-medium text-gray-300';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
            {intl.formatMessage(messages.heading)}
          </h3>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(messages.explain)}
          </p>
        </div>
        <button
          type="button"
          className="flex-shrink-0 text-sm text-indigo-400 hover:underline"
          onClick={onBack}
        >
          {intl.formatMessage(messages.back)}
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        {/* Cover */}
        <div>
          <span className={label}>{intl.formatMessage(messages.cover)}</span>
          <button
            type="button"
            onClick={() => coverInput.current?.click()}
            disabled={busy}
            className="flex h-32 w-32 items-center justify-center overflow-hidden rounded bg-gray-700 ring-1 ring-gray-600 hover:ring-indigo-500"
            aria-label={intl.formatMessage(messages.chooseCover)}
          >
            {coverPreview ? (
              <img
                src={coverPreview}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <PhotoIcon className="h-10 w-10 text-gray-400" />
            )}
          </button>
          <input
            ref={coverInput}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={pickCover}
          />
          {images.length > 1 && !coverPreview ? (
            <select
              className="mt-2 w-32 text-xs"
              value={cover ?? ''}
              onChange={(e) => setCover(e.target.value || undefined)}
              aria-label={intl.formatMessage(messages.cover)}
            >
              {images.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          ) : (
            <p className="mt-2 w-32 text-xs text-gray-400">
              {coverPreview
                ? ''
                : cover
                  ? intl.formatMessage(messages.coverFromFiles, { name: cover })
                  : intl.formatMessage(messages.coverEmbedded)}
            </p>
          )}
        </div>

        {/* Release details */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className={label}>{intl.formatMessage(messages.artist)}</span>
            <input
              type="text"
              required
              value={artist}
              onChange={(e) => setArtist(e.target.value)}
              list={`artists-${upload.id}`}
              autoComplete="off"
            />
            <datalist id={`artists-${upload.id}`}>
              {artistSuggestions?.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <span className="mt-1 block text-xs text-gray-400">
              {intl.formatMessage(messages.artistHint)}
            </span>
          </label>
          <label>
            <span className={label}>{intl.formatMessage(messages.type)}</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as CustomImport['type'])}
            >
              <option value="Album">
                {intl.formatMessage(messages.typeAlbum)}
              </option>
              <option value="EP">{intl.formatMessage(messages.typeEP)}</option>
              <option value="Single">
                {intl.formatMessage(messages.typeSingle)}
              </option>
            </select>
          </label>
          {!singles && (
            <label>
              <span className={label}>{intl.formatMessage(messages.album)}</span>
              <input
                type="text"
                required
                value={album}
                onChange={(e) => setAlbum(e.target.value)}
              />
            </label>
          )}
          <label>
            <span className={label}>{intl.formatMessage(messages.year)}</span>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{4}"
              maxLength={4}
              value={year}
              onChange={(e) => setYear(e.target.value)}
            />
          </label>
          <label>
            <span className={label}>{intl.formatMessage(messages.genre)}</span>
            <input
              type="text"
              value={genre}
              onChange={(e) => setGenre(e.target.value)}
            />
          </label>
        </div>
      </div>

      {/* Tracks */}
      <div className="mt-5 flex flex-wrap justify-end gap-3 text-sm">
        <button
          type="button"
          className="text-indigo-400 hover:underline"
          onClick={() =>
            setRows((current) =>
              current.map((r) => ({ ...r, title: fileTitle(r.path) }))
            )
          }
        >
          {intl.formatMessage(messages.titlesFromNames)}
        </button>
        {!singles && (
          <button
            type="button"
            className="text-indigo-400 hover:underline"
            onClick={renumber}
          >
            {intl.formatMessage(messages.renumber)}
          </button>
        )}
      </div>
      <div className="mt-2 max-h-[28rem] overflow-auto rounded ring-1 ring-gray-700">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-gray-900 text-left text-xs uppercase text-gray-400">
            <tr>
              <th className="px-2 py-2">
                <span className="sr-only">
                  {intl.formatMessage(messages.include)}
                </span>
              </th>
              {!singles && (
                <>
                  <th className="w-14 px-1 py-2">
                    {intl.formatMessage(messages.disc)}
                  </th>
                  <th className="w-14 px-1 py-2">
                    {intl.formatMessage(messages.number)}
                  </th>
                </>
              )}
              <th className="px-1 py-2">{intl.formatMessage(messages.title)}</th>
              <th className="px-1 py-2">
                {intl.formatMessage(messages.trackArtist)}
              </th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {rows.map((r) => (
              <tr key={r.path} className={r.include ? '' : 'opacity-50'}>
                <td className="px-2 py-1">
                  <input
                    type="checkbox"
                    checked={r.include}
                    onChange={(e) =>
                      update(r.path, { include: e.target.checked })
                    }
                    aria-label={`${intl.formatMessage(messages.include)} ${r.path}`}
                  />
                </td>
                {!singles && (
                  <>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        min={1}
                        value={r.disc}
                        onChange={(e) =>
                          update(r.path, { disc: Number(e.target.value) })
                        }
                        className="w-14"
                        aria-label={intl.formatMessage(messages.disc)}
                      />
                    </td>
                    <td className="px-1 py-1">
                      <input
                        type="number"
                        min={1}
                        value={r.track}
                        onChange={(e) =>
                          update(r.path, { track: Number(e.target.value) })
                        }
                        className="w-14"
                        aria-label={intl.formatMessage(messages.number)}
                      />
                    </td>
                  </>
                )}
                <td className="px-1 py-1">
                  <input
                    type="text"
                    required={r.include}
                    value={r.title}
                    onChange={(e) => update(r.path, { title: e.target.value })}
                    title={r.path}
                    aria-label={intl.formatMessage(messages.title)}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={r.artist ?? ''}
                    placeholder={artist}
                    onChange={(e) => update(r.path, { artist: e.target.value })}
                    aria-label={intl.formatMessage(messages.trackArtist)}
                  />
                </td>
                <td className="px-2 py-1 text-right text-gray-500">
                  {formatDuration(r.duration)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {duplicates.length > 0 && (
        <div className="mt-4">
          <Alert title={intl.formatMessage(messages.duplicates)}>
            <ul className="list-disc space-y-1 pl-4">
              {duplicates.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            <div className="mt-3">
              <Button
                buttonType="warning"
                buttonSize="sm"
                disabled={busy}
                onClick={() => submit(true)}
              >
                {intl.formatMessage(messages.addAnyway)}
              </Button>
            </div>
          </Alert>
        </div>
      )}

      <div className="mt-5 flex justify-end">
        <Button
          type="submit"
          buttonType="primary"
          disabled={busy || included.length === 0}
        >
          <MusicalNoteIcon />
          <span>{intl.formatMessage(messages.add)}</span>
        </Button>
      </div>
    </form>
  );
};

export default CustomEditor;
