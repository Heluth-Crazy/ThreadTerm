import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import matter from 'gray-matter';

const homedir = os.homedir();

const SKILL_ROOT_DEFINITIONS = [
  {
    id: 'claude',
    label: 'Claude',
    provider: 'claude',
    path: path.join(homedir, '.claude', 'skills'),
  },
  {
    id: 'claude-switch',
    label: 'Claude Switch',
    provider: 'claude',
    path: path.join(homedir, '.cc-switch', 'skills'),
  },
  {
    id: 'codex',
    label: 'Codex',
    provider: 'codex',
    path: path.join(homedir, '.codex', 'skills'),
  },
];

function encodeSkillId(skillPath) {
  return Buffer.from(skillPath, 'utf8').toString('base64url');
}

function decodeSkillId(skillId) {
  return Buffer.from(skillId, 'base64url').toString('utf8');
}

function isWithinRoot(targetPath, rootPath) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(rootPath);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function slugifySkillName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildSkillTemplate({ slug, displayName }) {
  const name = slug || 'my-skill';
  const title = displayName || name;

  return `---
name: ${name}
description: "Short description of what this skill helps with"
---

# ${title}

## Overview

Describe what this skill does and when it should be used.

## Workflow

1. Explain the context to inspect
2. Describe the main steps to take
3. State the expected output or verification
`;
}

async function parseSkillDirectory(root, skillDirectoryPath) {
  const skillFilePath = path.join(skillDirectoryPath, 'SKILL.md');
  const raw = await fs.readFile(skillFilePath, 'utf8');
  const { data, content } = matter(raw);
  const stats = await fs.stat(skillFilePath);

  return {
    id: encodeSkillId(skillDirectoryPath),
    name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : path.basename(skillDirectoryPath),
    slug: path.basename(skillDirectoryPath),
    description:
      typeof data.description === 'string' && data.description.trim()
        ? data.description.trim()
        : content.trim().split('\n')[0]?.replace(/^#+\s*/, '').trim() || '',
    provider: root.provider,
    rootId: root.id,
    rootLabel: root.label,
    rootPath: root.path,
    path: skillDirectoryPath,
    filePath: skillFilePath,
    updatedAt: stats.mtime.toISOString(),
    writable: true,
    content: raw,
    frontmatter: data,
  };
}

async function resolveSkillById(skillId) {
  const decodedPath = decodeSkillId(skillId);
  const roots = await getSkillRoots();
  const matchedRoot = roots.find((root) => isWithinRoot(decodedPath, root.path));

  if (!matchedRoot) {
    const error = new Error('Skill not found');
    error.code = 'ENOENT';
    throw error;
  }

  const skillFilePath = path.join(decodedPath, 'SKILL.md');
  if (!(await pathExists(skillFilePath))) {
    const error = new Error('Skill file not found');
    error.code = 'ENOENT';
    throw error;
  }

  return { root: matchedRoot, skillDirectoryPath: decodedPath, skillFilePath };
}

export async function getSkillRoots() {
  const roots = await Promise.all(
    SKILL_ROOT_DEFINITIONS.map(async (root) => ({
      ...root,
      exists: await pathExists(root.path),
      writable: true,
    })),
  );

  return roots;
}

export async function listSkills() {
  const roots = await getSkillRoots();
  const collected = [];

  for (const root of roots) {
    if (!root.exists) {
      continue;
    }

    let entries = [];
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true });
    } catch (error) {
      console.error(`Error reading skills root ${root.path}:`, error.message);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDirectoryPath = path.join(root.path, entry.name);
      const skillFilePath = path.join(skillDirectoryPath, 'SKILL.md');
      if (!(await pathExists(skillFilePath))) {
        continue;
      }

      try {
        const skill = await parseSkillDirectory(root, skillDirectoryPath);
        collected.push(skill);
      } catch (error) {
        console.error(`Error parsing skill ${skillDirectoryPath}:`, error.message);
      }
    }
  }

  collected.sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    if (providerCompare !== 0) {
      return providerCompare;
    }
    const rootCompare = left.rootLabel.localeCompare(right.rootLabel);
    if (rootCompare !== 0) {
      return rootCompare;
    }
    return left.name.localeCompare(right.name);
  });

  return {
    roots,
    skills: collected.map(({ content, frontmatter, ...skill }) => skill),
  };
}

export async function readSkill(skillId) {
  const { root, skillDirectoryPath } = await resolveSkillById(skillId);
  return parseSkillDirectory(root, skillDirectoryPath);
}

export async function createSkill({ rootId, slug, content }) {
  const roots = await getSkillRoots();
  const root = roots.find((entry) => entry.id === rootId);
  if (!root) {
    const error = new Error('Invalid skill root');
    error.code = 'EINVAL';
    throw error;
  }

  const safeSlug = slugifySkillName(slug);
  if (!safeSlug) {
    const error = new Error('Skill slug is required');
    error.code = 'EINVAL';
    throw error;
  }

  await fs.mkdir(root.path, { recursive: true });
  const skillDirectoryPath = path.join(root.path, safeSlug);
  const skillFilePath = path.join(skillDirectoryPath, 'SKILL.md');

  if (await pathExists(skillDirectoryPath)) {
    const error = new Error('Skill already exists');
    error.code = 'EEXIST';
    throw error;
  }

  await fs.mkdir(skillDirectoryPath, { recursive: true });
  const finalContent = String(content || '').trim()
    ? String(content)
    : buildSkillTemplate({ slug: safeSlug, displayName: safeSlug });
  await fs.writeFile(skillFilePath, finalContent, 'utf8');

  return readSkill(encodeSkillId(skillDirectoryPath));
}

export async function updateSkill(skillId, { content }) {
  const { skillFilePath } = await resolveSkillById(skillId);
  const finalContent = String(content || '');

  if (!finalContent.trim()) {
    const error = new Error('Skill content is required');
    error.code = 'EINVAL';
    throw error;
  }

  await fs.writeFile(skillFilePath, finalContent, 'utf8');
  return readSkill(skillId);
}

export async function deleteSkill(skillId) {
  const { skillDirectoryPath } = await resolveSkillById(skillId);
  await fs.rm(skillDirectoryPath, { recursive: true, force: false });
  return { success: true };
}
