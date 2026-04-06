import express from 'express';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Check auth status - SIMPLIFIED: always returns authenticated, no setup needed
router.get('/status', async (req, res) => {
  try {
    res.json({
      needsSetup: false,
      isAuthenticated: true
    });
  } catch (error) {
    logger.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration - SIMPLIFIED: always returns success, no actual registration needed
router.post('/register', async (req, res) => {
  try {
    const { username } = req.body;

    // Return success without creating user
    res.json({
      success: true,
      user: { id: 1, username: username || 'anonymous' },
      token: 'no-auth-required'
    });
  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login - SIMPLIFIED: always returns success, no actual authentication needed
router.post('/login', async (req, res) => {
  try {
    const { username } = req.body;

    // Return success without validating credentials
    res.json({
      success: true,
      user: { id: 1, username: username || 'anonymous' },
      token: 'no-auth-required'
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user - SIMPLIFIED: always returns anonymous user
router.get('/user', (req, res) => {
  res.json({
    user: { id: 1, username: 'anonymous' }
  });
});

// Logout - SIMPLIFIED: always returns success
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;