import {
  analyzeUpload,
  createUpload,
  deleteUpload,
  getUpload,
  listUploads,
  saveFile,
  searchForUpload,
  startImport,
  uploadsConfigured,
} from '@server/lib/musicUploads';
import logger from '@server/logger';
import { Router } from 'express';

// Mounted admin-only. Uploads write straight into the Lidarr inbox.
const musicUploadRoutes = Router();

musicUploadRoutes.get('/', async (_req, res) => {
  return res.status(200).json({
    configured: uploadsConfigured(),
    uploads: await listUploads(),
  });
});

musicUploadRoutes.use((_req, res, next) => {
  if (!uploadsConfigured()) {
    return res.status(503).json({
      message:
        'Uploads are not set up. Set MUSIC_UPLOAD_DIR to a folder Lidarr can also see.',
    });
  }
  next();
});

musicUploadRoutes.post('/', async (req, res, next) => {
  try {
    const upload = await createUpload({
      id: req.user?.id ?? 0,
      displayName: req.user?.displayName ?? '',
    });
    return res.status(201).json(upload);
  } catch (e) {
    logger.error('Failed to create music upload', {
      label: 'Music Upload',
      errorMessage: e.message,
    });
    next({ status: 500, message: 'Could not start the upload.' });
  }
});

musicUploadRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  const upload = await getUpload(req.params.id).catch(() => null);
  if (!upload) {
    return next({ status: 404, message: 'Upload not found.' });
  }
  return res.status(200).json(upload);
});

// Raw file body, one request per file: ?path=CD1/01 - Song.flac
musicUploadRoutes.put<{ id: string }>('/:id/files', async (req, res, next) => {
  const upload = await getUpload(req.params.id).catch(() => null);
  if (!upload) {
    return next({ status: 404, message: 'Upload not found.' });
  }
  try {
    const updated = await saveFile(
      upload,
      String(req.query.path ?? ''),
      req,
      Number(req.headers['content-length'] ?? 0)
    );
    return res.status(200).json({ files: updated.files.length });
  } catch (e) {
    logger.warn('Rejected an uploaded file', {
      label: 'Music Upload',
      uploadId: upload.id,
      path: req.query.path,
      errorMessage: e.message,
    });
    next({ status: 400, message: e.message });
  }
});

musicUploadRoutes.post<{ id: string }>(
  '/:id/analyze',
  async (req, res, next) => {
    try {
      return res.status(200).json(await analyzeUpload(req.params.id));
    } catch (e) {
      logger.error('Failed to analyze music upload', {
        label: 'Music Upload',
        uploadId: req.params.id,
        errorMessage: e.message,
      });
      next({ status: 500, message: e.message });
    }
  }
);

musicUploadRoutes.post<{ id: string }, unknown, { query?: string }>(
  '/:id/search',
  async (req, res, next) => {
    const query = req.body.query?.trim();
    if (!query) {
      return next({ status: 400, message: 'Enter an album to search for.' });
    }
    try {
      return res.status(200).json(await searchForUpload(req.params.id, query));
    } catch (e) {
      next({ status: 500, message: e.message });
    }
  }
);

musicUploadRoutes.post<{ id: string }, unknown, { albumId?: string }>(
  '/:id/import',
  async (req, res, next) => {
    try {
      return res
        .status(202)
        .json(await startImport(req.params.id, req.body.albumId ?? ''));
    } catch (e) {
      next({ status: 400, message: e.message });
    }
  }
);

musicUploadRoutes.delete<{ id: string }>('/:id', async (req, res, next) => {
  try {
    await deleteUpload(req.params.id);
    return res.status(204).send();
  } catch (e) {
    next({ status: 400, message: e.message });
  }
});

export default musicUploadRoutes;
