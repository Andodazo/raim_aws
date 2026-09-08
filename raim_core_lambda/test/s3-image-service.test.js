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

function createFakeS3({ contentType = 'image/png', contentLength = 8, header } = {}) {
  const commands = [];
  return {
    commands,
    client: {
      async send(command) {
        commands.push(command);
        if (command instanceof HeadObjectCommand) {
          return { ContentType: contentType, ContentLength: contentLength };
        }
        assert.ok(command instanceof GetObjectCommand);
        return { Body: header || Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) };
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

test('resolveImages enforces the total size using S3 ContentLength', async () => {
  const fake = createFakeS3({ contentLength: 7 * 1024 * 1024 });
  const resolveImages = createS3ImageResolver({
    client: fake.client,
    env: ENV,
  });

  await assert.rejects(
    () => resolveImages({
      sub: 'user-1',
      requestId: 'request-1',
      images: [
        {
          key: 'temporary/users/user-1/request-1/one.png',
          contentType: 'image/png',
          sizeBytes: 1,
        },
        {
          key: 'temporary/users/user-1/request-1/two.png',
          contentType: 'image/png',
          sizeBytes: 1,
        },
      ],
    }),
    (error) => error instanceof S3ImageError && /Total image size exceeds limit/.test(error.message)
  );
});
