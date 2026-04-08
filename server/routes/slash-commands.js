import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const router = express.Router();

const OPENWORK_CONFIG_DIR = path.join(os.homedir(), '.openwork');
const COMMANDS_FILE = path.join(OPENWORK_CONFIG_DIR, 'custom-slash-commands.json');

async function loadCommands() {
  try {
    const raw = await fs.readFile(COMMANDS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveCommands(commands) {
  await fs.mkdir(OPENWORK_CONFIG_DIR, { recursive: true });
  await fs.writeFile(COMMANDS_FILE, JSON.stringify(commands, null, 2), 'utf8');
}

function validateCommand(body, existingCommands, excludeId) {
  const errors = [];
  const { name, description, prompt, provider } = body;

  if (!name || typeof name !== 'string') {
    errors.push('name is required');
  } else {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
      errors.push('name must start with a letter and contain only letters, numbers, hyphens, underscores');
    }
    const duplicate = existingCommands.find(
      (c) => c.name.toLowerCase() === name.toLowerCase() && c.id !== excludeId
    );
    if (duplicate) {
      errors.push(`name "${name}" is already in use`);
    }
  }

  if (!prompt || typeof prompt !== 'string') {
    errors.push('prompt is required');
  }

  if (provider && !['claude', 'codex', 'cursor', 'all'].includes(provider)) {
    errors.push('provider must be one of: claude, codex, cursor, all');
  }

  return errors;
}

// GET /api/slash-commands
router.get('/', async (_req, res) => {
  try {
    const commands = await loadCommands();
    res.json(commands);
  } catch (error) {
    logger.error('Error loading custom slash commands:', error);
    res.status(500).json({ error: 'Failed to load custom slash commands' });
  }
});

// POST /api/slash-commands
router.post('/', async (req, res) => {
  try {
    const commands = await loadCommands();
    const errors = validateCommand(req.body, commands);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const newCommand = {
      id: crypto.randomUUID(),
      name: req.body.name.trim(),
      description: (req.body.description || '').trim(),
      prompt: req.body.prompt.trim(),
      provider: req.body.provider || 'all',
    };

    commands.push(newCommand);
    await saveCommands(commands);
    res.status(201).json(newCommand);
  } catch (error) {
    logger.error('Error creating custom slash command:', error);
    res.status(500).json({ error: 'Failed to create custom slash command' });
  }
});

// PUT /api/slash-commands/:id
router.put('/:id', async (req, res) => {
  try {
    const commands = await loadCommands();
    const index = commands.findIndex((c) => c.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Command not found' });
    }

    const errors = validateCommand(req.body, commands, req.params.id);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    commands[index] = {
      ...commands[index],
      name: req.body.name.trim(),
      description: (req.body.description || '').trim(),
      prompt: req.body.prompt.trim(),
      provider: req.body.provider || 'all',
    };

    await saveCommands(commands);
    res.json(commands[index]);
  } catch (error) {
    logger.error('Error updating custom slash command:', error);
    res.status(500).json({ error: 'Failed to update custom slash command' });
  }
});

// DELETE /api/slash-commands/:id
router.delete('/:id', async (req, res) => {
  try {
    const commands = await loadCommands();
    const index = commands.findIndex((c) => c.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Command not found' });
    }

    commands.splice(index, 1);
    await saveCommands(commands);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting custom slash command:', error);
    res.status(500).json({ error: 'Failed to delete custom slash command' });
  }
});

export default router;
