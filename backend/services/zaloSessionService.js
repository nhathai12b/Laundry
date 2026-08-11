import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { queryOne, execute } from '../database/db.js';
import { formatDateTimeUTC } from '../utils/helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_QR_ROOT = path.resolve(__dirname, '..', 'storage', 'zalo');

const sessions = new Map();

const getQrRoot = () => process.env.ZALO_QR_STORAGE_DIR || DEFAULT_QR_ROOT;

const getQrPath = (storeId) => path.join(getQrRoot(), `store-${storeId}`, 'zalo-login-qr.png');

async function loadZca() {
  return import('zca-js');
}

function parseCredentials(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.imei || !parsed.userAgent || !parsed.cookie) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function upsertAccount(storeId, fields) {
  const existing = await queryOne('SELECT id FROM store_zalo_accounts WHERE store_id = ?', [storeId]);
  if (!existing) {
    await execute(`
      INSERT INTO store_zalo_accounts (store_id, status, qr_path)
      VALUES (?, 'not_logged_in', ?)
    `, [storeId, getQrPath(storeId)]);
  }

  const updates = [];
  const values = [];
  Object.entries(fields).forEach(([key, value]) => {
    updates.push(`${key} = ?`);
    values.push(value);
  });

  if (updates.length > 0) {
    values.push(storeId);
    await execute(`UPDATE store_zalo_accounts SET ${updates.join(', ')} WHERE store_id = ?`, values);
  }
}

async function saveLoggedInAccount(storeId, api, credentials) {
  let accountInfo = null;
  try {
    accountInfo = await api.fetchAccountInfo();
  } catch (error) {
    console.warn('Could not fetch Zalo account info:', error.message);
  }

  const ownId = api.getOwnId?.() || accountInfo?.profile?.userId || null;
  const zaloName =
    accountInfo?.profile?.displayName ||
    accountInfo?.profile?.zaloName ||
    accountInfo?.profile?.username ||
    `Zalo ${ownId || ''}`.trim();

  await upsertAccount(storeId, {
    zalo_user_id: ownId,
    zalo_name: zaloName || null,
    credentials_json: JSON.stringify(credentials),
    status: 'logged_in',
    last_login_at: formatDateTimeUTC(),
    last_error: null,
    qr_path: getQrPath(storeId),
  });

  return { zaloUserId: ownId, zaloName };
}

async function getAccount(storeId) {
  return queryOne('SELECT * FROM store_zalo_accounts WHERE store_id = ?', [storeId]);
}

async function createApiFromCredentials(storeId, credentials) {
  const { Zalo } = await loadZca();
  const zalo = new Zalo({ logging: false, selfListen: false, checkUpdate: false });
  const api = await zalo.login(credentials);
  const profile = await saveLoggedInAccount(storeId, api, credentials);
  sessions.set(storeId, { zalo, api, ready: true, loginPromise: null, profile });
  return api;
}

export async function ensureZaloAccountRow(storeId) {
  await upsertAccount(storeId, { qr_path: getQrPath(storeId) });
  return getAccount(storeId);
}

export async function getZaloStatus(storeId) {
  await ensureZaloAccountRow(storeId);
  const account = await getAccount(storeId);
  const session = sessions.get(storeId);

  return {
    status: session?.ready ? 'logged_in' : account?.status || 'not_logged_in',
    zaloName: account?.zalo_name || session?.profile?.zaloName || null,
    zaloUserId: account?.zalo_user_id || session?.profile?.zaloUserId || null,
    lastLoginAt: account?.last_login_at || null,
    lastError: account?.last_error || null,
  };
}

export async function startZaloQrLogin(storeId) {
  await ensureZaloAccountRow(storeId);
  const current = sessions.get(storeId);
  if (current?.loginPromise) {
    return getZaloStatus(storeId);
  }

  const qrPath = getQrPath(storeId);
  await fs.mkdir(path.dirname(qrPath), { recursive: true });

  const { Zalo, LoginQRCallbackEventType } = await loadZca();
  const zalo = new Zalo({ logging: false, selfListen: false, checkUpdate: false });

  await upsertAccount(storeId, {
    status: 'pending_qr',
    qr_path: qrPath,
    last_error: null,
  });

  const loginPromise = zalo.loginQR({ qrPath }, async (event) => {
    try {
      if (event.type === LoginQRCallbackEventType.QRCodeGenerated) {
        await event.actions?.saveToFile(qrPath);
      }

      if (event.type === LoginQRCallbackEventType.QRCodeDeclined) {
        await upsertAccount(storeId, {
          status: 'error',
          last_error: 'QR login was declined on the device',
        });
      }

      if (event.type === LoginQRCallbackEventType.QRCodeExpired) {
        await upsertAccount(storeId, {
          status: 'expired',
          last_error: 'QR code expired',
        });
      }

      if (event.type === LoginQRCallbackEventType.GotLoginInfo) {
        await upsertAccount(storeId, {
          credentials_json: JSON.stringify({
            imei: event.data.imei,
            userAgent: event.data.userAgent,
            cookie: event.data.cookie,
          }),
        });
      }
    } catch (error) {
      console.warn('Zalo QR event handling failed:', error.message);
    }
  })
    .then(async (api) => {
      const account = await getAccount(storeId);
      const credentials = parseCredentials(account?.credentials_json);
      if (credentials) {
        const profile = await saveLoggedInAccount(storeId, api, credentials);
        sessions.set(storeId, { zalo, api, ready: true, loginPromise: null, profile });
      } else {
        sessions.set(storeId, { zalo, api, ready: true, loginPromise: null, profile: null });
        await upsertAccount(storeId, { status: 'logged_in', last_login_at: formatDateTimeUTC(), last_error: null });
      }
      return api;
    })
    .catch(async (error) => {
      sessions.delete(storeId);
      await upsertAccount(storeId, {
        status: 'error',
        last_error: error.message,
      });
      console.warn('Zalo QR login failed:', error.message);
      throw error;
    });

  sessions.set(storeId, { zalo, api: null, ready: false, loginPromise, profile: null });
  return getZaloStatus(storeId);
}

export async function getZaloQrDataUrl(storeId) {
  await ensureZaloAccountRow(storeId);
  const qrPath = getQrPath(storeId);
  const data = await fs.readFile(qrPath);
  return `data:image/png;base64,${data.toString('base64')}`;
}

export async function logoutZalo(storeId) {
  sessions.delete(storeId);
  await upsertAccount(storeId, {
    zalo_user_id: null,
    zalo_name: null,
    credentials_json: null,
    status: 'not_logged_in',
    last_error: null,
    last_login_at: null,
  });
}

export async function getReadyZaloApi(storeId) {
  const session = sessions.get(storeId);
  if (session?.ready && session.api) {
    return session.api;
  }

  const account = await getAccount(storeId);
  const credentials = parseCredentials(account?.credentials_json);
  if (!credentials) {
    throw new Error('Store is not logged in to Zalo');
  }

  try {
    return await createApiFromCredentials(storeId, credentials);
  } catch (error) {
    sessions.delete(storeId);
    await upsertAccount(storeId, {
      status: 'expired',
      last_error: error.message,
    });
    throw new Error('Zalo session has expired, please log in again');
  }
}
