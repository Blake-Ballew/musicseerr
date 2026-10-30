import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import logger from '@server/logger';
import type {
  CoverArtArchiveResponse,
  MusicAlbumResult,
  MusicArtistResult,
  MusicBrainzArtist,
  MusicBrainzArtistCredit,
  MusicBrainzRelease,
  MusicBrainzReleaseGroup,
  MusicBrainzSearchResponse,
  MusicReleaseDetail,
  MusicSearchResults,
} from './interfaces';
import LidarrMetadata from './lidarrMetadata';

const MUSICBRAINZ_API_URL = 'https://musicbrainz.org/ws/2';
const COVERART_API_URL = 'https://coverartarchive.org';
const FANART_API_URL = 'https://webservice.fanart.tv/v3/music';
const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';

// MusicBrainz rate limit: 1 request per second. The limit is per client IP,
// so requests are queued process-wide rather than per MusicBrainz instance.
const REQUEST_INTERVAL_MS = 1100;
let lastRequestTime = 0;
let requestQueue: Promise<void> = Promise.resolve();

const waitForTurn = (): Promise<void> => {
  const turn = requestQueue.then(async () => {
    const wait = lastRequestTime + REQUEST_INTERVAL_MS - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastRequestTime = Date.now();
  });
  requestQueue = turn.catch(() => undefined);
  return turn;
};

// Responses rarely change, so cache them (6h, the musicbrainz cache default)
const responseCache = () => cacheManager.getCache('musicbrainz').data;

const cached = async <T>(
  key: string,
  fetcher: () => Promise<T>
): Promise<T> => {
  const hit = responseCache().get<T>(key);
  if (hit !== undefined) {
    return hit;
  }
  const value = await fetcher();
  responseCache().set(key, value);
  return value;
};

// When musicbrainz.org is unreachable (outage, or MetaBrainz blocking the
// server's IP), fall back to Lidarr's metadata service for a while instead
// of failing every page
const FALLBACK_WINDOW_MS = 5 * 60 * 1000;
let musicBrainzUnavailableUntil = 0;
const lidarrMetadata = new LidarrMetadata();

const isUnavailableError = (e: unknown): boolean => {
  let err = e as
    | { cause?: unknown; response?: { status?: number } }
    | undefined;
  // Our methods wrap the axios error as `cause`
  while (err?.cause && !err.response) {
    err = err.cause as typeof err;
  }
  const status = err?.response?.status;
  return status === undefined || status === 429 || status >= 500;
};

class MusicBrainz extends ExternalAPI {
  private fanartApiKey: string | null = null;
  private lastfmApiKey: string | null = null;

  constructor(fanartApiKey?: string, lastfmApiKey?: string) {
    super(
      MUSICBRAINZ_API_URL,
      {},
      {
        nodeCache: cacheManager.getCache('musicbrainz').data,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'MusicSeerr/1.0.0 (https://github.com/musicseerr)',
        },
      }
    );

