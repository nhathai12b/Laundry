#!/bin/bash

echo "Starting Quan ly cua hang..."
echo ""
echo "Starting Backend..."
cd backend
npm install
npm run init-db
npm run dev &
BACKEND_PID=$!

sleep 3

echo ""
echo "Starting Frontend..."
cd ../frontend
npm install
npm run dev &
FRONTEND_PID=$!

echo ""
echo "Both servers are starting..."
echo "Backend: http://localhost:5000"
echo "Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both servers"

wait

