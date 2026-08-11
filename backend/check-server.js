/**
 * Script to check if backend server can start properly
 * Run: node check-server.js
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';

dotenv.config();

async function checkServer() {
  console.log('🔍 Checking backend server configuration...\n');

  // Check environment variables
  console.log('📋 Environment Variables:');
  console.log(`   MYSQL_HOST: ${process.env.MYSQL_HOST || 'localhost (default)'}`);
  console.log(`   MYSQL_PORT: ${process.env.MYSQL_PORT || '3306 (default)'}`);
  console.log(`   MYSQL_USER: ${process.env.MYSQL_USER || 'root (default)'}`);
  console.log(`   MYSQL_DATABASE: ${process.env.MYSQL_DATABASE || 'laundry66 (default)'}`);
  console.log(`   PORT: ${process.env.PORT || '5000 (default)'}`);
  console.log(`   JWT_SECRET: ${process.env.JWT_SECRET ? '✅ Set' : '❌ Not set'}\n`);

  // Check MySQL connection
  console.log('🔌 Testing MySQL connection...');
  try {
    const connection = await mysql.createConnection({
      host: process.env.MYSQL_HOST || 'localhost',
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'laundry66'
    });

    await connection.ping();
    console.log('   ✅ MySQL connection successful!\n');
    await connection.end();
  } catch (error) {
    console.log('   ❌ MySQL connection failed!');
    console.log(`   Error: ${error.message}\n`);
    console.log('💡 Solutions:');
    console.log('   1. Make sure MySQL is running');
    console.log('   2. Check MySQL credentials in .env file');
    console.log('   3. Create database if it doesn\'t exist');
    console.log('   4. Check MySQL service: sudo systemctl status mysql (Linux) or Services (Windows)\n');
    process.exit(1);
  }

  // Check if port is available
  console.log('🔌 Checking if port is available...');
  const PORT = process.env.PORT || 5000;
  try {
    const net = await import('net');
    const server = net.createServer();
    
    await new Promise((resolve, reject) => {
      server.listen(PORT, () => {
        server.close(() => resolve());
      });
      server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.log(`   ⚠️  Port ${PORT} is already in use!`);
          console.log('   💡 Another process might be using this port');
          console.log('   💡 Try: netstat -ano | findstr :5000 (Windows) or lsof -i :5000 (Linux/Mac)\n');
          reject(err);
        } else {
          reject(err);
        }
      });
    });
    console.log(`   ✅ Port ${PORT} is available!\n`);
  } catch (error) {
    if (error.code !== 'EADDRINUSE') {
      console.log(`   ⚠️  Could not check port: ${error.message}\n`);
    }
  }

  console.log('✅ All checks passed! You can start the server with: npm start\n');
}

checkServer().catch(console.error);
