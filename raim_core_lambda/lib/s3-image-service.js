'use strict';

// ============================================================================
// S3 image validation and Mantle image input generation
// ============================================================================

const {
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} = require('@aws-sdk/client-s3');
const {
  ERROR_CODES,
  getImageConstraints,
} = require('./types');

const TEMPORARY_PREFIX = 'temporary/users/';

const EXTENSION_CONTENT_TYPES = Object.freeze({
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
});

class S3ImageError extends Error {
  constructor(message, { code = ERROR_CODES.INVALID_INPUT, retriable = false, details } = {}) {
    super(message);
    this.name = 'S3ImageError';
    this.code = code;
    this.retriable = retriable;
    this.details = details;
  }
}

function normalizeContentType(value) {
  return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function getObjectExtension(key) {
  const match = /\.([a-z0-9]+)$/i.exec(key);
  return match ? match[1].toLowerCase() : '';
}

function detectImageContentType(header) {
  if (!Buffer.isBuffer(header)) {
    return '';
  }

  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }

  if (header.length >= 6 && header.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return 'image/gif';
  }

  if (
    header.length >= 12 &&
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  return '';
}

async function readBodyToBuffer(body) {
  if (!body) {
    return Buffer.alloc(0);
  }

  if (Buffer.isBuffer(body)) {
    return body;
  }

  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }

  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }

  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function assertSafeKeySegment(value, label) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('..') ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes('://')
  ) {
    throw new S3ImageError(`${label} is invalid`);
  }
}

function validateKeyShape(key, { sub, requestId }) {
  if (
    !key ||
    key.startsWith('/') ||
    key.includes('\\') ||
    key.includes('..') ||
    /[\u0000-\u001f\u007f]/.test(key) ||
    key.includes('://') ||
    key.includes('?') ||
    key.includes('#')
  ) {
    throw new S3ImageError('S3 image key is invalid');
  }

  const expectedPrefix = `${TEMPORARY_PREFIX}${sub}/${requestId}/`;
  if (!key.startsWith(expectedPrefix)) {
    throw new S3ImageError('S3 image key is outside the user request prefix');
  }

  const fileName = key.slice(expectedPrefix.length);
  if (!fileName || fileName.includes('/')) {
    throw new S3ImageError('S3 image key must contain one image file');
  }

  return fileName;
}

function createS3Client({ client, env = process.env } = {}) {
  return client || new S3Client({
    // Lambdaの実行リージョンと画像バケットのリージョンは異なる場合がある。
    // 画像バケットをus-east-1へ配置する場合は、IMAGE_BUCKET_REGIONを優先する。
    region: env.IMAGE_BUCKET_REGION || env.AWS_REGION || 'ap-northeast-1',
  });
}

function getBucketName(env = process.env) {
  const bucket = String(env.IMAGE_BUCKET_NAME || '').trim();
  if (!bucket) {
    throw new S3ImageError(
      'IMAGE_BUCKET_NAME is not configured',
      { code: ERROR_CODES.INTERNAL_ERROR, retriable: false }
    );
  }
  return bucket;
}

function s3Failure(error) {
  const statusCode = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
  const notFound = statusCode === 404 || error?.name === 'NotFound' || error?.name === 'NoSuchKey';

  return new S3ImageError(
    notFound ? 'S3 image object was not found' : 'S3 image object could not be inspected',
    {
      code: notFound ? ERROR_CODES.INVALID_INPUT : ERROR_CODES.INTERNAL_ERROR,
      retriable: !notFound,
      details: { statusCode, name: error?.name },
    }
  );
}

function createS3ImageResolver({ client, env = process.env } = {}) {
  const s3 = createS3Client({ client, env });

  return async function resolveImages({ images = [], sub, requestId }) {
    if (!Array.isArray(images) || images.length === 0) {
      return [];
    }

    assertSafeKeySegment(sub, 'sub');
    assertSafeKeySegment(requestId, 'requestId');

    const bucket = getBucketName(env);
    const constraints = getImageConstraints(env);
    const seenKeys = new Set();
    let totalBytes = 0;
    const resolved = [];

    for (const image of images) {
      const key = image.key.trim();
      const requestedContentType = normalizeContentType(image.contentType);
      const fileName = validateKeyShape(key, { sub, requestId });
      const extensionType = EXTENSION_CONTENT_TYPES[getObjectExtension(fileName)];

      if (!extensionType || !constraints.allowedContentTypes.includes(extensionType)) {
        throw new S3ImageError('S3 image extension is not supported');
      }

      if (seenKeys.has(key)) {
        throw new S3ImageError('Duplicate S3 image key');
      }
      seenKeys.add(key);

      let head;
      let header;
      try {
        head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        const response = await s3.send(new GetObjectCommand({
          Bucket: bucket,
          Key: key,
        }));
        header = await readBodyToBuffer(response.Body);
      } catch (error) {
        throw s3Failure(error);
      }

      const actualSize = Number(head.ContentLength);
      const s3ContentType = normalizeContentType(head.ContentType);
      const detectedContentType = detectImageContentType(header);

      if (!Number.isSafeInteger(actualSize) || actualSize <= 0) {
        throw new S3ImageError('S3 image object has an invalid size');
      }

      if (!detectedContentType || !constraints.allowedContentTypes.includes(detectedContentType)) {
        throw new S3ImageError('S3 image format is not supported');
      }

      if (
        requestedContentType !== detectedContentType ||
        s3ContentType !== detectedContentType ||
        extensionType !== detectedContentType
      ) {
        throw new S3ImageError('S3 image content type does not match its data');
      }

      totalBytes += actualSize;
      if (totalBytes > constraints.maxTotalBytes) {
        throw new S3ImageError(
          `Total image size exceeds limit (${constraints.maxTotalBytes} bytes)`
        );
      }

      resolved.push({
        key,
        contentType: detectedContentType,
        sizeBytes: actualSize,
        // 非公開S3オブジェクトをMantle側から直接取得させず、
        // CoreのIAM権限で取得した内容をdata URLとして渡す。
        // s3Uriは監査・デバッグ用に保持する。
        s3Uri: `s3://${bucket}/${key}`,
        dataUrl: `data:${detectedContentType};base64,${header.toString('base64')}`,
      });
    }

    return resolved;
  };
}

const resolveS3Images = createS3ImageResolver();

module.exports = {
  EXTENSION_CONTENT_TYPES,
  S3ImageError,
  TEMPORARY_PREFIX,
  createS3ImageResolver,
  createS3Client,
  detectImageContentType,
  resolveS3Images,
};
