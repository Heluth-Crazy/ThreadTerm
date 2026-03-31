import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import TOML from '@iarna/toml';
import { getCodexSessions, getCodexSessionMessages, deleteCodexSession } from '../projects.js';

const router = express.Router();
const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');

async function readCodexConfigFile() {
  try {
    const content = await fs.readFile(codexConfigPath, 'utf8');
    return TOML.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function writeCodexConfigFile(config) {
  await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
  await fs.writeFile(codexConfigPath, TOML.stringify(config), 'utf8');
}

function mapCodexMcpServers(config) {
  return Object.entries(config.mcp_servers || {}).map(([name, serverConfig]) => ({
    id: name,
    name,
    type: serverConfig.url ? 'http' : 'stdio',
    scope: 'user',
    config: {
      command: serverConfig.command,
      args: serverConfig.args || [],
      url: serverConfig.url,
      env: serverConfig.env || {},
    },
  }));
}

router.get('/config', async (req, res) => {
  try {
    const config = await readCodexConfigFile();

    res.json({
      success: true,
      config: {
        model: config.model || null,
        mcpServers: config.mcp_servers || {},
        approvalMode: config.approval_mode || 'suggest',
      },
    });
  } catch (error) {
    console.error('Error reading Codex config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/mcp', async (req, res) => {
  try {
    const config = await readCodexConfigFile();
    res.json({
      success: true,
      path: codexConfigPath,
      servers: mapCodexMcpServers(config),
    });
  } catch (error) {
    console.error('Error reading Codex MCP config:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.post('/mcp', async (req, res) => {
  try {
    const {
      name,
      type = 'stdio',
      command = '',
      args = [],
      url = '',
      env = {},
    } = req.body || {};

    if (!name) {
      return res.status(400).json({ success: false, error: 'name is required' });
    }

    const config = await readCodexConfigFile();
    config.mcp_servers = config.mcp_servers || {};

    config.mcp_servers[name] = type === 'stdio'
      ? {
          command,
          args: Array.isArray(args) ? args : [],
          env: env && typeof env === 'object' ? env : {},
        }
      : {
          url,
        };

    await writeCodexConfigFile(config);

    res.json({ success: true, message: `Codex MCP server "${name}" saved successfully` });
  } catch (error) {
    console.error('Error saving Codex MCP server:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/mcp/:name', async (req, res) => {
  try {
    const { name } = req.params;
    const config = await readCodexConfigFile();
    config.mcp_servers = config.mcp_servers || {};

    delete config.mcp_servers[name];
    await writeCodexConfigFile(config);

    res.json({ success: true, message: `Codex MCP server "${name}" removed successfully` });
  } catch (error) {
    console.error('Error deleting Codex MCP server:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const { projectPath } = req.query;

    if (!projectPath) {
      return res.status(400).json({ success: false, error: 'projectPath query parameter required' });
    }

    const sessions = await getCodexSessions(projectPath);
    res.json({ success: true, sessions });
  } catch (error) {
    console.error('Error fetching Codex sessions:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/sessions/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { limit, offset } = req.query;

    const result = await getCodexSessionMessages(
      sessionId,
      limit ? parseInt(limit, 10) : null,
      offset ? parseInt(offset, 10) : 0,
    );

    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error fetching Codex session messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

router.delete('/sessions/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    await deleteCodexSession(sessionId);
    res.json({ success: true });
  } catch (error) {
    console.error(`Error deleting Codex session ${req.params.sessionId}:`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
