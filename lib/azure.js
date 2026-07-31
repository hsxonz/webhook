import { BlobServiceClient } from '@azure/storage-blob';
import crypto from 'node:crypto';
import config from '../config.js';
import log from './logger.js';

const { blobUrl, sasToken, container, frontDoorUrl, extension } = config.azure;

const containerClient = new BlobServiceClient(`${blobUrl}?${sasToken}`)
  .getContainerClient(container);

const hashBase64 = (base64) =>
  crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');

// Tên file = hash nội dung nên ảnh trùng chỉ upload 1 lần
export const uploadImage = async (imageBase64) => {
  try {
    const fileName = `${hashBase64(imageBase64)}.${extension}`;
    const url = `${frontDoorUrl}/${container}/${fileName}`;
    const blob = containerClient.getBlockBlobClient(fileName);

    if (await blob.exists()) return url;

    const buffer = Buffer.from(imageBase64, 'base64');
    await blob.upload(buffer, buffer.length, {
      blobHTTPHeaders: { blobContentType: `image/${extension}` },
    });
    return url;
  } catch (err) {
    log.error('Upload ảnh lên Azure thất bại:', err.message);
    throw err;
  }
};
