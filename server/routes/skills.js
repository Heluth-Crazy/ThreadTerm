import express from 'express';
import {
  createSkill,
  deleteSkill,
  listSkills,
  readSkill,
  updateSkill,
} from '../utils/skills.js';

const router = express.Router();

function respondError(res, error) {
  const status =
    error.code === 'ENOENT' ? 404 : error.code === 'EEXIST' ? 409 : error.code === 'EINVAL' ? 400 : 500;

  res.status(status).json({
    success: false,
    error: error.message || 'Skills request failed',
  });
}

router.get('/', async (req, res) => {
  try {
    const data = await listSkills();
    res.json({ success: true, ...data });
  } catch (error) {
    console.error('Error listing skills:', error);
    respondError(res, error);
  }
});

router.get('/:skillId', async (req, res) => {
  try {
    const skill = await readSkill(req.params.skillId);
    res.json({ success: true, skill });
  } catch (error) {
    console.error(`Error reading skill ${req.params.skillId}:`, error);
    respondError(res, error);
  }
});

router.post('/', async (req, res) => {
  try {
    const skill = await createSkill(req.body || {});
    res.status(201).json({ success: true, skill });
  } catch (error) {
    console.error('Error creating skill:', error);
    respondError(res, error);
  }
});

router.put('/:skillId', async (req, res) => {
  try {
    const skill = await updateSkill(req.params.skillId, req.body || {});
    res.json({ success: true, skill });
  } catch (error) {
    console.error(`Error updating skill ${req.params.skillId}:`, error);
    respondError(res, error);
  }
});

router.delete('/:skillId', async (req, res) => {
  try {
    const result = await deleteSkill(req.params.skillId);
    res.json(result);
  } catch (error) {
    console.error(`Error deleting skill ${req.params.skillId}:`, error);
    respondError(res, error);
  }
});

export default router;
