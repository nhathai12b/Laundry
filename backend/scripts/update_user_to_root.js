import dotenv from 'dotenv';
import { execute, queryOne } from '../database/db.js';

dotenv.config();

// Script to update a user to root admin by phone
async function updateUserToRoot() {
  try {
    const phone = process.argv[2] || 'admin123';
    
    console.log(`Checking user with phone: ${phone}...`);
    
    // Check if user exists
    const user = await queryOne('SELECT id, name, phone, role FROM users WHERE phone = ?', [phone]);
    
    if (!user) {
      console.error(`❌ User with phone "${phone}" not found!`);
      process.exit(1);
    }
    
    console.log('Current user info:');
    console.log(`  ID: ${user.id}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Phone: ${user.phone}`);
    console.log(`  Current Role: ${user.role}`);
    
    if (user.role === 'root') {
      console.log('✅ User is already root admin!');
      process.exit(0);
    }
    
    // Update to root
    await execute('UPDATE users SET role = ? WHERE id = ?', ['root', user.id]);
    
    console.log('✅ User updated to root admin!');
    console.log(`  Phone: ${user.phone}`);
    console.log(`  New Role: root`);
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating user to root:', error);
    process.exit(1);
  }
}

updateUserToRoot();
