import cacheManager from '@server/lib/cache';
import axios from 'axios';
import type {
  MusicAlbumResult,
  MusicArtistResult,
  MusicReleaseDetail,
  MusicSearchResults,
} from './interfaces';

/**
 * Read-only client for Lidarr's public metadata service (the "SkyHook" API
 * Lidarr itself uses). It serves MusicBrainz data with the same IDs, so it's
 * used as a fallback when musicbrainz.org can't be reached.
 */
const LIDARR_METADATA_URL = 'https://api.lidarr.audio/api/v0.4';

interface LmdImage {
  CoverType: string;
  Url: string;
  remoteUrl?: string;
}

interface LmdArtist {
  id: string;
  artistname: string;
  sortname?: string;
  disambiguation?: string;
  overview?: string | null;
  links?: { target: string; type: string }[];
  images?: LmdImage[];
  status?: string;
  genres?: string[];
  type?: string;
  Albums?: {
    Id: string;
    Title: string;
    Type: string;
    SecondaryTypes: string[];
    ReleaseStatuses?: string[];
    ReleaseDate: string;
  }[];
}

interface LmdTrack {
  Id: string;
  TrackName: string;
  TrackNumber: string;
  TrackPosition: number;
  MediumNumber: number;
  DurationMs: number | null;
}

interface LmdRelease {
  Id: string;
  Title: string;
  Status: string;
  Country?: string[];
  Media?: { Position: number; Format: string }[];
  ReleaseDate: string;
  TrackCount: number;
  Tracks?: LmdTrack[];
}

interface LmdAlbum {
  id: string;
  title: string;
  disambiguation?: string;
  type: string;
  secondarytypes?: string[];
  releasedate: string;
  artistid: string;
  genres?: string[];
  images?: LmdImage[];
  overview?: string | null;
  artists?: { id: string; artistname: string }[];
  Releases?: LmdRelease[];
}

const client = axios.create({
  baseURL: LIDARR_METADATA_URL,
  timeout: 15000,
  headers: { Accept: 'application/json' },
});

const responseCache = () => cacheManager.getCache('musicbrainz').data;

const get = async <T>(path: string, params?: Record<string, string>) => {
  const key = `lmd:${path}:${JSON.stringify(params ?? {})}`;
  const hit = responseCache().get<T>(key);
  if (hit !== undefined) {
    return hit;
  }
  const { data } = await client.get<T>(path, { params });
  responseCache().set(key, data);
  return data;
};

const image = (images: LmdImage[] | undefined, ...types: string[]) => {
  for (const type of types) {
    const found = images?.find((i) => i.CoverType === type);
    if (found) {
      return found.Url;
    }
  }
  return null;
};

const toArtist = (a: LmdArtist): MusicArtistResult => ({
  id: a.id,
  name: a.artistname,
  sortName: a.sortname ?? a.artistname,
  disambiguation: a.disambiguation ?? '',
  type: a.type ?? 'Unknown',
  country: '',
  genres: a.genres ?? [],
  tags: [],
  overview: a.overview ?? '',
  beginYear: '',
  endYear: null,
  ended: a.status === 'ended',
  posterUrl: image(a.images, 'Poster'),
  fanartUrl: image(a.images, 'Fanart'),
  links: (a.links ?? []).map((l) => ({ url: l.target, name: l.type })),
});

const toRelease = (r: LmdRelease) => ({
  id: r.Id,
  title: r.Title,
  status: r.Status ?? '',
  date: r.ReleaseDate ?? '',
  country: r.Country?.[0] ?? '',
  trackCount: r.TrackCount ?? 0,
  format: (r.Media ?? []).map((m) => m.Format).join(' + '),
});

