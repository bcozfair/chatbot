import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from './jwt.js';


export interface AdminRequest extends Request {
  admin?: {
    id: number;
    username: string;
    name: string;
    role: string;
  };
}

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Unauthorized: Token format is Bearer <token>' });
  }

  const token = parts[1];

  jwt.verify(token, getJwtSecret(), (err, decoded) => {
    if (err) {
      return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
    }

    // Attach decoded token payload to req.admin
    (req as any).admin = decoded;
    next();
  });
}
