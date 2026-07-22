import { execute } from '../database/db.js';

export const auditLog = (action, entity, getEntityId) => {
  return (req, res, next) => {
    const originalSend = res.json;

    res.json = function(data) {
      // Send the response immediately; log in the background afterward so
      // the audit write never delays the response or becomes an unhandled
      // promise rejection.
      const result = originalSend.call(this, data);

      if (req.user && res.statusCode < 400) {
        const entityId = getEntityId ? getEntityId(req, data) : (req.params.id || data?.id);
        const beforeData = req.body?.before_data ? JSON.stringify(req.body.before_data) : null;
        const afterData = data?.data ? JSON.stringify(data.data) : null;

        execute(`
          INSERT INTO audit_logs (user_id, action, entity, entity_id, before_data, after_data)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [
          req.user.id,
          action,
          entity,
          entityId,
          beforeData,
          afterData
        ]).catch((error) => {
          console.error('Audit log error:', error);
        });
      }

      return result;
    };

    next();
  };
};