const toAlbum = (a: LmdAlbum): MusicAlbumResult => ({
  id: a.id,
  title: a.title,
  primaryType: a.type ?? '',
  secondaryTypes: a.secondarytypes ?? [],
  firstReleaseDate: a.releasedate ?? '',
  disambiguation: a.disambiguation ?? '',
  artistName:
    a.artists?.find((artist) => artist.id === a.artistid)?.artistname ??
    a.artists?.[0]?.artistname ??
    '',
  artistId: a.artistid,
  genres: a.genres ?? [],
  tags: [],
  overview: a.overview ?? '',
  posterUrl: image(a.images, 'Cover'),
  releases: (a.Releases ?? []).map(toRelease),
});

const page = <T extends MusicArtistResult | MusicAlbumResult>(
  all: T[],
  limit: number,
  offset: number
): MusicSearchResults => ({
  page: Math.floor(offset / limit) + 1,
  totalPages: Math.ceil(all.length / limit),
  totalResults: all.length,
  results: all.slice(offset, offset + limit),
});

class LidarrMetadata {
  public async searchArtists(
    query: string,
    limit: number,
    offset: number
  ): Promise<MusicSearchResults> {
    const data = await get<LmdArtist[]>('/search', { type: 'artist', query });
    return page(data.map(toArtist), limit, offset);
  }

  public async searchAlbums(
    query: string,
    limit: number,
    offset: number
  ): Promise<MusicSearchResults> {
    const data = await get<LmdAlbum[]>('/search', { type: 'album', query });
    return page(data.map(toAlbum), limit, offset);
  }

  public async getArtist(mbId: string): Promise<MusicArtistResult> {
    return toArtist(await get<LmdArtist>(`/artist/${mbId}`));
  }

  public async getArtistAlbums(
    mbId: string,
    { type }: { type?: string } = {}
  ): Promise<MusicAlbumResult[]> {
    const artist = await get<LmdArtist>(`/artist/${mbId}`);
    return (artist.Albums ?? [])
      .filter((a) => !type || a.Type.toLowerCase() === type.toLowerCase())
      .map((a) => ({
        id: a.Id,
        title: a.Title,
        primaryType: a.Type,
        secondaryTypes: a.SecondaryTypes ?? [],
        firstReleaseDate: a.ReleaseDate ?? '',
        disambiguation: '',
        artistName: artist.artistname,
        artistId: artist.id,
        genres: [],
        tags: [],
        overview: '',
        posterUrl: null,
        releases: [],
      }));
  }

  public async getAlbum(mbId: string): Promise<MusicAlbumResult> {
    return toAlbum(await get<LmdAlbum>(`/album/${mbId}`));
  }

  public async getCoverArt(mbId: string): Promise<string | null> {
    const album = await get<LmdAlbum>(`/album/${mbId}`);
    return image(album.images, 'Cover');
  }

  public async getArtistImages(
    mbId: string
  ): Promise<{ poster: string | null; fanart: string | null }> {
    const artist = await get<LmdArtist>(`/artist/${mbId}`);
    return {
      poster: image(artist.images, 'Poster'),
      fanart: image(artist.images, 'Fanart'),
    };
  }

  /**
   * There is no release endpoint, so look the release up through the album
   * it belongs to (the album page always fetches the album first, so this
   * is normally served from cache).
   */
  public async getRelease(
    releaseId: string,
    albumMbId?: string
  ): Promise<MusicReleaseDetail | null> {
    if (!albumMbId) {
      return null;
    }
    const album = await get<LmdAlbum>(`/album/${albumMbId}`);
    const release = album.Releases?.find((r) => r.Id === releaseId);
    if (!release) {
      return null;
    }
    const tracks = [...(release.Tracks ?? [])]
      .sort(
        (a, b) =>
          a.MediumNumber - b.MediumNumber || a.TrackPosition - b.TrackPosition
      )
      .map((t, index) => ({
        id: t.Id,
        number: t.TrackNumber,
        title: t.TrackName,
        length: t.DurationMs,
        position: index + 1,
      }));
    return { ...toRelease(release), trackCount: tracks.length, tracks };
  }
}

export default LidarrMetadata;
