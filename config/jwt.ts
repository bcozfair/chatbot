import dotenv from 'dotenv';

dotenv.config();

let _jwtSecret: string | null = null;

export function getJwtSecret(): string {
  if (_jwtSecret) {
    return _jwtSecret;
  }

  const secret = process.env.JWT_SECRET;

  if (!secret) {
    const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
    if (isDev) {
      console.warn('[JWT] WARNING: JWT_SECRET not set. Using insecure fallback for development.');
      _jwtSecret = 'dev-only-insecure-change-me';
      return _jwtSecret;
    }
    throw new Error('[JWT] FATAL: JWT_SECRET environment variable is not set. Server cannot start.');
  }

  _jwtSecret = secret;
  return secret;
}
