import dotenv from 'dotenv';

dotenv.config();

let _jwtSecret: string | null = null;

export function getJwtSecret(): string {
  if (_jwtSecret) {
    return _jwtSecret;
  }

  const secret = process.env.JWT_SECRET;

  // ไม่มี fallback secret ในทุก NODE_ENV — secret ที่เขียนไว้ในโค้ดแปลว่าใครก็ปลอม token แอดมินได้
  if (!secret) {
    throw new Error('[JWT] FATAL: JWT_SECRET environment variable is not set. Server cannot start.');
  }

  _jwtSecret = secret;
  return secret;
}