    this.fanartApiKey = fanartApiKey ?? null;
    this.lastfmApiKey = lastfmApiKey ?? null;
  }

  private async withFallback<T>(
    what: string,
    primary: () => Promise<T>,
    fallback: () => Promise<T>
  ): Promise<T> {
    if (Date.now() < musicBrainzUnavailableUntil) {
      return fallback();
    }
    try {
      return await primary();
    } catch (e) {
      if (!isUnavailableError(e)) {
        throw e;
      }
      musicBrainzUnavailableUntil = Date.now() + FALLBACK_WINDOW_MS;
      logger.warn(
        'MusicBrainz is unreachable, using Lidarr metadata for the next 5 minutes',
        { label: 'MusicBrainz', what, errorMessage: (e as Error).message }
      );
      return fallback();
    }
  }

  private async rateLimitedRequest<T>(
    path: string,
    params?: Record<string, string | number | undefined>
  ): Promise<T> {
    return cached(`mb:${path}:${JSON.stringify(params ?? {})}`, async () => {
      await waitForTurn();
      const response = await this.axios.get<T>(path, {
        params: {
          fmt: 'json',
          ...params,
        },
      });
      return response.data;
    });
  }

  private async mbSearchArtists({
    query,
    limit = 25,
    offset = 0,
  }: {
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<MusicSearchResults> {
    try {
      const data = await this.rateLimitedRequest<
        MusicBrainzSearchResponse<MusicBrainzArtist>
      >('/artist', {
        query,
        limit,
        offset,
      });

      const artists = data.artists ?? [];
      const results: MusicArtistResult[] = await Promise.all(
        artists.map(async (artist) => this.normaliseArtist(artist))
      );

      return {
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil((data.count ?? 0) / limit),
        totalResults: data.count ?? 0,
        results,
      };
    } catch (e) {
      logger.error('Failed to search MusicBrainz artists', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        query,
      });
      throw new Error('Failed to search artists', { cause: e });
    }
  }

  private async mbSearchAlbums({
    query,
    limit = 25,
    offset = 0,
  }: {
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<MusicSearchResults> {
    try {
      const data = await this.rateLimitedRequest<
        MusicBrainzSearchResponse<MusicBrainzReleaseGroup>
      >('/release-group', {
        query,
        limit,
        offset,
      });

      const releaseGroups = data['release-groups'] ?? [];
      const results: MusicAlbumResult[] = releaseGroups.map((rg) =>
        this.normaliseReleaseGroup(rg)
      );

      return {
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.ceil((data.count ?? 0) / limit),
        totalResults: data.count ?? 0,
        results,
      };
    } catch (e) {
      logger.error('Failed to search MusicBrainz release groups', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        query,
      });
      throw new Error('Failed to search albums', { cause: e });
    }
  }

  public async searchMulti({
    query,
    limit = 25,
    offset = 0,
  }: {
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<MusicSearchResults> {
    try {
      const [artistResults, albumResults] = await Promise.all([
        this.searchArtists({ query, limit: Math.ceil(limit / 2), offset }),
        this.searchAlbums({ query, limit: Math.floor(limit / 2), offset }),
      ]);

      // Interleave results: albums first (more likely what people want),
      // then artists
      const combined = [...albumResults.results, ...artistResults.results];

      return {
        page: Math.floor(offset / limit) + 1,
        totalPages: Math.max(artistResults.totalPages, albumResults.totalPages),
        totalResults: artistResults.totalResults + albumResults.totalResults,
        results: combined.slice(0, limit),
      };
    } catch (e) {
      logger.error('Failed to perform multi-search on MusicBrainz', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        query,
      });
      throw new Error('Failed to search music', { cause: e });
    }
  }

  private async mbGetArtist(mbId: string): Promise<MusicArtistResult> {
    try {
      const data = await this.rateLimitedRequest<MusicBrainzArtist>(
        `/artist/${mbId}`,
        {
          inc: 'genres+tags+url-rels',
        }
      );

      return this.normaliseArtist(data);
    } catch (e) {
      logger.error('Failed to get artist from MusicBrainz', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        mbId,
      });
      throw new Error('Failed to get artist', { cause: e });
    }
  }

  private async mbGetAlbum(mbId: string): Promise<MusicAlbumResult> {
    try {
      const data = await this.rateLimitedRequest<MusicBrainzReleaseGroup>(
        `/release-group/${mbId}`,
        {
          inc: 'artist-credits+genres+tags+releases',
        }
      );

      return this.normaliseReleaseGroup(data);
    } catch (e) {
      logger.error('Failed to get release group from MusicBrainz', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        mbId,
      });
      throw new Error('Failed to get album', { cause: e });
    }
  }

  private async mbGetArtistAlbums(
    artistMbId: string,
    {
      limit = 100,
      offset = 0,
      type,
    }: { limit?: number; offset?: number; type?: string } = {}
  ): Promise<MusicAlbumResult[]> {
    try {
      const params: Record<string, string | number | undefined> = {
        artist: artistMbId,
        limit,
        offset,
        inc: 'artist-credits',
      };

      if (type) {
        params.type = type;
      }

      const data = await this.rateLimitedRequest<
        MusicBrainzSearchResponse<MusicBrainzReleaseGroup>
      >('/release-group', params);

      const releaseGroups = data['release-groups'] ?? [];
      return releaseGroups.map((rg) => this.normaliseReleaseGroup(rg));
    } catch (e) {
      logger.error('Failed to get artist albums from MusicBrainz', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        artistMbId,
      });
      throw new Error('Failed to get artist albums', { cause: e });
    }
  }

  public async searchArtists(params: {
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<MusicSearchResults> {
    return this.withFallback(
      'searchArtists',
      () => this.mbSearchArtists(params),
      () =>
        lidarrMetadata.searchArtists(
          params.query,
          params.limit ?? 25,
          params.offset ?? 0
        )
    );
  }

  public async searchAlbums(params: {
    query: string;
    limit?: number;
    offset?: number;
  }): Promise<MusicSearchResults> {
    return this.withFallback(
      'searchAlbums',
      () => this.mbSearchAlbums(params),
      () =>
        lidarrMetadata.searchAlbums(
          params.query,
          params.limit ?? 25,
          params.offset ?? 0
        )
    );
  }

  public async getArtist(mbId: string): Promise<MusicArtistResult> {
    return this.withFallback(
      'getArtist',
      () => this.mbGetArtist(mbId),
      () => lidarrMetadata.getArtist(mbId)
    );
  }

  public async getAlbum(mbId: string): Promise<MusicAlbumResult> {
    return this.withFallback(
      'getAlbum',
      () => this.mbGetAlbum(mbId),
      () => lidarrMetadata.getAlbum(mbId)
    );
  }

  public async getArtistAlbums(
    artistMbId: string,
    options: { limit?: number; offset?: number; type?: string } = {}
  ): Promise<MusicAlbumResult[]> {
    return this.withFallback(
      'getArtistAlbums',
      () => this.mbGetArtistAlbums(artistMbId, options),
      () => lidarrMetadata.getArtistAlbums(artistMbId, options)
    );
  }

  public async getCoverArt(releaseGroupId: string): Promise<string | null> {
    if (Date.now() < musicBrainzUnavailableUntil) {
      return lidarrMetadata.getCoverArt(releaseGroupId).catch(() => null);
    }
    return this.caaGetCoverArt(releaseGroupId);
  }

  private async caaGetCoverArt(releaseGroupId: string): Promise<string | null> {
    try {
      const response = await cached(`caa:${releaseGroupId}`, () =>
        this.axios
          .get<CoverArtArchiveResponse>(
            `${COVERART_API_URL}/release-group/${releaseGroupId}`,
            {
              headers: { Accept: 'application/json' },
              timeout: 5000,
            }
          )
          .then((r) => ({ data: r.data }))
      );

      const front = response.data.images?.find((img) => img.front);
      if (front) {
        return (
          front.thumbnails?.['500'] ?? front.thumbnails?.large ?? front.image
        );
      }

      if (response.data.images?.[0]) {
        return (
          response.data.images[0].thumbnails?.['500'] ??
          response.data.images[0].image
        );
      }

      return null;
    } catch (e) {
      // Cover art isn't available for every release group; if the archive
      // itself is unreachable, use Lidarr's copy
      return isUnavailableError(e)
        ? lidarrMetadata.getCoverArt(releaseGroupId).catch(() => null)
        : null;
    }
  }

  public async getArtistImages(
    artistMbId: string
  ): Promise<{ poster: string | null; fanart: string | null }> {
    if (!this.fanartApiKey) {
      return lidarrMetadata
        .getArtistImages(artistMbId)
        .catch(() => ({ poster: null, fanart: null }));
    }

    try {
      const apiKey = this.fanartApiKey;
      const response = await cached(`fanart:${artistMbId}`, () =>
        this.axios
          .get<{
            artistthumb?: { url: string }[];
            artistbackground?: { url: string }[];
            hdmusiclogo?: { url: string }[];
          }>(`${FANART_API_URL}/${artistMbId}`, {
            params: { api_key: apiKey },
            timeout: 5000,
          })
          .then((r) => ({ data: r.data }))
      );

      return {
        poster: response.data.artistthumb?.[0]?.url ?? null,
        fanart: response.data.artistbackground?.[0]?.url ?? null,
      };
    } catch {
      return { poster: null, fanart: null };
    }
  }

  public async getArtistBio(artistMbId: string): Promise<string | null> {
    if (!this.lastfmApiKey) {
      return null;
    }

    try {
      const apiKey = this.lastfmApiKey;
      const response = await cached(`lastfm-bio:${artistMbId}`, () =>
        this.axios
          .get<{
            artist?: {
              bio?: { content?: string; summary?: string };
            };
          }>(LASTFM_API_URL, {
            params: {
              method: 'artist.getinfo',
              mbid: artistMbId,
              api_key: apiKey,
              format: 'json',
            },
            timeout: 5000,
          })
          .then((r) => ({ data: r.data }))
      );

      const raw =
        response.data.artist?.bio?.content ??
        response.data.artist?.bio?.summary ??
        '';
      // Strip the "Read more on Last.fm" trailing link block, then strip any
      // remaining HTML tags so the bio renders safely as plain text.
      const cleaned = raw
        .replace(/<a[^>]*>Read more on Last\.fm[^<]*<\/a>\.?\s*$/i, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      return cleaned || null;
    } catch {
      return null;
    }
  }

  public async getRelease(
    releaseId: string,
    albumMbId?: string
  ): Promise<MusicReleaseDetail | null> {
    const fallback = () =>
      lidarrMetadata.getRelease(releaseId, albumMbId).catch(() => null);
    if (Date.now() < musicBrainzUnavailableUntil) {
      return fallback();
    }
    try {
      const data = await this.rateLimitedRequest<MusicBrainzRelease>(
        `/release/${releaseId}`,
        {
          inc: 'recordings+media',
        }
      );

      const tracks = (data.media ?? [])
        .flatMap((medium) =>
          (medium.tracks ?? []).map((t) => ({
            id: t.id,
            number: t.number,
            title: t.title ?? t.recording?.title ?? '',
            length: t.length ?? t.recording?.length ?? null,
            position: t.position,
          }))
        )
        .sort((a, b) => a.position - b.position);

      const trackCount = (data.media ?? []).reduce(
        (sum, m) => sum + (m['track-count'] ?? m.trackCount ?? 0),
        0
      );

      return {
        id: data.id,
        title: data.title,
        status: data.status ?? '',
        date: data.date ?? '',
        country: data.country ?? '',
        format: data.media?.[0]?.format ?? '',
        trackCount,
        tracks,
      };
    } catch (e) {
      logger.error('Failed to get release from MusicBrainz', {
        label: 'MusicBrainz',
        errorMessage: e.message,
        releaseId,
      });
      return isUnavailableError(e) ? fallback() : null;
    }
  }

  private normaliseArtist(artist: MusicBrainzArtist): MusicArtistResult {
    const genres = (artist.genres ?? [])
      .sort((a, b) => b.count - a.count)
      .map((g) => g.name);

    const tags = (artist.tags ?? [])
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((t) => t.name);

    const links = (artist.relations ?? [])
      .filter((r) => r.url?.resource)
      .map((r) => ({
        url: r.url!.resource,
        name: r.type,
      }));

    return {
      id: artist.id,
      score: artist.score,
      name: artist.name,
      sortName: artist['sort-name'] ?? artist.sortName ?? artist.name,
      disambiguation: artist.disambiguation ?? '',
      type: artist.type ?? 'Unknown',
      country: artist.country ?? '',
      genres,
      tags,
      overview: '', // MusicBrainz doesn't have bios, would need last.fm or similar
      beginYear: artist['life-span']?.begin ?? artist.lifeSpan?.begin ?? '',
      endYear: artist['life-span']?.end ?? artist.lifeSpan?.end ?? null,
      ended: artist['life-span']?.ended ?? artist.lifeSpan?.ended ?? false,
      posterUrl: null, // Populated separately via fanart.tv
      fanartUrl: null,
      links,
    };
  }

  private normaliseReleaseGroup(rg: MusicBrainzReleaseGroup): MusicAlbumResult {
    const artistCredit = rg['artist-credit'] ?? rg.artistCredit ?? [];
    const artistName = artistCredit
      .map(
        (ac: MusicBrainzArtistCredit) =>
          `${ac.artist.name}${ac.joinphrase ?? ''}`
      )
      .join('');
    const artistId = artistCredit[0]?.artist?.id ?? '';

    const genres = (rg.genres ?? [])
      .sort((a, b) => b.count - a.count)
      .map((g) => g.name);

    const tags = (rg.tags ?? [])
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((t) => t.name);

    const releases = (rg.releases ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status ?? '',
      date: r.date ?? '',
      country: r.country ?? '',
      trackCount:
        r.media?.reduce(
          (sum, m) => sum + (m['track-count'] ?? m.trackCount ?? 0),
          0
        ) ?? 0,
      format: r.media?.[0]?.format ?? '',
    }));

    return {
      id: rg.id,
      score: rg.score,
      title: rg.title,
      primaryType: rg['primary-type'] ?? rg.primaryType ?? '',
      secondaryTypes: rg['secondary-types'] ?? rg.secondaryTypes ?? [],
      firstReleaseDate: rg['first-release-date'] ?? rg.firstReleaseDate ?? '',
      disambiguation: rg.disambiguation ?? '',
      artistName,
      artistId,
      genres,
      tags,
      overview: '', // MusicBrainz doesn't have album descriptions
      posterUrl: null, // Populated separately via Cover Art Archive
      releases,
    };
  }
}

export default MusicBrainz;
