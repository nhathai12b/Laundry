import { execute } from '../database/db.js';

export const auditLog = (action, entity, getEntityId) => {
  return async (req, res, next) => {
    const originalSend = res.json;
    
    res.json = async function(data) {
      // Log after response is sent
      if (req.user && res.statusCode < 400) {
        try {
          const entityId = getEntityId ? getEntityId(req, data) : (req.params.id || data.id);
          const beforeData = req.body.before_data ? JSON.stringify(req.body.before_data) : null;
          const afterData = data.data ? JSON.stringify(data.data) : null;

          await execute(`
            INSERT INTO audit_logs (user_id, action, entity, entity_id, before_data, after_data)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            req.user.id,
            action,
            entity,
            entityId,
            beforeData,
            afterData
          ]);
        } catch (error) {
          console.error('Audit log error:', error);
        }
      }
      
      return originalSend.call(this, data);
    };

    next();
  };
};

