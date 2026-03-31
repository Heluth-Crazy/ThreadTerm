import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectCli, detectAllClis, getCliDiscoveryStatus, clearCliCache } = require('../utils/cli-discovery.cjs');

const router = express.Router();

/**
 * GET /api/cli/discovery
 * Get discovery status for all CLIs
 */
router.get('/discovery', (req, res) => {
  try {
    const status = getCliDiscoveryStatus();
    res.json(status);
  } catch (error) {
    console.error('Error in CLI discovery:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cli/discovery/:cliName
 * Get discovery status for a specific CLI
 */
router.get('/discovery/:cliName', (req, res) => {
  try {
    const { cliName } = req.params;
    const { refresh } = req.query;

    // Validate CLI name
    const validClis = ['claude', 'codex'];
    if (!validClis.includes(cliName)) {
      return res.status(400).json({
        success: false,
        error: `Invalid CLI name. Must be one of: ${validClis.join(', ')}`
      });
    }

    const result = detectCli(cliName, { skipCache: refresh === 'true' });
    res.json({
      success: true,
      cli: result
    });
  } catch (error) {
    console.error(`Error detecting CLI ${req.params.cliName}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/cli/discovery/refresh
 * Force refresh of all CLI detection (clear cache and re-detect)
 */
router.post('/discovery/refresh', (req, res) => {
  try {
    clearCliCache();
    const status = getCliDiscoveryStatus();
    res.json({
      success: true,
      refreshed: true,
      ...status
    });
  } catch (error) {
    console.error('Error refreshing CLI discovery:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/cli/paths
 * Get the detected paths for all CLIs (convenience endpoint)
 */
router.get('/paths', (req, res) => {
  try {
    const detections = detectAllClis();

    // Return simplified path mapping
    const paths = {};
    for (const [name, detection] of Object.entries(detections)) {
      paths[name] = detection.found ? detection.path : null;
    }

    res.json({
      success: true,
      paths,
      details: detections
    });
  } catch (error) {
    console.error('Error getting CLI paths:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
