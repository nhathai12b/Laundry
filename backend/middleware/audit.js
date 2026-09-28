import { execute } from '../database/db.js';

export const auditLog = (action, entity, getEntityId) => {
  return async (req, res, next) => {
    const originalSend = res.json;
    
    res.json = function(data) {
      // Fire-and-forget: KHÔNG await INSERT audit trước khi gửi response —
      // bảng audit_logs chậm/khóa sẽ treo mọi mutation, và res.json trả về
      // Promise thay vì res làm hỏng chaining
      if (req.user && res.statusCode < 400) {
        try {
          const entityId = getEntityId ? getEntityId(req, data) : (req.params.id || data.id);
          const beforeData = req.body.before_data ? JSON.stringify(req.body.before_data) : null;
          const afterData = data.data ? JSON.stringify(data.data) : null;

          execute(`
            INSERT INTO audit_logs (user_id, employee_id, action, entity, entity_id, before_data, after_data)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [
            req.user.id,
            req.user.employee_login ? (req.user.employee_id || null) : null,
            action,
            entity,
            entityId,
            beforeData,
            afterData
          ]).catch((error) => console.error('Audit log error:', error.message));
        } catch (error) {
          console.error('Audit log error:', error);
        }
      }

      return originalSend.call(this, data);
    };

    next();
  };
};

