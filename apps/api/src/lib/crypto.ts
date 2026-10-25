import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM encryption for secrets at rest (SMTP passwords, SSO client secrets, backup credentials). */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appSecret: string) {
    this.key = createHash('sha256').update(`hrs-secretbox:${appSecret}`).digest();
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')}`;
  }

  decrypt(sealed: string): string {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown secret format');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}
