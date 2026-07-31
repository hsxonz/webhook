const crypto = require('crypto');

/**
 * Tạo key 32 bytes từ passphrase (dùng scrypt)
 */
function deriveKey(passphrase, salt = 'fixed-app-salt') {
  return crypto.scryptSync(passphrase, salt, 32); // 32 bytes = AES-256
}

/**
 * MÃ HOÁ (AES-256-GCM)
 * Trả về token an toàn để lưu trữ/truyền đi (base64url), gồm IV + ciphertext + authTag
 */
function encrypt(text, passphrase) {
  const key = deriveKey(passphrase);
  const iv = crypto.randomBytes(12); // GCM nên dùng 12 bytes IV
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const ciphertext = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Ghép iv.ciphertext.tag và encode base64url
  const token = Buffer.concat([iv, ciphertext, tag]).toString('base64url');
  return token;
}

/**
 * GIẢI MÃ (AES-256-GCM)
 * Nhận token base64url ở trên, tách IV/ciphertext/tag rồi giải mã
 */
function decrypt(token, passphrase) {
  const raw = Buffer.from(token, 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(raw.length - 16); // GCM tag 16 bytes
  const ciphertext = raw.subarray(12, raw.length - 16);

  const key = deriveKey(passphrase);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// --- Ví dụ dùng ---
const pass = 'hsxonz_timedealer';

const token = encrypt('false_120363042226308538@g.us_3A53C6FC8ED48B9B2F10_85261906581@c.us', pass);
console.log('Encrypted token:', token);

const original = decrypt(token, pass);
console.log('Decrypted:', original);
