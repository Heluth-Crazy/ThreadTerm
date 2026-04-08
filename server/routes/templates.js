import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

const router = express.Router();

const OPENWORK_CONFIG_DIR = path.join(os.homedir(), '.openwork');
const TEMPLATES_FILE = path.join(OPENWORK_CONFIG_DIR, 'session-templates.json');

const BUILT_IN_TEMPLATES = [
  {
    id: 'builtin-code-review',
    name: 'Code Review',
    description: 'Review this code for bugs, performance issues, and best practices.',
    icon: '🔍',
    provider: 'claude',
    initialMessage: 'Please review the code in [filename] and provide detailed feedback.',
    isBuiltIn: true,
  },
  {
    id: 'builtin-bug-fix',
    name: 'Bug Fix',
    description: 'Diagnose and fix the bug described below.',
    icon: '🐛',
    provider: 'claude',
    initialMessage: 'I have a bug: [describe the bug]. Here\'s the relevant code: [paste code]',
    isBuiltIn: true,
  },
  {
    id: 'builtin-feature',
    name: 'Feature Implementation',
    description: 'Implement the following feature based on the requirements.',
    icon: '✨',
    provider: 'codex',
    initialMessage: 'Implement a feature that [describe feature]. Follow existing code patterns.',
    isBuiltIn: true,
  },
  {
    id: 'builtin-documentation',
    name: 'Documentation',
    description: 'Write comprehensive documentation for this code.',
    icon: '📝',
    provider: 'claude',
    initialMessage: 'Write documentation for [component/function/module].',
    isBuiltIn: true,
  },
  {
    id: 'builtin-refactoring',
    name: 'Refactoring',
    description: 'Refactor this code to improve readability and maintainability.',
    icon: '♻️',
    provider: 'claude',
    initialMessage: 'Refactor the following code to be cleaner and more maintainable: [paste code]',
    isBuiltIn: true,
  },
];

async function loadUserTemplates() {
  try {
    const raw = await fs.readFile(TEMPLATES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveUserTemplates(templates) {
  await fs.mkdir(OPENWORK_CONFIG_DIR, { recursive: true });
  await fs.writeFile(TEMPLATES_FILE, JSON.stringify(templates, null, 2), 'utf8');
}

function validateTemplate(body) {
  const errors = [];
  const { name, description, icon, provider } = body;

  if (!name || typeof name !== 'string' || !name.trim()) {
    errors.push('name is required');
  }
  if (!description || typeof description !== 'string' || !description.trim()) {
    errors.push('description is required');
  }
  if (!icon || typeof icon !== 'string' || !icon.trim()) {
    errors.push('icon is required');
  }
  if (!provider || !['claude', 'codex', 'cursor'].includes(provider)) {
    errors.push('provider must be one of: claude, codex, cursor');
  }

  return errors;
}

// GET /api/templates — returns built-in + user templates
router.get('/', async (_req, res) => {
  try {
    const userTemplates = await loadUserTemplates();
    res.json([...BUILT_IN_TEMPLATES, ...userTemplates]);
  } catch (error) {
    logger.error('Error loading templates:', error);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// POST /api/templates — create user template
router.post('/', async (req, res) => {
  try {
    const errors = validateTemplate(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    const newTemplate = {
      id: crypto.randomUUID(),
      name: req.body.name.trim(),
      description: req.body.description.trim(),
      icon: req.body.icon.trim(),
      provider: req.body.provider,
      systemPrompt: (req.body.systemPrompt || '').trim() || undefined,
      initialMessage: (req.body.initialMessage || '').trim() || undefined,
      isBuiltIn: false,
    };

    const templates = await loadUserTemplates();
    templates.push(newTemplate);
    await saveUserTemplates(templates);
    res.status(201).json(newTemplate);
  } catch (error) {
    logger.error('Error creating template:', error);
    res.status(500).json({ error: 'Failed to create template' });
  }
});

// PUT /api/templates/:id — update user template (not built-ins)
router.put('/:id', async (req, res) => {
  try {
    if (req.params.id.startsWith('builtin-')) {
      return res.status(403).json({ error: 'Cannot modify built-in templates' });
    }

    const templates = await loadUserTemplates();
    const index = templates.findIndex((t) => t.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const errors = validateTemplate(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ error: errors.join('; ') });
    }

    templates[index] = {
      ...templates[index],
      name: req.body.name.trim(),
      description: req.body.description.trim(),
      icon: req.body.icon.trim(),
      provider: req.body.provider,
      systemPrompt: (req.body.systemPrompt || '').trim() || undefined,
      initialMessage: (req.body.initialMessage || '').trim() || undefined,
    };

    await saveUserTemplates(templates);
    res.json(templates[index]);
  } catch (error) {
    logger.error('Error updating template:', error);
    res.status(500).json({ error: 'Failed to update template' });
  }
});

// DELETE /api/templates/:id — delete user template (not built-ins)
router.delete('/:id', async (req, res) => {
  try {
    if (req.params.id.startsWith('builtin-')) {
      return res.status(403).json({ error: 'Cannot delete built-in templates' });
    }

    const templates = await loadUserTemplates();
    const index = templates.findIndex((t) => t.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: 'Template not found' });
    }

    templates.splice(index, 1);
    await saveUserTemplates(templates);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting template:', error);
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

export default router;
