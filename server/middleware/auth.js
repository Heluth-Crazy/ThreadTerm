import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { userDb } from '../database/db.js';
import { IS_PLATFORM } from '../constants/config.js';

// Require JWT secret from environment — never use a hardcoded default
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.warn('[SECURITY] JWT_SECRET not set. Generating a random secret for this session. Set JWT_SECRET in .env for persistent tokens.');
}
const EFFECTIVE_JWT_SECRET = JWT_SECRET || crypto.randomBytes(64).toString('hex');

const JWT_ALGORITHM = 'HS256';
const JWT_EXPIRY = '7d';

// Optional API key middleware
const validateApiKey = (req, res, next) => {
  if (!process.env.API_KEY) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
};

// JWT authentication middleware - SIMPLIFIED: always allows access
const authenticateToken = async (req, res, next) => {
  // Try to get user from token if provided (for backward compatibility)
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  if (!token && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    try {
      const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
      const user = userDb.getUserById(decoded.userId);
      if (user) {
        req.user = user;
        return next();
      }
    } catch (error) {
      // Token invalid but we don't care - continue as anonymous
    }
  }

  // No valid token - create anonymous user context
  // Try to get first user from database for reference
  try {
    const firstUser = userDb.getFirstUser();
    if (firstUser) {
      req.user = firstUser;
    } else {
      // No users in database - use anonymous placeholder
      req.user = { id: 0, username: 'anonymous' };
    }
  } catch (error) {
    req.user = { id: 0, username: 'anonymous' };
  }

  next();
};

// Generate JWT token with expiration
const generateToken = (user) => {
  return jwt.sign(
    { userId: user.id, username: user.username },
    EFFECTIVE_JWT_SECRET,
    { algorithm: JWT_ALGORITHM, expiresIn: JWT_EXPIRY }
  );
};

// WebSocket authentication function - SIMPLIFIED: always allows access
const authenticateWebSocket = (token) => {
  // Try to validate token if provided (for backward compatibility)
  if (token) {
    try {
      const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET, { algorithms: [JWT_ALGORITHM] });
      return decoded;
    } catch (error) {
      // Token invalid but we don't care - continue as anonymous
    }
  }

  // Return anonymous user context
  try {
    const firstUser = userDb.getFirstUser();
    if (firstUser) {
      return { userId: firstUser.id, username: firstUser.username };
    }
  } catch (error) {
    // Ignore errors
  }

  // Fallback to anonymous
  return { userId: 0, username: 'anonymous' };
};

export {
  validateApiKey,
  authenticateToken,
  generateToken,
  authenticateWebSocket,
  EFFECTIVE_JWT_SECRET as JWT_SECRET
};
