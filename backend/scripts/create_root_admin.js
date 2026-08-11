import dotenv from 'dotenv';
import { execute, queryOne } from '../database/db.js';
import { hashPassword } from '../utils/helpers.js';

dotenv.config();

// Script to create root admin user
async function createRootAdmin() {
  try {
    console.log('Creating root admin user...');
    
    // Check if root admin already exists
    const existingRoot = await queryOne('SELECT id, name, phone FROM users WHERE role = ?', ['root']);
    
    if (existingRoot) {
      console.log('Root admin already exists:');
      console.log(`  ID: ${existingRoot.id}`);
      console.log(`  Name: ${existingRoot.name}`);
      console.log(`  Phone: ${existingRoot.phone}`);
      process.exit(0);
    }

    // Check if admin user exists, convert it to root
    const existingAdmin = await queryOne('SELECT id, name, phone FROM users WHERE phone = ?', ['admin']);
    
    if (existingAdmin) {
      console.log('Found existing admin user, converting to root...');
      await execute('UPDATE users SET role = ? WHERE id = ?', ['root', existingAdmin.id]);
      console.log('✅ Admin user converted to root admin!');

      process.exit(0);
    }

    // Create new root admin user
    const password_hash = await hashPassword('admin123');
    
    const result = await execute(`
      INSERT INTO users (name, phone, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?)
    `, ['Root Admin', 'admin', password_hash, 'root', 'active']);

    console.log('✅ Root admin user created successfully!');
    console.log('Phone: admin');
    // Password removed from logs for security
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating root admin:', error);
    process.exit(1);
  }
}

createRootAdmin();
