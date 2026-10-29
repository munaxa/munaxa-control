import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

import { AsymmetricSigner, fromBase64Url, toBase64Url, type Signer } from '@munaxa/crypto';

import type { Environment } from '../config/environment';

/** Injection token for the licence signer (ADR-0003, ADR-0008). */
export const LICENCE_SIGNER = Symbol('LicenceSigner');

/**
 * The one key licences and revocation lists are signed with.
 *
 * `@munaxa/licensing` signs through a synchronous `Signer`, and a key held in AWS KMS can only sign
 * asynchronously. So the contract here is "build this document with the signer I give you": a
 * local key passes its signer straight through; a KMS key runs the build twice, once to learn the
 * exact bytes to sign and once to place the signature KMS returned (ADR-0008). Either way the
 * document is produced by the shared contract, never by a copy of its encoding.
 */
export interface LicenceSigner {
  readonly kid: string;
  readonly algorithm: 'ES256' | 'RS256';
  /** SPKI PEM of the signing key, published at `GET /api/v1/licensing/public-keys`. */
  readonly publicKey: string;
  /** Runs `build` with a signer whose signature this key supplies, and returns what it built. */
  sign(build: (signer: Signer) => string): Promise<string>;
  /** Signs a probe and verifies it with `publicKey`. Startup refuses a key that fails it. */
  selfTest(): Promise<void>;
}

/** The private key in this process, from the mounted file (ADR-0003). */
export class FileLicenceSigner implements LicenceSigner {
  readonly publicKey: string;
  readonly #signer: AsymmetricSigner;

