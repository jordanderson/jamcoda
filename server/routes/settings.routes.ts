import express from 'express';
import { route } from '@utils/route';
import { JAMCORDER_URL } from '../services/jamcorder.service';
import { libraryDir } from '@config/library';

const router = express.Router();

router.get('/', route('get settings', async (_req, res) => {
  res.json({ jamcorderUrl: JAMCORDER_URL, libraryDir: libraryDir() });
}));

export default router;
