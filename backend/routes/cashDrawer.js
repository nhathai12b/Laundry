import express from 'express';
import { authenticate } from '../middleware/auth.js';
import {
  getCurrentDrawer,
  getDrawerDetails,
  recordCashIn,
  recordCashOut,
} from '../services/cashDrawerService.js';

const router = express.Router();

router.use(authenticate);

function parseTimesheetId(value) {
  const id = Number.parseInt(value, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get('/current', async (req, res) => {
  try {
    if (req.user.role === 'admin') {
      return res.json({ data: null });
    }

    const drawer = await getCurrentDrawer(req.user);
    res.json({ data: drawer });
  } catch (error) {
    console.error('Get current cash drawer error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

router.get('/timesheets/:timesheetId', async (req, res) => {
  try {
    const timesheetId = parseTimesheetId(req.params.timesheetId);
    if (!timesheetId) {
      return res.status(400).json({ error: 'Invalid timesheet id' });
    }

    const drawer = await getDrawerDetails(timesheetId, req.user, false);
    res.json({ data: drawer });
  } catch (error) {
    console.error('Get cash drawer details error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

router.post('/cash-in', async (req, res) => {
  try {
    const timesheetId = parseTimesheetId(req.body.timesheet_id);
    if (!timesheetId) {
      return res.status(400).json({ error: 'Invalid timesheet id' });
    }

    const result = await recordCashIn(timesheetId, req.body, req.user);
    res.status(201).json({ data: result });
  } catch (error) {
    console.error('Cash drawer cash in error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

router.post('/cash-out', async (req, res) => {
  try {
    const timesheetId = parseTimesheetId(req.body.timesheet_id);
    if (!timesheetId) {
      return res.status(400).json({ error: 'Invalid timesheet id' });
    }

    const result = await recordCashOut(timesheetId, req.body, req.user);
    res.status(201).json({ data: result });
  } catch (error) {
    console.error('Cash drawer cash out error:', error);
    res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Lỗi máy chủ. Vui lòng thử lại.' });
  }
});

export default router;
