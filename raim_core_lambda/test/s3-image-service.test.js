'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const {
  S3ImageError,
  createS3Client,
  createS3ImageResolver,
  detectImageContentType,
} = require('../lib/s3-image-service');

const ENV = {
  IMAGE_BUCKET_NAME: 'raim-images-dev-123456789012',
  IMAGE_BUCKET_REGION: 'us-east-1',
  IMAGE_MAX_COUNT: '10',
  IMAGE_MAX_TOTAL_BYTES: '10485760',
  IMAGE_MAX_BYTES: '5242880',
  IMAGE_ALLOWED_CONTENT_TYPES: 'image/jpeg,image/png,image/webp,image/gif',
};

test('S3 client uses the image bucket region instead of Lambda region', async () => {
  const client = createS3Client({
    env: {
      IMAGE_BUCKET_REGION: 'us-east-1',
      AWS_REGION: 'ap-northeast-1',
    },
  });

  assert.equal(await client.config.region(), 'us-east-1');
});

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 先頭が PNG の署名で、長さが [size] の本体を作る。 */
function pngBody(size) {
  const body = Buffer.alloc(size);
  PNG_SIGNATURE.copy(body, 0, 0, Math.min(size, PNG_SIGNATURE.length));
  return body;
}

function createFakeS3({
  contentType = 'image/png',
  contentLength = 8,
  header,
  etag = '"etag-1"',
  getError,
} = {}) {
  const commands = [];
  return {
    commands,
    client: {
      async send(command) {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return { ContentType: contentType, ContentLength: contentLength, ETag: etag };
        }
        assert.ok(command instanceof GetObjectCommand);
        if (getError) throw getError;
        return { Body: header || pngBody(contentLength) };
      },
    },
  };
}

test('detectImageContentType recognizes the supported image signatures', () => {
  assert.equal(detectImageContentType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(
    detectImageContentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    'image/png'
  );
  assert.equal(detectImageContentType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(detectImageContentType(Buffer.from('RIFFxxxxWEBP')), 'image/webp');
});

test('resolveImages validates the S3 object and returns a Mantle-compatible data URL', async () => {
  const fake = createFakeS3();
  const resolveImages = createS3ImageResolver({
    client: fake.client,
    env: ENV,
  });

  const result = await resolveImages({
    sub: 'user-1',
    requestId: 'request-1',
    images: [{
      key: 'temporary/users/user-1/request-1/image.png',
      contentType: 'image/png',
      sizeBytes: 999999,
    }],
  });

  assert.deepEqual(result, [{
    key: 'temporary/users/user-1/request-1/image.png',
    contentType: 'image/png',
    sizeBytes: 8,
    s3Uri: 's3://raim-images-dev-123456789012/temporary/users/user-1/request-1/image.png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }]);
  assert.equal(fake.commands.length, 2);
  assert.equal(fake.commands[1].input.Range, undefined);
  // HeadObject で見た版だけを読む
  assert.equal(fake.commands[1].input.IfMatch, '"etag-1"');
});

test('resolveImages rejects a key outside the authenticated user request prefix', async () => {
  const fake = createFakeS3();
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/other-user/request-1/image.png',
        contentType: 'image/png',
        sizeBytes: 8,
      }],
    }),
    (error) => error instanceof S3ImageError && /outside the user request prefix/.test(error.message)
  );
});

test('resolveImages rejects mismatched client, S3, and detected content types', async () => {
  const fake = createFakeS3({ contentType: 'image/jpeg', header: Buffer.from([0xff, 0xd8, 0xff]) });
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/user-1/request-1/image.png',
        contentType: 'image/png',
        sizeBytes: 8,
      }],
    }),
    (error) => error instanceof S3ImageError && /content type does not match/.test(error.message)
  );
});

test('resolveImages rejects an oversized image before downloading it', async () => {
  const fake = createFakeS3({ contentLength: 5 * 1024 * 1024 + 1 });
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/user-1/request-1/big.png',
        contentType: 'image/png',
        sizeBytes: 1,
      }],
    }),
    (error) => error instanceof S3ImageError && /Image size exceeds limit/.test(error.message)
  );
  // HeadObject だけで止まり、GetObject は呼ばれない
  assert.equal(fake.commands.length, 1);
  assert.ok(fake.commands[0] instanceof HeadObjectCommand);
});

test('resolveImages stops before downloading the image that exceeds the total', async () => {
  const fake = createFakeS3({ contentLength: 4 * 1024 * 1024 });
  const resolveImages = createS3ImageResolver({
    client: fake.client,
    env: { ...ENV, IMAGE_MAX_TOTAL_BYTES: String(6 * 1024 * 1024) },
  });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [
        { key: 'temporary/users/user-1/request-1/one.png', contentType: 'image/png', sizeBytes: 1 },
        { key: 'temporary/users/user-1/request-1/two.png', contentType: 'image/png', sizeBytes: 1 },
      ],
    }),
    (error) => error instanceof S3ImageError && /Total image size exceeds limit/.test(error.message)
  );
  // 1枚目: Head + Get、2枚目: Head のみ
  assert.equal(fake.commands.length, 3);
  assert.ok(fake.commands[2] instanceof HeadObjectCommand);
});

test('resolveImages rejects an S3 Content-Type mismatch before downloading', async () => {
  const fake = createFakeS3({ contentType: 'image/jpeg' });
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/user-1/request-1/image.png',
        contentType: 'image/png',
        sizeBytes: 8,
      }],
    }),
    (error) => error instanceof S3ImageError && /content type does not match/.test(error.message)
  );
  assert.equal(fake.commands.length, 1);
});

test('resolveImages rejects an object that was replaced between Head and Get', async () => {
  const replaced = Object.assign(new Error('precondition'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });
  const fake = createFakeS3({ getError: replaced });
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/user-1/request-1/image.png',
        contentType: 'image/png',
        sizeBytes: 8,
      }],
    }),
    (error) =>
      error instanceof S3ImageError &&
      /changed while reading/.test(error.message) &&
      error.retriable === false
  );
});

test('resolveImages rejects a body whose length differs from HeadObject', async () => {
  const fake = createFakeS3({ contentLength: 16, header: pngBody(8) });
  const resolveImages = createS3ImageResolver({ client: fake.client, env: ENV });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [{
        key: 'temporary/users/user-1/request-1/image.png',
        contentType: 'image/png',
        sizeBytes: 16,
      }],
    }),
    (error) => error instanceof S3ImageError && /changed while reading/.test(error.message)
  );
});