  constructor(
    readonly kid: string,
    readonly algorithm: 'ES256' | 'RS256',
    privateKey: string,
  ) {
    this.publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
    this.#signer = new AsymmetricSigner(algorithm, [
      { kid, privateKey, publicKey: this.publicKey },
    ]);
  }

  sign(build: (signer: Signer) => string): Promise<string> {
    return Promise.resolve(build(this.#signer));
  }

  selfTest(): Promise<void> {
    const probe = `munaxa-control licence signer self-test ${Date.now()}`;
    if (!this.#signer.verify(probe, this.#signer.sign(probe))) {
      return Promise.reject(
        new Error('The licence signing key does not verify its own signature.'),
      );
    }
    return Promise.resolve();
  }
}

/**
 * The slice of the AWS KMS API this signer uses: `Sign` over a SHA-256 digest. Production adapts
 * `@aws-sdk/client-kms`; tests supply a local key that answers the way KMS does (DER signatures).
 */
export interface KmsSignApi {
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

/** Ends the first signing pass once the bytes to sign are known. Never escapes `sign`. */
class Captured extends Error {}

/**
 * A P-256 key that never leaves AWS KMS (ADR-0008). The process holds only the key's ARN and its
 * public half, and its task role may call `kms:Sign` on that one key.
 */
export class KmsLicenceSigner implements LicenceSigner {
  readonly algorithm = 'ES256' as const;

  constructor(
    readonly kid: string,
    readonly keyId: string,
    readonly publicKey: string,
    private readonly kms: KmsSignApi,
  ) {}

  async sign(build: (signer: Signer) => string): Promise<string> {
    // First pass: the contract canonicalises and encodes the document, then asks for a signature;
    // the bytes it asks to sign are captured and the pass is abandoned.
    let message: Buffer | undefined;
    const capture: Signer = {
      algorithm: this.algorithm,
      kid: this.kid,
      sign: (payload) => {
        message = toBytes(payload);
        throw new Captured();
      },
      verify: () => false,
    };
    try {
      build(capture);
    } catch (error) {
      if (!(error instanceof Captured)) throw error;
    }
    if (message === undefined) throw new Error('The document asked for no signature.');

    const value = toBase64Url(await this.signRaw(message));

    // Second pass: the same build, given the signature. Canonical JSON gives the same bytes, and a
    // build that asks to sign anything else is refused rather than given a signature for it.
    const signed = message;
    const replay: Signer = {
      algorithm: this.algorithm,
      kid: this.kid,
      sign: (payload) => {
        if (!toBytes(payload).equals(signed)) {
          throw new Error('The document changed between signing passes; nothing was issued.');
        }
        return { kid: this.kid, algorithm: this.algorithm, value };
      },
      verify: (payload, signature) => this.verify(toBytes(payload), signature.value),
    };
    return build(replay);
  }

  async selfTest(): Promise<void> {
    const probe = Buffer.from(`munaxa-control licence signer self-test ${Date.now()}`, 'utf8');
    const signature = await this.signRaw(probe);
    if (!this.verify(probe, toBase64Url(signature))) {
      throw new Error(
        'LICENCE_SIGNING_PUBLIC_KEY does not verify a signature from LICENCE_SIGNING_KMS_KEY_ID.',
      );
    }
  }

  /** KMS signs the SHA-256 digest (no 4 KB message limit) and answers in DER; JWS wants r‖s. */
  private async signRaw(message: Buffer): Promise<Buffer> {
    const digest = createHash('sha256').update(message).digest();
    const der = await this.kms.signDigest(this.keyId, digest);
    const signature = derToP1363(Buffer.from(der), 32);
    // Never hand out a signature this key's published half would not accept.
    if (!this.verify(message, toBase64Url(signature))) {
      throw new Error('KMS returned a signature the published public key does not verify.');
    }
    return signature;
  }

  private verify(message: Buffer, value: string): boolean {
    return verifySignature(
      'sha256',
      message,
      { key: this.publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(fromBase64Url(value)),
    );
  }
}

function toBytes(payload: string | Uint8Array): Buffer {
  return typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
}

/** An ECDSA signature `SEQUENCE { INTEGER r, INTEGER s }` as the fixed-width `r‖s` JWS uses. */
export function derToP1363(der: Buffer, size: number): Buffer {
  let offset = 0;
  const read = (tag: number): Buffer => {
    if (der[offset] !== tag) throw new Error('Malformed ECDSA signature.');
    offset += 1;
    let length = der[offset] ?? 0;
    offset += 1;
    if (length & 0x80) {
      const bytes = length & 0x7f;
      if (bytes < 1 || bytes > 2) throw new Error('Malformed ECDSA signature.');
      length = 0;
      for (let i = 0; i < bytes; i += 1) length = (length << 8) | (der[offset + i] ?? 0);
      offset += bytes;
    }
    const value = der.subarray(offset, offset + length);
    if (value.length !== length) throw new Error('Malformed ECDSA signature.');
    offset += length;
    return value;
  };
  const sequence = read(0x30);
  if (offset !== der.length) throw new Error('Malformed ECDSA signature.');
  offset = der.length - sequence.length;
  const integer = (): Buffer => {
    let value = read(0x02);
    while (value.length > 1 && value[0] === 0) value = value.subarray(1);
    if (value.length > size) throw new Error('Malformed ECDSA signature.');
    return Buffer.concat([Buffer.alloc(size - value.length), value]);
  };
  const r = integer();
  const s = integer();
  if (offset !== der.length) throw new Error('Malformed ECDSA signature.');
  return Buffer.concat([r, s]);
}

/** `@aws-sdk/client-kms`, loaded only when the KMS backend is configured. */
export async function awsKmsSignApi(region: string): Promise<KmsSignApi> {
  const { KMSClient, SignCommand } = await import('@aws-sdk/client-kms');
  const client = new KMSClient({ region });
  return {
    async signDigest(keyId, digest) {
      const answer = await client.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );
      if (answer.Signature === undefined) throw new Error('KMS returned no signature.');
      return answer.Signature;
    },
  };
}

/** The signer the environment names. */
export async function licenceSignerFor(environment: Environment): Promise<LicenceSigner> {
  if (environment.LICENCE_SIGNING_BACKEND === 'KMS') {
    const keyId = environment.LICENCE_SIGNING_KMS_KEY_ID as string;
    return new KmsLicenceSigner(
      environment.LICENCE_SIGNING_KID,
      keyId,
      environment.LICENCE_SIGNING_PUBLIC_KEY as string,
      await awsKmsSignApi(keyId.split(':')[3] as string),
    );
  }
  return new FileLicenceSigner(
    environment.LICENCE_SIGNING_KID,
    environment.LICENCE_SIGNING_ALGORITHM,
    environment.licencePrivateKey as string,
  );
}
